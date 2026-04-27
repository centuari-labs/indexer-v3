import type { Pool } from "pg";
import { createTestPool } from "../helpers/pg.js";

describe("migrations 001..004", () => {
    let pool: Pool;

    beforeAll(async () => {
        pool = await createTestPool();
    });

    afterAll(async () => {
        await pool.end();
    });

    test("schema_migrations records all four files in order", async () => {
        const res = await pool.query<{ name: string }>(
            "SELECT name FROM schema_migrations ORDER BY name ASC",
        );
        expect(res.rows.map((r) => r.name)).toEqual([
            "001_init.sql",
            "002_recent_block_hashes.sql",
            "003_deposit_event_kind.sql",
            "004_centuari_positions.sql",
        ]);
    });

    test.each([
        "block_cursor",
        "user_balance",
        "deposit_event",
        "withdrawal_request",
        "cross_chain_deposit",
        "bond_token",
        "chain_liquidity",
        "market",
        "lend_position",
        "borrow_position",
    ])("table %s exists", async (table) => {
        const res = await pool.query<{ exists: boolean }>(
            `SELECT EXISTS (
                SELECT 1 FROM information_schema.tables
                 WHERE table_schema = 'public' AND table_name = $1
            ) AS exists`,
            [table],
        );
        expect(res.rows[0]?.exists).toBe(true);
    });

    test("user_balance has the post-collateral-loophole columns", async () => {
        const res = await pool.query<{ column_name: string }>(
            `SELECT column_name FROM information_schema.columns
              WHERE table_schema='public' AND table_name='user_balance'`,
        );
        const cols = new Set(res.rows.map((r) => r.column_name));
        for (const c of [
            "user_address",
            "asset",
            "available",
            "in_orders",
            "in_yield_router",
            "used_as_collateral",
            "flagged_at",
            "applied_by_tx_hash",
            "applied_by_log_index",
            "applied_by_block_hash",
            "applied_by_block_number",
        ]) {
            expect(cols.has(c)).toBe(true);
        }
    });
});
