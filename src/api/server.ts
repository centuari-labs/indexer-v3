import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { registry } from "../observability/metrics.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerBalanceRoutes } from "./routes/balance.js";
import { registerPortfolioRoutes } from "./routes/portfolio.js";
import { registerCollateralRoutes } from "./routes/collateral.js";
import { registerDepositsRoutes } from "./routes/deposits.js";
import { registerWithdrawalsRoutes } from "./routes/withdrawals.js";

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
    await registerBalanceRoutes(app, opts.pool);
    await registerPortfolioRoutes(app, opts.pool);
    await registerCollateralRoutes(app, opts.pool);
    await registerDepositsRoutes(app, opts.pool);
    await registerWithdrawalsRoutes(app, opts.pool);

    return app;
}
