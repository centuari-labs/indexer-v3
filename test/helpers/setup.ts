import path from "node:path";
import dotenv from "dotenv";

// Load .env.contracts FIRST so its keys win over .env (dotenv only sets
// unset keys by default — first-wins gives priority to the auto-generated
// file synced from smart-contract-revamp/bin/sync-to-services.sh).
dotenv.config({ path: path.resolve(process.cwd(), ".env.contracts") });
dotenv.config();

// Default to silent for the indexer's Pino loggers in tests so the suite output
// isn't flooded with structured logs from intentionally-exercised processors.
// Override with LOG_LEVEL=debug pnpm test when debugging a specific test.
if (!process.env.LOG_LEVEL) {
    process.env.LOG_LEVEL = "silent";
}
