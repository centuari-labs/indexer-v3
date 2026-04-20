import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import { createLogger } from "../observability/logger.js";
import { loadConfig } from "../config/env.js";
import { createPool } from "./pool.js";

const log = createLogger("migrator");

export async function runMigrations(
    pool: Pool,
    migrationsDir?: string,
): Promise<void> {
    const dir = migrationsDir ?? defaultMigrationsDir();
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

    const client = await pool.connect();
    try {
        await ensureMigrationsTable(client);
        for (const file of files) {
            const already = await client.query<{ name: string }>(
                "SELECT name FROM schema_migrations WHERE name = $1",
                [file],
            );
            if (already.rowCount && already.rowCount > 0) {
                log.debug({ file }, "migration already applied, skipping");
                continue;
            }
            const sql = await readFile(join(dir, file), "utf8");
            log.info({ file }, "applying migration");
            await client.query("BEGIN");
            try {
                await client.query(sql);
                await client.query(
                    "INSERT INTO schema_migrations (name) VALUES ($1)",
                    [file],
                );
                await client.query("COMMIT");
            } catch (err) {
                await client.query("ROLLBACK");
                throw err;
            }
        }
    } finally {
        client.release();
    }
}

async function ensureMigrationsTable(client: PoolClient): Promise<void> {
    await client.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
            name       TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
    );
}

function defaultMigrationsDir(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, "migrations");
}

// CLI entry: `pnpm run migrate`
if (import.meta.url === `file://${process.argv[1]}`) {
    const cfg = loadConfig();
    const pool = createPool(cfg.databaseUrl);
    runMigrations(pool)
        .then(() => log.info("migrations complete"))
        .catch((err) => {
            log.error({ err }, "migration failed");
            process.exitCode = 1;
        })
        .finally(() => pool.end());
}
