import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { registry } from "../observability/metrics.js";
import { registerHealthRoutes } from "./routes/health.js";

export interface BuildServerOptions {
    /**
     * Dedicated tiny pg pool for `/health` (M4). Kept separate from the shared
     * 10-connection indexer pool so a burst of health/metrics scrapes can never
     * starve the chain watchers of connections. Combined with the loopback bind
     * (M3) and the 1s `/health` cache, this is what bounds the ops surface — no
     * request rate-limit is needed for an internal-only, loopback-bound port.
     */
    healthPool: Pool;
}

export async function buildServer(
    opts: BuildServerOptions,
): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });

    app.get("/metrics", async (_req, reply) => {
        reply.header("Content-Type", registry.contentType);
        return registry.metrics();
    });

    await registerHealthRoutes(app, opts.healthPool);

    return app;
}
