import type { Pool, PoolClient } from "pg";
import { createLogger } from "../observability/logger.js";
import {
    APPLIED_BY_CHAIN_ID,
    DEFAULT_HUB_CHAIN_ID,
    STAMPED_TABLES,
} from "./stamped-tables.js";

const log = createLogger("chain-scope");

/**
 * C1 — chain-scope stamped rows so a reorg on one chain cannot evict another
 * chain's rows.
 *
 * The canonical schema change lives in a backend-v2 migration (backend-v2 is
 * the single migration authority — see `src/db/migrations/` artifact in this
 * service for the SQL that backend-v2 must adopt). This function is an
 * idempotent, self-contained boot-time SAFETY NET so indexer-v3 is correct even
 * before that migration is deployed: it adds the column, sets the hub default,
 * and backfills existing rows to the hub. Every statement is `IF NOT EXISTS` /
 * value-guarded, so running it repeatedly — or alongside the backend migration
 * — is a no-op.
 *
 * `table` names come exclusively from the `STAMPED_TABLES` constant (never user
 * input), so the identifier interpolation here is safe.
 */
export async function ensureChainIdColumns(pool: Pool): Promise<void> {
    const client = await pool.connect();
    try {
        for (const table of STAMPED_TABLES) {
            await client.query(
                `ALTER TABLE ${table}
                   ADD COLUMN IF NOT EXISTS ${APPLIED_BY_CHAIN_ID} BIGINT`,
            );
            // Default future eager-path (hub-only) inserts to the hub chain id.
            await client.query(
                `ALTER TABLE ${table}
                   ALTER COLUMN ${APPLIED_BY_CHAIN_ID} SET DEFAULT $1`,
                [DEFAULT_HUB_CHAIN_ID],
            );
            // Backfill pre-C1 rows to the hub — only the hub watcher has run.
            await client.query(
                `UPDATE ${table}
                    SET ${APPLIED_BY_CHAIN_ID} = $1
                  WHERE ${APPLIED_BY_CHAIN_ID} IS NULL`,
                [DEFAULT_HUB_CHAIN_ID],
            );
            await client.query(
                `CREATE INDEX IF NOT EXISTS idx_${table}_applied_chain
                   ON ${table} (${APPLIED_BY_CHAIN_ID}, applied_by_block_number)`,
            );
        }
        log.info(
            { tables: STAMPED_TABLES.length },
            "ensured applied_by_chain_id on stamped tables",
        );
    } finally {
        client.release();
    }
}

/**
 * Stamp `applied_by_chain_id = chainId` onto every stamped row that the just-
 * processed block wrote. Scoped by `applied_by_block_hash`, which is globally
 * unique per chain — so this touches ONLY rows written for this exact block and
 * never reaches another chain's rows even when block numbers collide.
 *
 * Runs inside the caller's per-block transaction (same `pgClient`,
 * BEGIN/COMMIT owned by the caller) so the chain stamp is atomic with the
 * entity writes and the cursor advance.
 */
export async function stampChainIdForBlock(
    client: PoolClient,
    chainId: number,
    blockHashBytea: Buffer,
): Promise<void> {
    for (const table of STAMPED_TABLES) {
        await client.query(
            `UPDATE ${table}
                SET ${APPLIED_BY_CHAIN_ID} = $1
              WHERE applied_by_block_hash = $2`,
            [chainId, blockHashBytea],
        );
    }
}
