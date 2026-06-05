import type { PoolClient } from "pg";
import { APPLIED_BY_CHAIN_ID, STAMPED_TABLES } from "./stamped-tables.js";

/**
 * C1 — chain-scope stamped rows so a reorg on one chain cannot evict another
 * chain's rows.
 *
 * The `applied_by_chain_id` column itself is created by a backend-v2 migration
 * (backend-v2 is the single migration authority for the shared Postgres
 * schema). This module owns only the RUNTIME behaviour: stamping the column on
 * the rows this service writes, so `rewindTo` can scope deletes by source chain.
 */

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
