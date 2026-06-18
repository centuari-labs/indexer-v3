import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { wedgedChainIds } from "../../core/wedged-chains.js";

/**
 * How long a computed `/health` payload is reused before re-querying the DB
 * (M4). Health is scraped on a fixed cadence by docker + ops; a short cache
 * collapses bursts so `/health` can't exhaust the (dedicated) pool.
 */
const HEALTH_CACHE_TTL_MS = 1_000;

interface ChainHealth {
    chainId: number;
    lastBlock: string;
    blockLagSeconds: number;
    wedged: boolean;
}

interface HealthPayload {
    status: "ok" | "degraded";
    wedgedChains: number[];
    chains: ChainHealth[];
}

export async function registerHealthRoutes(
    app: FastifyInstance,
    pool: Pool,
): Promise<void> {
    let cached: { at: number; payload: HealthPayload } | undefined;

    app.get("/health", async (_req, reply) => {
        const now = Date.now();
        if (cached && now - cached.at < HEALTH_CACHE_TTL_MS) {
            reply.code(cached.payload.status === "ok" ? 200 : 503);
            return cached.payload;
        }

        const res = await pool.query<{
            chain_id: number;
            last_block: string;
            updated_at: Date;
        }>(
            `SELECT chain_id, last_block, updated_at
               FROM block_cursor
              ORDER BY chain_id`,
        );

        // H1: surface wedged chains (too-deep reorg) so a wedged chain stops
        // looking healthy. A wedged chain forces overall status to "degraded"
        // (HTTP 503) so the docker/ops healthcheck fails fast.
        const wedged = new Set(wedgedChainIds());
        const chains: ChainHealth[] = res.rows.map((r) => ({
            chainId: r.chain_id,
            lastBlock: r.last_block,
            blockLagSeconds: Math.max(
                0,
                Math.round((now - r.updated_at.getTime()) / 1000),
            ),
            wedged: wedged.has(r.chain_id),
        }));

        const payload: HealthPayload = {
            status: wedged.size > 0 ? "degraded" : "ok",
            wedgedChains: [...wedged],
            chains,
        };
        cached = { at: now, payload };
        reply.code(payload.status === "ok" ? 200 : 503);
        return payload;
    });
}
