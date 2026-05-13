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
import { createPool } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import { createLogger } from "./observability/logger.js";
import { ChainWatcher, type ContractBinding } from "./core/chain-watcher.js";
import { buildDispatcher } from "./processors/index.js";
import { buildServer } from "./api/server.js";

const log = createLogger("main");

async function main(): Promise<void> {
    const cfg = loadConfig();
    const pool = createPool(cfg.databaseUrl);

    log.info("running migrations");
    await runMigrations(pool);

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

    const app = await buildServer({ pool });
    await app.listen({ host: "0.0.0.0", port: cfg.port });
    log.info({ port: cfg.port }, "indexer-v3 listening");

    const shutdown = async (signal: string) => {
        log.info({ signal }, "shutting down");
        for (const w of watchers) w.stop();
        await app.close();
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
