import { newDb } from "pg-mem";
import type { Pool, PoolClient } from "pg";
import { STAMPED_TABLES } from "../../src/core/stamped-tables.js";

/**
 * Build a pg-mem-backed Pool with the minimal stamped-table schema the C1
 * reorg-eviction tests need. Each stamped table gets the columns `rewindTo` /
 * `stampChainIdForBlock` touch, plus `recent_block_hashes` + `deposit_event`
 * for the full rewind path.
 *
 * The columns are a deliberate SUBSET of the real backend-v2 genesis schema —
 * just enough to exercise the chain-scoped delete and the chain-id stamping
 * without dragging in BYTEA/NUMERIC quirks for unrelated columns.
 */
export function createMemPool(): { pool: Pool } {
    const db = newDb();
    const { Pool: MemPool } = db.adapters.createPg();
    const pool = new MemPool() as unknown as Pool;
    return { pool };
}

export async function initStampedSchema(
    client: Pool | PoolClient,
): Promise<void> {
    for (const table of STAMPED_TABLES) {
        await client.query(
            `CREATE TABLE ${table} (
                pk                       text,
                applied_by_block_number  bigint,
                applied_by_block_hash    bytea,
                applied_by_chain_id      bigint
            )`,
        );
    }
    await client.query(
        `CREATE TABLE recent_block_hashes (
            chain_id     integer,
            block_number bigint,
            block_hash   bytea
        )`,
    );
    await client.query(
        `CREATE TABLE deposit_event (
            chain_id     integer,
            block_number bigint
        )`,
    );
    await client.query(
        `CREATE TABLE block_cursor (
            chain_id         integer PRIMARY KEY,
            last_block       bigint,
            last_block_hash  bytea,
            updated_at       timestamptz
        )`,
    );
}
