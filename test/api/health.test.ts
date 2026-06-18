import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { buildServer } from "../../src/api/server.js";
import {
    clearChainWedged,
    markChainWedged,
} from "../../src/core/wedged-chains.js";

const HUB = 421614;

/** Minimal fake Pool that counts queries and returns one block_cursor row. */
function makeFakePool(): { pool: Pool; queryCount: () => number } {
    let count = 0;
    const pool = {
        query: async () => {
            count += 1;
            return {
                rows: [
                    {
                        chain_id: HUB,
                        last_block: "1000",
                        updated_at: new Date(),
                    },
                ],
                rowCount: 1,
            };
        },
    } as unknown as Pool;
    return { pool, queryCount: () => count };
}

describe("/health (H1 wedged surfacing + M4 caching)", () => {
    let app: FastifyInstance;

    afterEach(async () => {
        clearChainWedged(HUB);
        if (app) await app.close();
    });

    test("reports ok (200) and a non-wedged chain when healthy", async () => {
        const { pool } = makeFakePool();
        app = await buildServer({ healthPool: pool });
        const res = await app.inject({ method: "GET", url: "/health" });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.status).toBe("ok");
        expect(body.wedgedChains).toEqual([]);
        expect(body.chains[0]).toMatchObject({ chainId: HUB, wedged: false });
    });

    test("reports degraded (503) and surfaces the wedged chain (H1)", async () => {
        const { pool } = makeFakePool();
        app = await buildServer({ healthPool: pool });
        markChainWedged(HUB);
        const res = await app.inject({ method: "GET", url: "/health" });
        expect(res.statusCode).toBe(503);
        const body = res.json();
        expect(body.status).toBe("degraded");
        expect(body.wedgedChains).toContain(HUB);
        expect(body.chains[0].wedged).toBe(true);
    });

    test("caches the payload so rapid scrapes don't re-query the pool (M4)", async () => {
        const { pool, queryCount } = makeFakePool();
        app = await buildServer({ healthPool: pool });
        await app.inject({ method: "GET", url: "/health" });
        await app.inject({ method: "GET", url: "/health" });
        await app.inject({ method: "GET", url: "/health" });
        // Three scrapes within the 1s TTL → exactly one DB query.
        expect(queryCount()).toBe(1);
    });
});
