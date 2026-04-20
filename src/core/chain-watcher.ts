import type { Pool } from "pg";
import {
    type Address,
    createPublicClient,
    fallback,
    http,
    type Log,
    type PublicClient,
    webSocket,
} from "viem";
import type { ChainConfig } from "../config/chains.js";
import { createLogger } from "../observability/logger.js";
import {
    blockLagSeconds,
    chainHeadBlock,
    cursorBlock,
} from "../observability/metrics.js";
import { getCursor, rewindTo, upsertCursor } from "./block-cursor.js";
import type { EventDispatcher } from "./event-dispatcher.js";
import { pruneRecentHashes, recordBlockHash } from "./recent-hashes.js";
import { findForkPoint } from "./reorg-detector.js";

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
        while (!this.stopped) {
            try {
                await this.tick();
            } catch (err) {
                this.log.error(
                    { err, chainId: this.chain.id },
                    "tick failed; will retry",
                );
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
                const fork = await findForkPoint(
                    this.client,
                    pgClient,
                    cursor,
                    this.chain.finalityDepth,
                );
                if (fork) {
                    await pgClient.query("BEGIN");
                    try {
                        await rewindTo(
                            pgClient,
                            this.chain.id,
                            fork.forkPointBlock,
                            fork.forkPointBlockHash,
                        );
                        await pgClient.query("COMMIT");
                    } catch (err) {
                        await pgClient.query("ROLLBACK");
                        throw err;
                    }
                    cursor = {
                        chainId: this.chain.id,
                        lastBlock: fork.forkPointBlock,
                        lastBlockHash: fork.forkPointBlockHash,
                    };
                }
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
            const logsByContract: {
                contractName: string;
                logs: Log[];
            }[] = [];
            for (const contract of this.contracts) {
                const logs = await this.client.getLogs({
                    address: contract.address,
                    fromBlock: blockNumber,
                    toBlock: blockNumber,
                });
                if (logs.length > 0) {
                    logsByContract.push({
                        contractName: contract.name,
                        logs,
                    });
                }
            }

            const block = await this.client.getBlock({ blockNumber });
            if (!block.hash) {
                throw new Error(
                    `chain ${this.chain.id} block ${blockNumber} returned no hash`,
                );
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
                if (blockNumber > pruneCutoff) {
                    await pruneRecentHashes(
                        pgClient,
                        this.chain.id,
                        blockNumber - pruneCutoff,
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
