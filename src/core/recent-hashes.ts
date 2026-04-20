import type { PoolClient } from "pg";
import type { Hex } from "viem";
import { byteaToHex, hexToBytea } from "../db/bytea.js";

export interface RecentBlockHash {
    blockNumber: bigint;
    blockHash: Hex;
}

export async function recordBlockHash(
    client: PoolClient,
    chainId: number,
    blockNumber: bigint,
    blockHash: Hex,
): Promise<void> {
    await client.query(
        `INSERT INTO recent_block_hashes (chain_id, block_number, block_hash)
         VALUES ($1, $2, $3)
         ON CONFLICT (chain_id, block_number) DO UPDATE
           SET block_hash = EXCLUDED.block_hash,
               inserted_at = now()`,
        [chainId, blockNumber.toString(), hexToBytea(blockHash)],
    );
}

/** Returns up to `limit` rows, newest first (block_number DESC). */
export async function getRecentHashes(
    client: PoolClient,
    chainId: number,
    limit: number,
): Promise<RecentBlockHash[]> {
    const res = await client.query<{
        block_number: string;
        block_hash: Buffer;
    }>(
        `SELECT block_number, block_hash
           FROM recent_block_hashes
          WHERE chain_id = $1
       ORDER BY block_number DESC
          LIMIT $2`,
        [chainId, limit],
    );
    return res.rows.map((r) => ({
        blockNumber: BigInt(r.block_number),
        blockHash: byteaToHex(r.block_hash),
    }));
}

/** Delete rows with block_number <= threshold. Used to bound table size. */
export async function pruneRecentHashes(
    client: PoolClient,
    chainId: number,
    olderThanOrEqual: bigint,
): Promise<void> {
    if (olderThanOrEqual < 0n) return;
    await client.query(
        `DELETE FROM recent_block_hashes
          WHERE chain_id = $1 AND block_number <= $2`,
        [chainId, olderThanOrEqual.toString()],
    );
}

/** Delete rows above the fork point. Called from rewindTo. */
export async function deleteRecentHashesAbove(
    client: PoolClient,
    chainId: number,
    forkPointBlock: bigint,
): Promise<void> {
    await client.query(
        `DELETE FROM recent_block_hashes
          WHERE chain_id = $1 AND block_number > $2`,
        [chainId, forkPointBlock.toString()],
    );
}
