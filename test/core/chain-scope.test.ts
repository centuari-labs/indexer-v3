import type { Pool } from "pg";
import { rewindTo } from "../../src/core/block-cursor.js";
import { stampChainIdForBlock } from "../../src/core/chain-scope.js";
import { STAMPED_TABLES } from "../../src/core/stamped-tables.js";
import { hexToBytea } from "../../src/db/bytea.js";
import { FakePoolClient, asPoolClient } from "../helpers/fake-client.js";
import { createMemPool, initStampedSchema } from "../helpers/pgmem.js";

const HUB = 421614;
const SPOKE_BASE = 84532;

const HASH = (n: number): `0x${string}` =>
    `0x${n.toString(16).padStart(2, "0").repeat(32)}`;

describe("C1 — chain-scoped reorg eviction", () => {
    let pool: Pool;

    beforeEach(async () => {
        ({ pool } = createMemPool());
        await initStampedSchema(pool);
    });

    afterEach(async () => {
        await pool.end();
    });

    test("a spoke rewind does NOT delete hub rows at the same block height", async () => {
        const client = await pool.connect();
        try {
            // Hub rows written at hub-blocks 200 + 201.
            await client.query(
                `INSERT INTO user_balance (pk, applied_by_block_number, applied_by_block_hash, applied_by_chain_id)
                 VALUES ('hub-200', 200, $1, $2), ('hub-201', 201, $3, $2)`,
                [hexToBytea(HASH(0xa0)), HUB, hexToBytea(HASH(0xa1))],
            );
            // Spoke rows written at spoke-blocks 200 + 201 (heights collide).
            await client.query(
                `INSERT INTO user_balance (pk, applied_by_block_number, applied_by_block_hash, applied_by_chain_id)
                 VALUES ('spoke-200', 200, $1, $2), ('spoke-201', 201, $3, $2)`,
                [hexToBytea(HASH(0xb0)), SPOKE_BASE, hexToBytea(HASH(0xb1))],
            );

            // Spoke reorg: rewind the spoke to block 199 (delete spoke rows > 199).
            await rewindTo(client, SPOKE_BASE, 199n, HASH(0xbf));

            const rows = await client.query<{ pk: string }>(
                "SELECT pk FROM user_balance ORDER BY pk",
            );
            const pks = rows.rows.map((r) => r.pk).sort();
            // Both hub rows survive; both spoke rows are evicted.
            expect(pks).toEqual(["hub-200", "hub-201"]);
        } finally {
            client.release();
        }
    });

    test("a hub rewind deletes only hub rows beyond the fork point", async () => {
        const client = await pool.connect();
        try {
            await client.query(
                `INSERT INTO user_balance (pk, applied_by_block_number, applied_by_block_hash, applied_by_chain_id)
                 VALUES ('hub-100', 100, $1, $3), ('hub-105', 105, $2, $3)`,
                [hexToBytea(HASH(0x10)), hexToBytea(HASH(0x15)), HUB],
            );
            await client.query(
                `INSERT INTO user_balance (pk, applied_by_block_number, applied_by_block_hash, applied_by_chain_id)
                 VALUES ('spoke-105', 105, $1, $2)`,
                [hexToBytea(HASH(0xc5)), SPOKE_BASE],
            );

            await rewindTo(client, HUB, 100n, HASH(0x10));

            const rows = await client.query<{ pk: string }>(
                "SELECT pk FROM user_balance ORDER BY pk",
            );
            const pks = rows.rows.map((r) => r.pk).sort();
            // hub-105 evicted (> 100, hub); hub-100 kept (== fork); spoke kept.
            expect(pks).toEqual(["hub-100", "spoke-105"]);
        } finally {
            client.release();
        }
    });

    // NOTE: stampChainIdForBlock scopes by `applied_by_block_hash = $blockHash`
    // (BYTEA). pg-mem cannot model parameterized BYTEA equality (it matches all
    // rows), so the row-level scoping is asserted at the SQL/param level with the
    // recording fake instead — the block-hash bytea is bound as a parameter and
    // the predicate is correct against real Postgres.
    test("stampChainIdForBlock updates every stamped table, scoped by block hash + chain id", async () => {
        const fake = new FakePoolClient();
        const blockHash = hexToBytea(HASH(0xd0));
        await stampChainIdForBlock(asPoolClient(fake), HUB, blockHash);

        for (const table of STAMPED_TABLES) {
            const upd = fake.findBySqlContains(`UPDATE ${table}`);
            expect(upd).toBeDefined();
            expect(upd!.sql).toContain("SET applied_by_chain_id = $1");
            expect(upd!.sql).toContain("WHERE applied_by_block_hash = $2");
            expect(upd!.params[0]).toBe(HUB);
            expect(upd!.params[1]).toEqual(blockHash);
        }
    });
});

describe("ensureChainIdColumns — C1 boot safety net", () => {
    test("adds the column, sets hub default + backfills, and is idempotent", async () => {
        const { pool } = createMemPool();
        // Schema WITHOUT applied_by_chain_id, plus a pre-existing (pre-C1) row.
        await pool.query(
            `CREATE TABLE user_balance (
                pk                       text,
                applied_by_block_number  bigint,
                applied_by_block_hash    bytea
            )`,
        );
        // Only create the one table we assert on; the helper iterates all
        // STAMPED_TABLES, so create the rest as empties to satisfy the loop.
        for (const table of STAMPED_TABLES) {
            if (table === "user_balance") continue;
            await pool.query(
                `CREATE TABLE ${table} (
                    applied_by_block_number  bigint,
                    applied_by_block_hash    bytea
                )`,
            );
        }
        await pool.query(
            "INSERT INTO user_balance (pk, applied_by_block_number) VALUES ('old', 50)",
        );

        const { ensureChainIdColumns } = await import(
            "../../src/core/chain-scope.js"
        );
        await ensureChainIdColumns(pool);
        // Running twice must be a no-op (IF NOT EXISTS + WHERE IS NULL).
        await ensureChainIdColumns(pool);

        // Pre-existing row backfilled to hub.
        const backfilled = await pool.query<{ applied_by_chain_id: string }>(
            "SELECT applied_by_chain_id FROM user_balance WHERE pk = 'old'",
        );
        expect(Number(backfilled.rows[0]?.applied_by_chain_id)).toBe(HUB);

        // New eager-path insert that omits the column gets the hub default.
        await pool.query(
            "INSERT INTO user_balance (pk, applied_by_block_number) VALUES ('new', 60)",
        );
        const defaulted = await pool.query<{ applied_by_chain_id: string }>(
            "SELECT applied_by_chain_id FROM user_balance WHERE pk = 'new'",
        );
        expect(Number(defaulted.rows[0]?.applied_by_chain_id)).toBe(HUB);

        await pool.end();
    });
});
