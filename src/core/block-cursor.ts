import type { PoolClient } from "pg";
import type { Hex } from "viem";
import { byteaToHex, hexToBytea } from "../db/bytea.js";
import { deleteRecentHashesAbove } from "./recent-hashes.js";

export interface BlockCursorRow {
    chainId: number;
    lastBlock: bigint;
    lastBlockHash: Hex;
}

export async function getCursor(
    client: PoolClient,
    chainId: number,
): Promise<BlockCursorRow | undefined> {
    const res = await client.query<{
        chain_id: number;
        last_block: string;
        last_block_hash: Buffer;
    }>(
        `SELECT chain_id, last_block, last_block_hash
           FROM block_cursor
          WHERE chain_id = $1`,
        [chainId],
    );
    const row = res.rows[0];
    if (!row) return undefined;
    return {
        chainId: row.chain_id,
        lastBlock: BigInt(row.last_block),
        lastBlockHash: byteaToHex(row.last_block_hash),
    };
}

export async function upsertCursor(
    client: PoolClient,
    cursor: BlockCursorRow,
): Promise<void> {
    await client.query(
        `INSERT INTO block_cursor (chain_id, last_block, last_block_hash, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (chain_id) DO UPDATE
           SET last_block = EXCLUDED.last_block,
               last_block_hash = EXCLUDED.last_block_hash,
               updated_at = now()`,
        [
            cursor.chainId,
            cursor.lastBlock.toString(),
            hexToBytea(cursor.lastBlockHash),
        ],
    );
}

export async function rewindTo(
    client: PoolClient,
    chainId: number,
    forkPointBlock: bigint,
    forkPointBlockHash: Hex,
): Promise<void> {
    // Delete every stamped row that was written beyond the fork point.
    // Any entity carrying applied_by_block_number participates in reorg eviction.
    const stampedTables = [
        "user_balance",
        "withdrawal_request",
        "cross_chain_deposit",
        "chain_liquidity",
    ];
    for (const table of stampedTables) {
        await client.query(
            `DELETE FROM ${table}
              WHERE applied_by_block_number IS NOT NULL
                AND applied_by_block_number > $1`,
            [forkPointBlock.toString()],
        );
    }
    // deposit_event is append-only keyed by (tx_hash, log_index) — evict by block_number directly.
    await client.query(
        `DELETE FROM deposit_event
          WHERE chain_id = $1 AND block_number > $2`,
        [chainId, forkPointBlock.toString()],
    );

    // Keep the recent-hashes buffer consistent with the rewound cursor.
    await deleteRecentHashesAbove(client, chainId, forkPointBlock);

    await upsertCursor(client, {
        chainId,
        lastBlock: forkPointBlock,
        lastBlockHash: forkPointBlockHash,
    });
}
