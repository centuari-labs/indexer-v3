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

/**
 * Delete rows with block_number <= threshold to bound table size, while NEVER
 * shrinking the retained window below `finalityDepth` blocks back from the head
 * (M1).
 *
 * The reorg detector needs at least `finalityDepth + 1` recent hashes to locate
 * a fork point; pruning too aggressively (e.g. a large prune cutoff relative to
 * the current head) would empty the buffer and spuriously wedge the chain on the
 * next divergence. We clamp the effective cutoff so at least the last
 * `finalityDepth` hashes below `headBlock` are always kept.
 */
export async function pruneRecentHashes(
    client: PoolClient,
    chainId: number,
    olderThanOrEqual: bigint,
    headBlock: bigint,
    finalityDepth: number,
): Promise<void> {
    // Never prune anything within finalityDepth of the head.
    const protectedFloor = headBlock - BigInt(finalityDepth);
    let cutoff = olderThanOrEqual;
    if (protectedFloor < cutoff) {
        cutoff = protectedFloor;
    }
    if (cutoff < 0n) return;
    await client.query(
        `DELETE FROM recent_block_hashes
          WHERE chain_id = $1 AND block_number <= $2`,
        [chainId, cutoff.toString()],
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
