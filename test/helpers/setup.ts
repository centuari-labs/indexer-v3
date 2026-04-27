// Default to silent for the indexer's Pino loggers in tests so the suite output
// isn't flooded with structured logs from intentionally-exercised processors.
// Override with LOG_LEVEL=debug pnpm test when debugging a specific test.
if (!process.env.LOG_LEVEL) {
    process.env.LOG_LEVEL = "silent";
}
