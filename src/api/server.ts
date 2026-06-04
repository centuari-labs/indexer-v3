import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { registry } from "../observability/metrics.js";
import { registerHealthRoutes } from "./routes/health.js";

export interface BuildServerOptions {
    /**
     * Dedicated tiny pg pool for `/health` (M4). Kept separate from the shared
     * 10-connection indexer pool so a burst of health/metrics scrapes can never
     * starve the chain watchers of connections.
     */
    healthPool: Pool;
}

/**
 * Per-IP request ceiling for the ops surface (M4). The ops endpoints are
 * internal-only (`/health`, `/metrics`) and scraped on a fixed cadence; this is
 * purely a guard against a misconfigured scraper or an exposed port hammering
 * the process.
 */
const RATE_LIMIT_MAX = 120;
const RATE_LIMIT_WINDOW = "1 minute";

export async function buildServer(
    opts: BuildServerOptions,
): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });

    await app.register(rateLimit, {
        max: RATE_LIMIT_MAX,
        timeWindow: RATE_LIMIT_WINDOW,
    });

    app.get("/metrics", async (_req, reply) => {
        reply.header("Content-Type", registry.contentType);
        return registry.metrics();
    });

    await registerHealthRoutes(app, opts.healthPool);

    return app;
}
