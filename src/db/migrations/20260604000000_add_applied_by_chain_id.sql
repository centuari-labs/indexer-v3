-- +goose Up
-- ============================================================================
-- C1 — chain-scope stamped rows for reorg eviction.
--
-- `applied_by_block_number` is PER CHAIN; block heights overlap across the hub
-- (Arbitrum) and the 4 spokes. Before this change, indexer-v3's `rewindTo`
-- deleted every stamped row with `applied_by_block_number > forkPoint` with NO
-- chain scope, so a spoke reorg evicted unrelated hub rows at the same numeric
-- height. Adding `applied_by_chain_id` and scoping every delete by it isolates
-- a reorg to the chain that actually forked.
--
-- MIGRATION AUTHORITY NOTE: backend-v2 is the single migration authority for the
-- shared Postgres database (see backend-v2/CLAUDE.md). indexer-v3 no longer runs
-- migrations at boot. This file is the CANONICAL SQL that backend-v2 must adopt
-- (copy into backend-v2/src/core/database/migrations/ with a goose-ordered
-- timestamp). Until it ships there, indexer-v3 applies the same change
-- idempotently at boot via `ensureChainIdColumns()` in src/core/chain-scope.ts —
-- which is a no-op once this migration runs. The two are intentionally
-- equivalent: `ADD COLUMN IF NOT EXISTS` + SET DEFAULT + backfill.
--
-- Backfill value: the hub chain id (421614 — Arbitrum Sepolia). Only the hub
-- watcher has ever run (hub-only launch), so every existing stamped row is a
-- hub row. The DB DEFAULT also makes future eager-path inserts (backend-v2,
-- settlement-engine, sweeper-bot — all hub-only writers) chain-scoped without
-- those writers having to set the column.
--
-- Idempotent: re-running is a no-op (IF NOT EXISTS guards + WHERE IS NULL
-- backfill + IF NOT EXISTS index).
-- ============================================================================

-- One block per table keeps the statements grouped and readable.

ALTER TABLE user_balance        ADD COLUMN IF NOT EXISTS applied_by_chain_id BIGINT;
ALTER TABLE user_balance        ALTER COLUMN applied_by_chain_id SET DEFAULT 421614;
UPDATE user_balance        SET applied_by_chain_id = 421614 WHERE applied_by_chain_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_user_balance_applied_chain        ON user_balance        (applied_by_chain_id, applied_by_block_number);

ALTER TABLE withdrawal_request  ADD COLUMN IF NOT EXISTS applied_by_chain_id BIGINT;
ALTER TABLE withdrawal_request  ALTER COLUMN applied_by_chain_id SET DEFAULT 421614;
UPDATE withdrawal_request  SET applied_by_chain_id = 421614 WHERE applied_by_chain_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_withdrawal_request_applied_chain  ON withdrawal_request  (applied_by_chain_id, applied_by_block_number);

ALTER TABLE cross_chain_deposit ADD COLUMN IF NOT EXISTS applied_by_chain_id BIGINT;
ALTER TABLE cross_chain_deposit ALTER COLUMN applied_by_chain_id SET DEFAULT 421614;
UPDATE cross_chain_deposit SET applied_by_chain_id = 421614 WHERE applied_by_chain_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_cross_chain_deposit_applied_chain ON cross_chain_deposit (applied_by_chain_id, applied_by_block_number);

ALTER TABLE chain_liquidity     ADD COLUMN IF NOT EXISTS applied_by_chain_id BIGINT;
ALTER TABLE chain_liquidity     ALTER COLUMN applied_by_chain_id SET DEFAULT 421614;
UPDATE chain_liquidity     SET applied_by_chain_id = 421614 WHERE applied_by_chain_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_chain_liquidity_applied_chain     ON chain_liquidity     (applied_by_chain_id, applied_by_block_number);

ALTER TABLE market              ADD COLUMN IF NOT EXISTS applied_by_chain_id BIGINT;
ALTER TABLE market              ALTER COLUMN applied_by_chain_id SET DEFAULT 421614;
UPDATE market              SET applied_by_chain_id = 421614 WHERE applied_by_chain_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_market_applied_chain              ON market              (applied_by_chain_id, applied_by_block_number);

ALTER TABLE borrow_position     ADD COLUMN IF NOT EXISTS applied_by_chain_id BIGINT;
ALTER TABLE borrow_position     ALTER COLUMN applied_by_chain_id SET DEFAULT 421614;
UPDATE borrow_position     SET applied_by_chain_id = 421614 WHERE applied_by_chain_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_borrow_position_applied_chain     ON borrow_position     (applied_by_chain_id, applied_by_block_number);

ALTER TABLE lend_position       ADD COLUMN IF NOT EXISTS applied_by_chain_id BIGINT;
ALTER TABLE lend_position       ALTER COLUMN applied_by_chain_id SET DEFAULT 421614;
UPDATE lend_position       SET applied_by_chain_id = 421614 WHERE applied_by_chain_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_lend_position_applied_chain       ON lend_position       (applied_by_chain_id, applied_by_block_number);

ALTER TABLE liquidation_event   ADD COLUMN IF NOT EXISTS applied_by_chain_id BIGINT;
ALTER TABLE liquidation_event   ALTER COLUMN applied_by_chain_id SET DEFAULT 421614;
UPDATE liquidation_event   SET applied_by_chain_id = 421614 WHERE applied_by_chain_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_liquidation_event_applied_chain   ON liquidation_event   (applied_by_chain_id, applied_by_block_number);

-- +goose Down
DROP INDEX IF EXISTS idx_liquidation_event_applied_chain;
DROP INDEX IF EXISTS idx_lend_position_applied_chain;
DROP INDEX IF EXISTS idx_borrow_position_applied_chain;
DROP INDEX IF EXISTS idx_market_applied_chain;
DROP INDEX IF EXISTS idx_chain_liquidity_applied_chain;
DROP INDEX IF EXISTS idx_cross_chain_deposit_applied_chain;
DROP INDEX IF EXISTS idx_withdrawal_request_applied_chain;
DROP INDEX IF EXISTS idx_user_balance_applied_chain;
ALTER TABLE liquidation_event   DROP COLUMN IF EXISTS applied_by_chain_id;
ALTER TABLE lend_position       DROP COLUMN IF EXISTS applied_by_chain_id;
ALTER TABLE borrow_position     DROP COLUMN IF EXISTS applied_by_chain_id;
ALTER TABLE market              DROP COLUMN IF EXISTS applied_by_chain_id;
ALTER TABLE chain_liquidity     DROP COLUMN IF EXISTS applied_by_chain_id;
ALTER TABLE cross_chain_deposit DROP COLUMN IF EXISTS applied_by_chain_id;
ALTER TABLE withdrawal_request  DROP COLUMN IF EXISTS applied_by_chain_id;
ALTER TABLE user_balance        DROP COLUMN IF EXISTS applied_by_chain_id;
