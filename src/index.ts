import path from "node:path";
import dotenv from "dotenv";

// Load .env.contracts FIRST so its keys win over .env (dotenv only sets
// unset keys by default — first-wins gives priority to the auto-generated
// file synced from smart-contract-revamp/bin/sync-to-services.sh).
dotenv.config({ path: path.resolve(process.cwd(), ".env.contracts") });
dotenv.config();

import type { Address } from "viem";
import { loadConfig } from "./config/env.js";
import type { ChainConfig } from "./config/chains.js";
import { createPool, createSmallPool } from "./db/pool.js";
import { createLogger } from "./observability/logger.js";
import { ChainWatcher, type ContractBinding } from "./core/chain-watcher.js";
import { buildDispatcher } from "./processors/index.js";
import { buildServer } from "./api/server.js";

/**
 * M3: bind the unauthenticated ops surface (`/health` + `/metrics`) to loopback
 * in production so it isn't exposed on a routable interface. In dev/test it
 * binds `0.0.0.0` for convenience (docker port-mapping, host curl). Override
 * with `OPS_BIND_HOST` if production needs a specific internal interface.
 */
function opsBindHost(nodeEnv: string): string {
    if (process.env.OPS_BIND_HOST) return process.env.OPS_BIND_HOST;
    return nodeEnv === "production" ? "127.0.0.1" : "0.0.0.0";
}

const log = createLogger("main");

async function main(): Promise<void> {
    const cfg = loadConfig();
    log.info(
        { hubOnly: cfg.hubOnly, chains: cfg.chains.map((c) => c.key) },
        cfg.hubOnly
            ? "hub-only mode — spoke watchers disabled"
            : "multi-chain mode — hub + spokes",
    );
    const pool = createPool(cfg.databaseUrl);
    // M4: a dedicated tiny pool for /health so ops scrapes can't exhaust the
    // shared watcher pool.
    const healthPool = createSmallPool(cfg.databaseUrl);

    // Schema is owned and migrated by backend-v2 (the single migration
    // authority for the shared Postgres database). backend-v2 `pnpm run migrate`
    // MUST run before this service starts. This includes the C1
    // `applied_by_chain_id` column on the stamped tables, which `rewindTo` and
    // `stampChainIdForBlock` rely on for chain-scoped reorg eviction.

    const dispatcher = buildDispatcher();
    const watchers = cfg.chains
        .map((chain) => ({
            chain,
            contracts: bindContracts(chain),
        }))
        .filter((w) => w.contracts.length > 0)
        .map(
            ({ chain, contracts }) =>
                new ChainWatcher({ chain, pool, dispatcher, contracts }),
        );

    for (const w of watchers) void w.start();

    const app = await buildServer({ healthPool });
    const host = opsBindHost(cfg.nodeEnv);
    await app.listen({ host, port: cfg.port });
    log.info({ port: cfg.port, host }, "indexer-v3 listening");

    const shutdown = async (signal: string) => {
        log.info({ signal }, "shutting down");
        for (const w of watchers) w.stop();
        await app.close();
        await healthPool.end();
        await pool.end();
        process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

function bindContracts(chain: ChainConfig): ContractBinding[] {
    const bindings: ContractBinding[] = [];
    const c = chain.contracts;
    const push = (name: string, addr: Address | undefined) => {
        if (addr && addr !== "0x0000000000000000000000000000000000000000") {
            bindings.push({ name, address: addr });
        }
    };
    push("BalanceLedger", c.balanceLedger);
    push("Centuari", c.centuari);
    push("HubDepositor", c.hubDepositor);
    push("HubIntentSettler", c.hubIntentSettler);
    push("WithdrawalRegistry", c.withdrawalRegistry);
    push("SettlementLedger", c.settlementLedger);
    push("CollateralManager", c.collateralManager);
    push("LiquidationEngine", c.liquidationEngine);
    push("SpokeDepositGateway", c.spokeDepositGateway);
    push("SpokeVaultStable", c.spokeVaultStable);
    return bindings;
}

export { main };

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((err) => {
        log.error({ err }, "fatal startup error");
        process.exit(1);
    });
}
