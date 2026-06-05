/**
 * Single source of truth for the stamped on-chain-state tables and the
 * chain-scoping invariant used by reorg eviction (C1).
 *
 * Every table here carries the four C10 idempotency stamps
 * (`applied_by_tx_hash` / `applied_by_log_index` / `applied_by_block_hash` /
 * `applied_by_block_number`) PLUS — as of the C1 security fix — an
 * `applied_by_chain_id` discriminator.
 *
 * WHY `applied_by_chain_id` exists
 * --------------------------------
 * `applied_by_block_number` is *per chain*; block heights overlap across the
 * hub and the four spokes. Before C1, `rewindTo` deleted every stamped row with
 * `applied_by_block_number > forkPoint` with NO chain scope, so a spoke reorg
 * at (say) block 5,000,000 wiped unrelated hub rows at hub-block 5,000,001+.
 * Adding the chain id to every delete's WHERE makes a reorg on one chain evict
 * only that chain's rows.
 *
 * WHO owns the column vs. WHO populates it
 * -----------------------------------------
 * The column itself — `ADD COLUMN applied_by_chain_id`, its hub-chain-id
 * DEFAULT, the pre-C1 backfill, and the index — is created by a backend-v2
 * migration. backend-v2 is the single migration authority for the shared
 * Postgres schema; this service runs NO DDL (`backend-v2 pnpm run migrate` must
 * run before indexer-v3 starts).
 *
 * This service only populates the column at runtime. The per-event upsert SQL
 * lives in the external `@centuari-labs/on-chain-effects` package, which this
 * service cannot edit and which does NOT write `applied_by_chain_id`. The
 * indexer therefore stamps the column itself, on its OWN write path: after
 * dispatching every log for a block, `chain-watcher` stamps
 * `applied_by_chain_id = <chainId>` on exactly the rows that block wrote
 * (scoped by the globally-unique `applied_by_block_hash`). Eager-path writers
 * (backend-v2, settlement-engine, sweeper-bot) write only HUB rows, so the
 * column's DB default (the hub chain id) covers their inserts correctly. See
 * `chain-scope.ts`.
 */

/**
 * Hub chain id (Arbitrum Sepolia). Mirrors the value the backend-v2 migration
 * uses as the column DEFAULT and pre-C1 backfill; kept here as the canonical
 * named reference for the hub discriminator.
 */
export const DEFAULT_HUB_CHAIN_ID = 421614;

/** Column name carrying the source-chain discriminator on stamped rows. */
export const APPLIED_BY_CHAIN_ID = "applied_by_chain_id";

/**
 * Every stamped table that participates in reorg eviction. These all carry
 * `applied_by_block_number` and (post-C1) `applied_by_chain_id`. `deposit_event`
 * is handled separately in `rewindTo` — it is append-only and keyed by a native
 * `chain_id` column rather than `applied_by_*`.
 */
export const STAMPED_TABLES: readonly string[] = [
    "user_balance",
    "withdrawal_request",
    "cross_chain_deposit",
    "chain_liquidity",
    "market",
    "borrow_position",
    "lend_position",
    "liquidation_event",
] as const;
