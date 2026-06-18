import type { Pool } from "pg";
import {
    type Address,
    createPublicClient,
    fallback,
    http,
    isAddressEqual,
    type Log,
    type PublicClient,
    webSocket,
} from "viem";
import type { ChainConfig } from "../config/chains.js";
import { hexToBytea } from "../db/bytea.js";
import { createLogger } from "../observability/logger.js";
import {
    blockLagSeconds,
    chainHeadBlock,
    cursorBlock,
} from "../observability/metrics.js";
import { getCursor, rewindTo, upsertCursor } from "./block-cursor.js";
import { stampChainIdForBlock } from "./chain-scope.js";
import type { EventDispatcher } from "./event-dispatcher.js";
import { pruneRecentHashes, recordBlockHash } from "./recent-hashes.js";
import {
    BlockUnavailableError,
    findForkPoint,
    ReorgTooDeepError,
} from "./reorg-detector.js";
import { clearChainWedged, markChainWedged } from "./wedged-chains.js";

/**
 * Postgres advisory-lock namespace key for the per-chain cursor critical
 * section (H2). `pg_advisory_xact_lock(NAMESPACE, chain_id)` serialises
 * fork-detect → rewind → replay for one chain across processes/connections so
 * two writers can't race the cursor. Auto-released on tx end.
 */
const CURSOR_LOCK_NAMESPACE = 0x6376_3378; // "cv3x"

const POLL_INTERVAL_MS = 4_000;

/**
 * Cap on blocks processed per tick. Keeps reorg checks frequent on long
 * backlogs (e.g. after an outage) and bounds per-tick DB work.
 */
const MAX_BLOCKS_PER_TICK = 500n;

export interface ContractBinding {
    name: string;
    address: Address;
}

export interface ChainWatcherOptions {
    chain: ChainConfig;
    pool: Pool;
    dispatcher: EventDispatcher;
    contracts: ContractBinding[];
}

/**
 * One ChainWatcher per chain. Tails blocks, dispatches logs to processors,
 * and atomically advances block_cursor per block inside a single pg tx.
 */
export class ChainWatcher {
    private readonly chain: ChainConfig;
    private readonly pool: Pool;
    private readonly dispatcher: EventDispatcher;
    private readonly contracts: ContractBinding[];
    private readonly client: PublicClient;
    private readonly log = createLogger("chain-watcher");
    private stopped = false;

    constructor(opts: ChainWatcherOptions) {
        this.chain = opts.chain;
        this.pool = opts.pool;
        this.dispatcher = opts.dispatcher;
        this.contracts = opts.contracts;
        this.client = createPublicClient({
            transport: fallback([
                webSocket(this.chain.rpcUrlWs, { reconnect: { attempts: 10 } }),
                http(this.chain.rpcUrlHttp),
            ]),
        });
    }

    async start(): Promise<void> {
        this.log.info(
            { chainId: this.chain.id, key: this.chain.key },
            "starting watcher",
        );
        // Define the wedged-gauge series at 0 up front so alerting has a
        // baseline before any reorg is ever observed.
        clearChainWedged(this.chain.id);
        while (!this.stopped) {
            try {
                await this.tick();
                // A clean tick clears any prior wedged state — the chain
                // recovered (e.g. operator widened finality / the reorg
                // resolved). (H1)
                clearChainWedged(this.chain.id);
            } catch (err) {
                if (err instanceof ReorgTooDeepError) {
                    // H1: a too-deep reorg cannot self-heal. Mark the chain
                    // wedged so `/health` + the `indexer_chain_wedged` metric
                    // stop reporting it healthy, and keep looping so we notice
                    // if the reorg later resolves — but do NOT crash the
                    // process (per-chain isolation; other chains keep running).
                    markChainWedged(this.chain.id);
                    this.log.error(
                        { err, chainId: this.chain.id },
                        "chain WEDGED: reorg deeper than finality; operator intervention required",
                    );
                } else if (err instanceof BlockUnavailableError) {
                    // H3: a missing/evicted block header is transient. Retry
                    // quietly next tick — this is expected churn during a
                    // reorg, not a fault.
                    this.log.warn(
                        { chainId: this.chain.id, err: err.message },
                        "block unavailable; transient, will retry",
                    );
                } else {
                    this.log.error(
                        { err, chainId: this.chain.id },
                        "tick failed; will retry",
                    );
                }
            }
            await sleep(POLL_INTERVAL_MS);
        }
    }

    stop(): void {
        this.stopped = true;
    }

    private async tick(): Promise<void> {
        const headBlock = await this.client.getBlockNumber();
        chainHeadBlock.labels(String(this.chain.id)).set(Number(headBlock));

        const finalized = headBlock - BigInt(this.chain.finalityDepth);
        if (finalized <= 0n) return;

        const pgClient = await this.pool.connect();
        try {
            let cursor = await getCursor(pgClient, this.chain.id);
            if (!cursor) {
                cursor = {
                    chainId: this.chain.id,
                    lastBlock:
                        this.chain.startBlock > 0n
                            ? this.chain.startBlock - 1n
                            : 0n,
                    lastBlockHash: `0x${"00".repeat(32)}` as `0x${string}`,
                };
            } else {
                const rewound = await this.detectAndRewind(pgClient, cursor);
                if (rewound) cursor = rewound;
            }

            const from = cursor.lastBlock + 1n;
            if (from > finalized) return;

            const to =
                finalized - from > MAX_BLOCKS_PER_TICK
                    ? from + MAX_BLOCKS_PER_TICK - 1n
                    : finalized;

            await this.processRange(pgClient, from, to);
            cursorBlock.labels(String(this.chain.id)).set(Number(to));

            const now = Math.floor(Date.now() / 1000);
            const headBlockInfo = await this.client.getBlock({
                blockNumber: to,
            });
            const ts = Number(headBlockInfo.timestamp);
            blockLagSeconds.labels(String(this.chain.id)).set(now - ts);
        } finally {
            pgClient.release();
        }
    }

    /**
     * H2: fork-detect → rewind under a per-chain advisory lock, re-verifying the
     * fork hash before commit.
     *
     * The whole critical section runs inside ONE transaction that first takes
     * `pg_advisory_xact_lock(NAMESPACE, chain_id)`, so no other watcher
     * connection (or a restarted instance) can interleave a cursor advance with
     * our rewind. `findForkPoint` runs *inside* the lock against the same tx, and
     * immediately before `rewindTo` we re-verify that the chosen fork block's
     * persisted hash still matches the live chain — guarding against a second
     * reorg landing between detection and the delete. If it no longer matches we
     * abort and let the next tick re-derive. The advisory lock auto-releases on
     * COMMIT/ROLLBACK.
     *
     * Returns the new cursor when a rewind happened, otherwise `undefined`.
     */
    private async detectAndRewind(
        pgClient: import("pg").PoolClient,
        cursor: import("./block-cursor.js").BlockCursorRow,
    ): Promise<import("./block-cursor.js").BlockCursorRow | undefined> {
        await pgClient.query("BEGIN");
        try {
            await pgClient.query("SELECT pg_advisory_xact_lock($1, $2)", [
                CURSOR_LOCK_NAMESPACE,
                this.chain.id,
            ]);

            // Re-read the cursor under the lock — another writer may have moved
            // it between our unlocked read and acquiring the lock.
            const locked = await getCursor(pgClient, this.chain.id);
            const current = locked ?? cursor;

            const fork = await findForkPoint(
                this.client,
                pgClient,
                current,
                this.chain.finalityDepth,
            );
            if (!fork) {
                await pgClient.query("COMMIT");
                return undefined;
            }

            // Re-verify the fork point still matches the live chain before we
            // delete anything (a second reorg could have moved it).
            const liveAtFork = await this.client.getBlock({
                blockNumber: fork.forkPointBlock,
            });
            if (
                !liveAtFork.hash ||
                liveAtFork.hash.toLowerCase() !==
                    fork.forkPointBlockHash.toLowerCase()
            ) {
                await pgClient.query("ROLLBACK");
                throw new BlockUnavailableError(
                    this.chain.id,
                    fork.forkPointBlock,
                );
            }

            await rewindTo(
                pgClient,
                this.chain.id,
                fork.forkPointBlock,
                fork.forkPointBlockHash,
            );
            await pgClient.query("COMMIT");
            return {
                chainId: this.chain.id,
                lastBlock: fork.forkPointBlock,
                lastBlockHash: fork.forkPointBlockHash,
            };
        } catch (err) {
            try {
                await pgClient.query("ROLLBACK");
            } catch {
                // ignore rollback error on an already-aborted tx
            }
            throw err;
        }
    }

    /**
     * Process blocks [from, to] one at a time. For each block we:
     *   1. Collect every log across all bound contracts at that block number.
     *   2. Fetch the block header once.
     *   3. In a single pg tx: dispatch logs, upsert cursor, record the block
     *      hash in recent_block_hashes, prune old entries.
     *
     * Block-by-block iteration (rather than contract-outer / block-inner)
     * guarantees cursor + entity rows + recent_block_hashes advance atomically
     * for a single block. reorg-detector depends on that invariant.
     */
    private async processRange(
        pgClient: import("pg").PoolClient,
        from: bigint,
        to: bigint,
    ): Promise<void> {
        const pruneCutoff = BigInt(this.chain.finalityDepth) * 2n;
        for (let blockNumber = from; blockNumber <= to; blockNumber++) {
            // L3: one getLogs across ALL bound contracts for this block
            // (viem accepts `address` as an array) instead of O(contracts)
            // round-trips. Group the returned logs back to their contract by
            // address so the downstream { contractName, logs } structure — and
            // the dispatch loop below — is unchanged.
            const blockLogs = await this.client.getLogs({
                address: this.contracts.map((c) => c.address),
                fromBlock: blockNumber,
                toBlock: blockNumber,
            });
            const logsByContract: {
                contractName: string;
                logs: Log[];
            }[] = [];
            for (const contract of this.contracts) {
                const logs = blockLogs.filter((log) =>
                    isAddressEqual(log.address, contract.address),
                );
                if (logs.length > 0) {
                    logsByContract.push({
                        contractName: contract.name,
                        logs,
                    });
                }
            }

            // H3: a block that was just listed by getLogs can vanish mid-range
            // (evicted, or queried during a reorg before the new head settled).
            // Treat "no header" as a TRANSIENT reorg/availability signal, not a
            // hard fault — the watcher retries next tick and either re-fetches
            // or detects the reorg cleanly. Throwing a generic Error here fed
            // the silent 4s retry churn (H1).
            let block: Awaited<ReturnType<PublicClient["getBlock"]>>;
            try {
                block = await this.client.getBlock({ blockNumber });
            } catch (err) {
                throw new BlockUnavailableError(this.chain.id, blockNumber, {
                    cause: err,
                });
            }
            if (!block.hash) {
                throw new BlockUnavailableError(this.chain.id, blockNumber);
            }
            const blockHash = block.hash;

            await pgClient.query("BEGIN");
            try {
                for (const { contractName, logs } of logsByContract) {
                    for (const log of logs) {
                        await this.dispatcher.dispatch(
                            pgClient,
                            this.chain,
                            log,
                            contractName,
                        );
                    }
                }
                await upsertCursor(pgClient, {
                    chainId: this.chain.id,
                    lastBlock: blockNumber,
                    lastBlockHash: blockHash,
                });
                await recordBlockHash(
                    pgClient,
                    this.chain.id,
                    blockNumber,
                    blockHash,
                );
                // C1: stamp this chain's id onto every stamped row the block
                // just wrote (scoped by the globally-unique block hash), so a
                // future reorg on another chain can't evict these rows.
                await stampChainIdForBlock(
                    pgClient,
                    this.chain.id,
                    hexToBytea(blockHash),
                );
                if (blockNumber > pruneCutoff) {
                    await pruneRecentHashes(
                        pgClient,
                        this.chain.id,
                        blockNumber - pruneCutoff,
                        blockNumber,
                        this.chain.finalityDepth,
                    );
                }
                await pgClient.query("COMMIT");
            } catch (err) {
                await pgClient.query("ROLLBACK");
                throw err;
            }
        }
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}
