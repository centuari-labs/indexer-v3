import type { PoolClient } from "pg";
import type { PublicClient } from "viem";
import { createLogger } from "../observability/logger.js";
import { reorgDepth } from "../observability/metrics.js";
import type { BlockCursorRow } from "./block-cursor.js";
import { getRecentHashes } from "./recent-hashes.js";

const log = createLogger("reorg-detector");

export interface ForkFinding {
    forkPointBlock: bigint;
    forkPointBlockHash: `0x${string}`;
}

/**
 * Detects a reorg at the current cursor and, if one exists, walks the persisted
 * `recent_block_hashes` buffer newest→oldest looking for the highest block
 * whose persisted hash still matches the live chain. That block is the fork
 * point; rows above it are evicted by `rewindTo`.
 *
 * Returns `undefined` when `cursor.lastBlockHash` still matches on-chain.
 * Throws when no persisted hash within `finalityDepth + 1` rows matches —
 * the reorg is deeper than the configured finality and requires operator
 * attention.
 */
export async function findForkPoint(
    client: PublicClient,
    pgClient: PoolClient,
    cursor: BlockCursorRow,
    finalityDepth: number,
): Promise<ForkFinding | undefined> {
    const persistedHash = cursor.lastBlockHash.toLowerCase();
    const live = await client.getBlock({ blockNumber: cursor.lastBlock });
    if (live.hash && live.hash.toLowerCase() === persistedHash) {
        return undefined;
    }

    const rows = await getRecentHashes(
        pgClient,
        cursor.chainId,
        finalityDepth + 1,
    );
    if (rows.length === 0) {
        throw new Error(
            `reorg detected on chain ${cursor.chainId} at block ${cursor.lastBlock} ` +
                "but recent_block_hashes is empty; cannot locate fork point",
        );
    }

    for (const row of rows) {
        const block = await client.getBlock({ blockNumber: row.blockNumber });
        if (!block.hash) continue;
        if (block.hash.toLowerCase() === row.blockHash.toLowerCase()) {
            const depth = cursor.lastBlock - row.blockNumber;
            reorgDepth.labels(String(cursor.chainId)).set(Number(depth));
            log.warn(
                {
                    chainId: cursor.chainId,
                    forkPointBlock: row.blockNumber.toString(),
                    forkPointBlockHash: row.blockHash,
                    depth: depth.toString(),
                },
                "reorg detected; rewinding to fork point",
            );
            return {
                forkPointBlock: row.blockNumber,
                forkPointBlockHash: row.blockHash,
            };
        }
    }

    throw new Error(
        `reorg on chain ${cursor.chainId} deeper than finalityDepth=${finalityDepth}; ` +
            "no persisted hash within window matches live chain; manual intervention required",
    );
}
