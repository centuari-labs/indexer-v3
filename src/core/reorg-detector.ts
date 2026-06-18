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
 * A reorg deeper than the configured finality depth — none of the persisted
 * recent hashes within the window matches the live chain. This is NOT a
 * transient/retryable condition: the chain is "wedged" and needs operator
 * attention. The watcher surfaces it via the `indexer_chain_wedged` metric and
 * `/health` instead of silently churning. (H1)
 */
export class ReorgTooDeepError extends Error {
    readonly chainId: number;
    constructor(chainId: number, finalityDepth: number) {
        super(
            `reorg on chain ${chainId} deeper than finalityDepth=${finalityDepth}; ` +
                "no persisted hash within window matches live chain; manual intervention required",
        );
        this.name = "ReorgTooDeepError";
        this.chainId = chainId;
    }
}

/**
 * A block header the RPC previously served has gone missing (evicted mid-range,
 * or queried during a reorg before the new head settled). This is a TRANSIENT
 * signal: the next tick re-derives the cursor and either re-fetches the block
 * or detects the reorg cleanly. Treated as retryable — never a hard wedge. (H3)
 */
export class BlockUnavailableError extends Error {
    readonly chainId: number;
    readonly blockNumber: bigint;
    constructor(
        chainId: number,
        blockNumber: bigint,
        options?: { cause?: unknown },
    ) {
        super(
            `chain ${chainId} block ${blockNumber} header unavailable (evicted or mid-reorg); will retry`,
            options,
        );
        this.name = "BlockUnavailableError";
        this.chainId = chainId;
        this.blockNumber = blockNumber;
    }
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
const ZERO_HASH = `0x${"00".repeat(32)}`;

export async function findForkPoint(
    client: PublicClient,
    pgClient: PoolClient,
    cursor: BlockCursorRow,
    finalityDepth: number,
): Promise<ForkFinding | undefined> {
    const persistedHash = cursor.lastBlockHash.toLowerCase();

    // M2: cold-start / sentinel cursor — there is no real persisted hash to
    // compare against (the cursor was seeded with the zero sentinel and no
    // block has been recorded yet). Skip reorg detection this tick instead of
    // treating the mismatch as a reorg and throwing on the empty buffer.
    if (persistedHash === ZERO_HASH) {
        return undefined;
    }

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
        // M2: an empty buffer at apparent divergence is not necessarily a deep
        // reorg — it also happens right after a cold start / prune before any
        // hash is recorded. Treat it as a TRANSIENT (retryable) signal so the
        // watcher re-derives next tick rather than wedging the chain.
        throw new BlockUnavailableError(cursor.chainId, cursor.lastBlock);
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

    throw new ReorgTooDeepError(cursor.chainId, finalityDepth);
}
