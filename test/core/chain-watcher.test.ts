import { jest } from "@jest/globals";
import type { Pool, PoolClient } from "pg";
import type { Address, Hex, Log, PublicClient } from "viem";
import { ChainWatcher } from "../../src/core/chain-watcher.js";
import type { EventDispatcher } from "../../src/core/event-dispatcher.js";
import {
    fetchLogsByBlock,
    isRangeLimitError,
    resolveBlockHashes,
    runWithConcurrency,
} from "../../src/core/log-fetch.js";
import { BlockUnavailableError } from "../../src/core/reorg-detector.js";
import { makeHubChain } from "../helpers/chain.js";
import { FakePoolClient, asPoolClient } from "../helpers/fake-client.js";

const ADDR_A = `0x${"0a".repeat(20)}` as Address;
const ADDR_B = `0x${"0b".repeat(20)}` as Address;
const HASH = (n: number): Hex =>
    `0x${n.toString(16).padStart(2, "0").repeat(32)}` as Hex;

/** Minimal Log good enough for grouping-by-address / hash extraction. */
function mkLog(
    address: Address,
    blockNumber: bigint,
    blockHash: Hex | null,
    logIndex = 0,
): Log {
    return {
        address,
        blockNumber,
        blockHash,
        logIndex,
        topics: ["0x"],
        data: "0x",
        transactionHash: HASH(0xaa),
        transactionIndex: 0,
        removed: false,
    } as unknown as Log;
}

function rangeError(message = "query returned more than 10000 results"): Error {
    return new Error(message);
}

const tick = (): Promise<void> =>
    new Promise((r) => {
        setTimeout(r, 1);
    });

describe("isRangeLimitError", () => {
    test.each([
        "query returned more than 10000 results",
        "Log response size exceeded. this block range should work",
        "block range is too wide",
        "range is too large",
        "this exceeds the limit of 1000",
        "too many results",
    ])("matches range-limit signature: %s", (msg) => {
        expect(isRangeLimitError(new Error(msg))).toBe(true);
    });

    test("matches JSON-RPC -32005 limit code", () => {
        expect(isRangeLimitError({ code: -32005, message: "limited" })).toBe(
            true,
        );
    });

    test("matches a nested cause", () => {
        const err = new Error("outer");
        (err as { cause?: unknown }).cause = new Error(
            "Log response size exceeded",
        );
        expect(isRangeLimitError(err)).toBe(true);
    });

    test("does not match a generic error", () => {
        expect(isRangeLimitError(new Error("connection refused"))).toBe(false);
        expect(isRangeLimitError(null)).toBe(false);
        expect(isRangeLimitError(undefined)).toBe(false);
    });
});

describe("runWithConcurrency", () => {
    test("processes every item", async () => {
        const seen: number[] = [];
        await runWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
            await tick();
            seen.push(n);
        });
        expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    });

    test("never exceeds the concurrency limit", async () => {
        let inFlight = 0;
        let peak = 0;
        const items = Array.from({ length: 50 }, (_, i) => i);
        await runWithConcurrency(items, 10, async () => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await tick();
            inFlight--;
        });
        expect(peak).toBe(10);
    });

    test("is a no-op on empty input", async () => {
        const worker = jest.fn(async () => {});
        await runWithConcurrency([], 4, worker);
        expect(worker).not.toHaveBeenCalled();
    });

    test("rethrows the first error and stops scheduling new work", async () => {
        let started = 0;
        await expect(
            runWithConcurrency([1, 2, 3, 4, 5, 6], 1, async (n) => {
                started++;
                if (n === 2) throw new Error("boom");
                await tick();
            }),
        ).rejects.toThrow("boom");
        // With limit 1 and a throw on the 2nd item, items 3..6 never start.
        expect(started).toBe(2);
    });
});

describe("fetchLogsByBlock", () => {
    test("issues one ranged getLogs and groups logs by block", async () => {
        const getLogs = jest.fn(
            async (_args: unknown) =>
                [
                    mkLog(ADDR_A, 100n, HASH(100)),
                    mkLog(ADDR_B, 100n, HASH(100), 1),
                    mkLog(ADDR_A, 102n, HASH(102)),
                ] as Log[],
        );
        const client = { getLogs } as unknown as Pick<PublicClient, "getLogs">;

        const byBlock = await fetchLogsByBlock(
            client,
            [ADDR_A, ADDR_B],
            100n,
            103n,
            2000n,
        );

        expect(getLogs).toHaveBeenCalledTimes(1);
        expect(getLogs).toHaveBeenCalledWith({
            address: [ADDR_A, ADDR_B],
            fromBlock: 100n,
            toBlock: 103n,
        });
        expect(byBlock.get(100n)).toHaveLength(2);
        expect(byBlock.get(102n)).toHaveLength(1);
        expect(byBlock.has(101n)).toBe(false);
    });

    test("chunks the range by chunkSize", async () => {
        const calls: Array<{ from: bigint; to: bigint }> = [];
        const getLogs = jest.fn(async (args: unknown) => {
            const { fromBlock, toBlock } = args as {
                fromBlock: bigint;
                toBlock: bigint;
            };
            calls.push({ from: fromBlock, to: toBlock });
            const out: Log[] = [];
            for (let b = fromBlock; b <= toBlock; b++) {
                out.push(mkLog(ADDR_A, b, HASH(Number(b))));
            }
            return out;
        });
        const client = { getLogs } as unknown as Pick<PublicClient, "getLogs">;

        const byBlock = await fetchLogsByBlock(client, [ADDR_A], 0n, 4n, 2n);

        expect(calls).toEqual([
            { from: 0n, to: 1n },
            { from: 2n, to: 3n },
            { from: 4n, to: 4n },
        ]);
        expect([...byBlock.keys()].sort((a, b) => Number(a - b))).toEqual([
            0n,
            1n,
            2n,
            3n,
            4n,
        ]);
    });

    test("halves the chunk and retries on a range-limit error (full coverage, no gaps)", async () => {
        const calls: Array<{ from: bigint; to: bigint }> = [];
        const getLogs = jest.fn(async (args: unknown) => {
            const { fromBlock, toBlock } = args as {
                fromBlock: bigint;
                toBlock: bigint;
            };
            calls.push({ from: fromBlock, to: toBlock });
            // RPC rejects any span wider than 2 blocks.
            if (toBlock - fromBlock + 1n > 2n) throw rangeError();
            const out: Log[] = [];
            for (let b = fromBlock; b <= toBlock; b++) {
                out.push(mkLog(ADDR_A, b, HASH(Number(b))));
            }
            return out;
        });
        const client = { getLogs } as unknown as Pick<PublicClient, "getLogs">;

        const byBlock = await fetchLogsByBlock(client, [ADDR_A], 0n, 7n, 4n);

        // First call (span 4) throws → halve to 2 → cover the whole range.
        expect(calls[0]).toEqual({ from: 0n, to: 3n });
        const successful = calls.slice(1);
        expect(successful).toEqual([
            { from: 0n, to: 1n },
            { from: 2n, to: 3n },
            { from: 4n, to: 5n },
            { from: 6n, to: 7n },
        ]);
        // No successful span exceeds 2 blocks; every block 0..7 is grouped once.
        expect(byBlock.size).toBe(8);
        for (let b = 0n; b <= 7n; b++) {
            expect(byBlock.get(b)).toHaveLength(1);
        }
    });

    test("bubbles a non-range error without retrying", async () => {
        const getLogs = jest.fn(async () => {
            throw new Error("connection refused");
        });
        const client = { getLogs } as unknown as Pick<PublicClient, "getLogs">;

        await expect(
            fetchLogsByBlock(client, [ADDR_A], 0n, 9n, 2000n),
        ).rejects.toThrow("connection refused");
        expect(getLogs).toHaveBeenCalledTimes(1);
    });
});

describe("resolveBlockHashes", () => {
    test("reuses log.blockHash for non-empty blocks; getBlock only for empties", async () => {
        const getBlock = jest.fn(
            async (args: unknown): Promise<{ hash: Hex | null }> => {
                const { blockNumber } = args as { blockNumber: bigint };
                return { hash: HASH(Number(blockNumber)) };
            },
        );
        const client = { getBlock } as unknown as Pick<
            PublicClient,
            "getBlock"
        >;
        const logsByBlock = new Map<bigint, Log[]>([
            [100n, [mkLog(ADDR_A, 100n, HASH(0xaa))]],
            [102n, [mkLog(ADDR_B, 102n, HASH(0xbb))]],
        ]);

        const hashes = await resolveBlockHashes(
            client,
            421614,
            100n,
            103n,
            logsByBlock,
            10,
            0,
        );

        // Hash recorded for EVERY block, including empties 101 & 103.
        expect(hashes.get(100n)).toBe(HASH(0xaa));
        expect(hashes.get(102n)).toBe(HASH(0xbb));
        expect(hashes.get(101n)).toBe(HASH(101));
        expect(hashes.get(103n)).toBe(HASH(103));
        // getBlock called only for the two empty blocks.
        expect(getBlock).toHaveBeenCalledTimes(2);
        const fetched = getBlock.mock.calls.map(
            (c) => (c[0] as { blockNumber: bigint }).blockNumber,
        );
        expect(fetched.sort((a, b) => Number(a - b))).toEqual([101n, 103n]);
    });

    test("bounds getBlock concurrency for empty blocks", async () => {
        let inFlight = 0;
        let peak = 0;
        const getBlock = jest.fn(
            async (args: unknown): Promise<{ hash: Hex | null }> => {
                inFlight++;
                peak = Math.max(peak, inFlight);
                await tick();
                inFlight--;
                const { blockNumber } = args as { blockNumber: bigint };
                return { hash: HASH(Number(blockNumber)) };
            },
        );
        const client = { getBlock } as unknown as Pick<
            PublicClient,
            "getBlock"
        >;

        const hashes = await resolveBlockHashes(
            client,
            421614,
            0n,
            49n,
            new Map(), // all 50 blocks empty
            10,
            0,
        );

        expect(hashes.size).toBe(50);
        expect(peak).toBe(10);
    });

    test("throws BlockUnavailableError when an empty block's header never resolves", async () => {
        const getBlock = jest.fn(async () => {
            throw new Error("missing trie node");
        });
        const client = { getBlock } as unknown as Pick<
            PublicClient,
            "getBlock"
        >;

        await expect(
            resolveBlockHashes(client, 421614, 100n, 100n, new Map(), 4, 1),
        ).rejects.toBeInstanceOf(BlockUnavailableError);
        // initial attempt + 1 retry
        expect(getBlock).toHaveBeenCalledTimes(2);
    });

    test("throws BlockUnavailableError when getBlock returns a null hash", async () => {
        const getBlock = jest.fn(
            async (): Promise<{ hash: Hex | null }> => ({ hash: null }),
        );
        const client = { getBlock } as unknown as Pick<
            PublicClient,
            "getBlock"
        >;

        await expect(
            resolveBlockHashes(client, 421614, 5n, 5n, new Map(), 4, 0),
        ).rejects.toBeInstanceOf(BlockUnavailableError);
    });

    test("throws BlockUnavailableError when a non-empty block's log has a null hash", async () => {
        const getBlock = jest.fn();
        const client = { getBlock } as unknown as Pick<
            PublicClient,
            "getBlock"
        >;
        const logsByBlock = new Map<bigint, Log[]>([
            [7n, [mkLog(ADDR_A, 7n, null)]],
        ]);

        await expect(
            resolveBlockHashes(client, 421614, 7n, 7n, logsByBlock, 4, 0),
        ).rejects.toBeInstanceOf(BlockUnavailableError);
        expect(getBlock).not.toHaveBeenCalled();
    });
});

describe("ChainWatcher.processRange (batched)", () => {
    class TestWatcher extends ChainWatcher {
        run(pg: PoolClient, from: bigint, to: bigint): Promise<void> {
            return this.processRange(pg, from, to);
        }
    }

    function build(opts: { client: PublicClient; dispatch?: jest.Mock }): {
        watcher: TestWatcher;
        dispatch: jest.Mock;
    } {
        const dispatch = opts.dispatch ?? jest.fn(async () => {});
        const dispatcher = { dispatch } as unknown as EventDispatcher;
        const watcher = new TestWatcher({
            chain: makeHubChain({ id: 421614, finalityDepth: 12 }),
            pool: {} as unknown as Pool,
            dispatcher,
            contracts: [
                { name: "BalanceLedger", address: ADDR_A },
                { name: "Centuari", address: ADDR_B },
            ],
            client: opts.client,
            tuning: { headerRetries: 0 },
        });
        return { watcher, dispatch };
    }

    test("one ranged getLogs, per-block atomic commit, hash recorded for every block", async () => {
        const getLogs = jest.fn(
            async () =>
                [
                    mkLog(ADDR_A, 100n, HASH(100)),
                    mkLog(ADDR_B, 102n, HASH(102)),
                ] as Log[],
        );
        const getBlock = jest.fn(
            async (args: unknown): Promise<{ hash: Hex | null }> => {
                const { blockNumber } = args as { blockNumber: bigint };
                return { hash: HASH(Number(blockNumber)) };
            },
        );
        const client = { getLogs, getBlock } as unknown as PublicClient;
        const { watcher, dispatch } = build({ client });
        const pg = new FakePoolClient();

        await watcher.run(asPoolClient(pg), 100n, 103n);

        // Phase A: a single ranged getLogs for the whole window.
        expect(getLogs).toHaveBeenCalledTimes(1);
        // Phase B: getBlock only for the two empty blocks (101, 103).
        expect(getBlock).toHaveBeenCalledTimes(2);

        // Dispatch grouped per (block, contract).
        expect(dispatch).toHaveBeenCalledTimes(2);
        const dispatched = dispatch.mock.calls.map((c) => ({
            contract: c[3],
            block: (c[2] as Log).blockNumber,
        }));
        expect(dispatched).toContainEqual({
            contract: "BalanceLedger",
            block: 100n,
        });
        expect(dispatched).toContainEqual({
            contract: "Centuari",
            block: 102n,
        });

        // Four blocks → four BEGIN/COMMIT and a recorded hash for EACH block
        // (including the empty 101 & 103) so the reorg buffer stays dense.
        expect(pg.filterBySqlContains("BEGIN")).toHaveLength(4);
        expect(pg.filterBySqlContains("COMMIT")).toHaveLength(4);
        expect(pg.filterBySqlContains("INSERT INTO block_cursor")).toHaveLength(
            4,
        );
        expect(
            pg.filterBySqlContains("INSERT INTO recent_block_hashes"),
        ).toHaveLength(4);
    });

    test("per-block SQL ordering: BEGIN → cursor → recent_block_hashes → COMMIT", async () => {
        const client = {
            getLogs: jest.fn(async () => [] as Log[]),
            getBlock: jest.fn(
                async (args: unknown): Promise<{ hash: Hex | null }> => {
                    const { blockNumber } = args as { blockNumber: bigint };
                    return { hash: HASH(Number(blockNumber)) };
                },
            ),
        } as unknown as PublicClient;
        const { watcher } = build({ client });
        const pg = new FakePoolClient();

        await watcher.run(asPoolClient(pg), 100n, 100n);

        const order = pg.recorded
            .map((q) => q.sql)
            .map((sql) => {
                if (sql === "BEGIN") return "BEGIN";
                if (sql === "COMMIT") return "COMMIT";
                if (sql.includes("INSERT INTO block_cursor")) return "CURSOR";
                if (sql.includes("INSERT INTO recent_block_hashes"))
                    return "HASH";
                return null;
            })
            .filter((x): x is string => x !== null);

        expect(order.indexOf("BEGIN")).toBeLessThan(order.indexOf("CURSOR"));
        expect(order.indexOf("CURSOR")).toBeLessThan(order.indexOf("HASH"));
        expect(order.indexOf("HASH")).toBeLessThan(order.indexOf("COMMIT"));
    });

    test("a persistent empty-block header miss aborts the tick with ZERO commits", async () => {
        const client = {
            getLogs: jest.fn(async () => [] as Log[]),
            getBlock: jest.fn(async () => {
                throw new Error("missing trie node");
            }),
        } as unknown as PublicClient;
        const { watcher } = build({ client });
        const pg = new FakePoolClient();

        await expect(
            watcher.run(asPoolClient(pg), 100n, 103n),
        ).rejects.toBeInstanceOf(BlockUnavailableError);

        // Phase B failed before Phase C — nothing was written.
        expect(pg.filterBySqlContains("BEGIN")).toHaveLength(0);
        expect(pg.filterBySqlContains("COMMIT")).toHaveLength(0);
    });
});
