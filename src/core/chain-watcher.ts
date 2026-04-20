import {
    createPublicClient,
    fallback,
    http,
    webSocket,
    type Address,
    type PublicClient,
} from "viem";
import type { Pool } from "pg";
import type { ChainConfig } from "../config/chains.js";
import { createLogger } from "../observability/logger.js";
import {
    blockLagSeconds,
    chainHeadBlock,
    cursorBlock,
} from "../observability/metrics.js";
import { getCursor, rewindTo, upsertCursor } from "./block-cursor.js";
import type { EventDispatcher } from "./event-dispatcher.js";
import { findForkPoint } from "./reorg-detector.js";

const POLL_INTERVAL_MS = 4_000;

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
                    lastBlockHash: ("0x" + "00".repeat(32)) as `0x${string}`,
                };
            } else {
                const fork = await findForkPoint(
                    this.client,
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

            // Cap per-tick range so a long backlog doesn't block reorg checks.
            const to = finalized - from > 500n ? from + 500n - 1n : finalized;

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

    private async processRange(
        pgClient: import("pg").PoolClient,
        from: bigint,
        to: bigint,
    ): Promise<void> {
        // Batch getLogs by our registered contracts. The dispatcher routes
        // by (contractName, topic0) so we tag each log with its contract here.
        for (const contract of this.contracts) {
            const logs = await this.client.getLogs({
                address: contract.address,
                fromBlock: from,
                toBlock: to,
            });
            // Group by block so we can write one tx per block.
            const byBlock = new Map<
                bigint,
                { hash: `0x${string}`; logs: typeof logs }
            >();
            for (const l of logs) {
                if (l.blockNumber === null || l.blockHash === null) continue;
                const existing = byBlock.get(l.blockNumber);
                if (existing) {
                    existing.logs.push(l);
                } else {
                    byBlock.set(l.blockNumber, {
                        hash: l.blockHash,
                        logs: [l],
                    });
                }
            }

            for (const [blockNumber, { hash, logs: blockLogs }] of byBlock) {
                await pgClient.query("BEGIN");
                try {
                    for (const log of blockLogs) {
                        await this.dispatcher.dispatch(
                            pgClient,
                            this.chain,
                            log,
                            contract.name,
                        );
                    }
                    await upsertCursor(pgClient, {
                        chainId: this.chain.id,
                        lastBlock: blockNumber,
                        lastBlockHash: hash,
                    });
                    await pgClient.query("COMMIT");
                } catch (err) {
                    await pgClient.query("ROLLBACK");
                    throw err;
                }
            }
        }

        // Advance cursor to `to` even if no logs matched, so we don't re-scan.
        await upsertCursor(pgClient, {
            chainId: this.chain.id,
            lastBlock: to,
            lastBlockHash: (await this.client.getBlock({ blockNumber: to }))
                .hash as `0x${string}`,
        });
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}
