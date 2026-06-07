import type { Address, Hex, Log, PublicClient } from "viem";
import { BlockUnavailableError } from "./reorg-detector.js";

/**
 * Lowercased substrings (and JSON-RPC error codes) that mark an RPC
 * range/response-size limit on `eth_getLogs`. Free and even paid RPCs cap a
 * single getLogs by block span and/or by result size; when we hit one we halve
 * the requested block range and retry rather than failing the tick. Kept as a
 * named table (no magic strings scattered through the fetch loop).
 */
const RANGE_LIMIT_SIGNATURES = [
    "query returned more than", // Alchemy result cap
    "log response size exceeded", // Alchemy size cap
    "response size exceeded",
    "block range is too wide",
    "range is too large",
    "range too large",
    "exceeds the limit",
    "too many results",
    "limit exceeded",
    "-32005", // Infura / Alchemy "limit exceeded" JSON-RPC code
];

/** Flatten an error (message/details/code/cause chain) into one lowercased blob. */
function errorText(err: unknown, depth = 0): string {
    if (err == null || depth > 5) return "";
    if (typeof err === "string") return err;
    if (typeof err !== "object") return String(err);
    const e = err as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of ["message", "details", "shortMessage", "reason"]) {
        const v = e[key];
        if (typeof v === "string") parts.push(v);
    }
    if (typeof e.code === "number" || typeof e.code === "string") {
        parts.push(String(e.code));
    }
    if (Array.isArray(e.metaMessages)) {
        parts.push(
            e.metaMessages.filter((m) => typeof m === "string").join(" "),
        );
    }
    if (e.cause) parts.push(errorText(e.cause, depth + 1));
    return parts.join(" ");
}

/**
 * True when an error from `getLogs` indicates the RPC rejected the request for
 * spanning too many blocks / returning too many logs — i.e. the request is
 * retryable with a smaller block range. Any other error is NOT a range limit
 * (it should bubble up so the tick fails and retries cleanly).
 */
export function isRangeLimitError(err: unknown): boolean {
    const text = errorText(err).toLowerCase();
    if (!text) return false;
    return RANGE_LIMIT_SIGNATURES.some((sig) => text.includes(sig));
}

/**
 * Fetch every log for `[from, to]` across all bound contract addresses using
 * ranged `getLogs` calls (one per chunk of up to `chunkSize` blocks) instead of
 * one call per block, then group the results by block number.
 *
 * On a range-limit error the chunk size is halved and the SAME chunk start is
 * retried, so the full range is always covered exactly once with no gaps. A
 * non-range error bubbles to the caller (the tick fails and retries).
 *
 * This collapses the previous O(blocks) getLogs round-trips into ~O(1) per tick,
 * which is the dominant throughput win over the old block-by-block loop.
 */
export async function fetchLogsByBlock(
    client: Pick<PublicClient, "getLogs">,
    addresses: Address[],
    from: bigint,
    to: bigint,
    chunkSize: bigint,
): Promise<Map<bigint, Log[]>> {
    const byBlock = new Map<bigint, Log[]>();
    let chunkStart = from;
    let size = chunkSize > 0n ? chunkSize : 1n;

    while (chunkStart <= to) {
        const tentativeEnd = chunkStart + size - 1n;
        const chunkEnd = tentativeEnd > to ? to : tentativeEnd;

        let logs: Log[];
        try {
            logs = await client.getLogs({
                address: addresses,
                fromBlock: chunkStart,
                toBlock: chunkEnd,
            });
        } catch (err) {
            // Range/size cap: shrink and retry the same start. Floor at 1 block;
            // if a single block still trips the cap there is nothing left to
            // subdivide, so let it bubble.
            if (isRangeLimitError(err) && size > 1n) {
                size = size > 1n ? size / 2n : 1n;
                if (size < 1n) size = 1n;
                continue;
            }
            throw err;
        }

        for (const entry of logs) {
            const bn = entry.blockNumber;
            if (bn === null) continue; // pending log — not expected for a finalized range
            const arr = byBlock.get(bn);
            if (arr) arr.push(entry);
            else byBlock.set(bn, [entry]);
        }

        chunkStart = chunkEnd + 1n;
    }

    return byBlock;
}

/**
 * Run `worker` over `items` with at most `limit` in flight at once. Resolves
 * when all items are processed; if any worker throws, the first error is
 * rethrown and no further items are started.
 */
export async function runWithConcurrency<T>(
    items: readonly T[],
    limit: number,
    worker: (item: T) => Promise<void>,
): Promise<void> {
    if (items.length === 0) return;
    const max = Math.max(1, Math.min(limit, items.length));
    let cursor = 0;
    let firstErr: unknown;

    const drain = async (): Promise<void> => {
        while (cursor < items.length && firstErr === undefined) {
            const index = cursor++;
            const item = items[index];
            if (item === undefined) return;
            try {
                await worker(item);
            } catch (err) {
                if (firstErr === undefined) firstErr = err;
                return;
            }
        }
    };

    await Promise.all(Array.from({ length: max }, () => drain()));
    if (firstErr !== undefined) throw firstErr;
}

/** Fetch a single block's hash, retrying transient misses up to `retries` times. */
async function fetchHeaderHash(
    client: Pick<PublicClient, "getBlock">,
    chainId: number,
    blockNumber: bigint,
    retries: number,
): Promise<Hex> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const block = await client.getBlock({ blockNumber });
            if (block.hash) return block.hash;
            lastErr = undefined; // a null hash is itself a transient signal
        } catch (err) {
            lastErr = err;
        }
    }
    throw new BlockUnavailableError(
        chainId,
        blockNumber,
        lastErr === undefined ? undefined : { cause: lastErr },
    );
}

/**
 * Resolve a block hash for EVERY block in `[from, to]` — required by reorg
 * detection, whose fork-point walk needs a dense `recent_block_hashes` buffer
 * (a gap on a zero-log block would break the per-height comparison).
 *
 * Non-empty blocks reuse the `blockHash` already present on their logs (no extra
 * round-trip). Empty (zero-log) blocks still need a hash, fetched via `getBlock`
 * with bounded concurrency. All RPC work happens before any DB write, so a
 * persistent header miss aborts the whole tick (zero commits) and the next tick
 * re-derives — preserving the transient `BlockUnavailableError` contract.
 */
export async function resolveBlockHashes(
    client: Pick<PublicClient, "getBlock">,
    chainId: number,
    from: bigint,
    to: bigint,
    logsByBlock: Map<bigint, Log[]>,
    concurrency: number,
    headerRetries: number,
): Promise<Map<bigint, Hex>> {
    const hashByBlock = new Map<bigint, Hex>();
    const emptyBlocks: bigint[] = [];

    for (let bn = from; bn <= to; bn++) {
        const logs = logsByBlock.get(bn);
        const first = logs?.[0];
        if (first) {
            // Defensive: a mined log must carry its block hash.
            if (!first.blockHash) {
                throw new BlockUnavailableError(chainId, bn);
            }
            hashByBlock.set(bn, first.blockHash);
        } else {
            emptyBlocks.push(bn);
        }
    }

    await runWithConcurrency(emptyBlocks, concurrency, async (bn) => {
        const hash = await fetchHeaderHash(client, chainId, bn, headerRetries);
        hashByBlock.set(bn, hash);
    });

    return hashByBlock;
}
