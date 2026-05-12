import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { registry } from "../observability/metrics.js";
import { registerHealthRoutes } from "./routes/health.js";

export interface BuildServerOptions {
    pool: Pool;
}

export async function buildServer(
    opts: BuildServerOptions,
): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });

    app.get("/metrics", async (_req, reply) => {
        reply.header("Content-Type", registry.contentType);
        return registry.metrics();
    });

    await registerHealthRoutes(app, opts.pool);

    return app;
}
