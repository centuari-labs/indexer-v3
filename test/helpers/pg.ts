import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { newDb } from "pg-mem";
import type { Pool } from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "..", "src", "db", "migrations");

/**
 * Boots an in-memory Postgres (pg-mem), applies the real migrations from
 * src/db/migrations, and returns a node-pg compatible Pool.
 *
 * Use this for processor unit tests so SQL runs for real (ON CONFLICT,
 * BYTEA round-trips, NUMERIC arithmetic) without a Docker dependency.
 */
export async function createTestPool(): Promise<Pool> {
    const db = newDb({
        autoCreateForeignKeyIndices: true,
        noAstCoverageCheck: true,
    });

    const { Pool } = db.adapters.createPg();
    const pool = new Pool() as unknown as Pool;

    await applyMigrations(pool);
    return pool;
}

export async function applyMigrations(pool: Pool): Promise<void> {
    const files = (await readdir(MIGRATIONS_DIR))
        .filter((f) => f.endsWith(".sql"))
        .sort();

    const client = await pool.connect();
    try {
        await client.query(
            `CREATE TABLE IF NOT EXISTS schema_migrations (
                name       TEXT PRIMARY KEY,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )`,
        );
        for (const file of files) {
            const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
            await client.query("BEGIN");
            try {
                await client.query(sql);
                await client.query(
                    "INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING",
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
