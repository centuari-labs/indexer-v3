-- indexer-v3 Phase 1 schema.
-- All timestamps TIMESTAMPTZ; addresses + hashes BYTEA; token amounts NUMERIC(78,0).
-- Every mutable row namespaces a C10 idempotency stamp (applied_by_*).

CREATE TABLE IF NOT EXISTS block_cursor (
    chain_id          INT PRIMARY KEY,
    last_block        BIGINT NOT NULL,
    last_block_hash   BYTEA NOT NULL,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_balance (
    user_address            BYTEA NOT NULL,
    asset                   BYTEA NOT NULL,
    available               NUMERIC(78, 0) NOT NULL DEFAULT 0,
    in_orders               NUMERIC(78, 0) NOT NULL DEFAULT 0,
    in_yield_router         NUMERIC(78, 0) NOT NULL DEFAULT 0,
    used_as_collateral      BOOLEAN NOT NULL DEFAULT false,
    flagged_at              BIGINT NOT NULL DEFAULT 0,
    applied_by_tx_hash      BYTEA,
    applied_by_log_index    INT,
    applied_by_block_hash   BYTEA,
    applied_by_block_number BIGINT,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_address, asset)
);

CREATE INDEX IF NOT EXISTS idx_user_balance_flagged
    ON user_balance (user_address)
    WHERE used_as_collateral = true;

CREATE TABLE IF NOT EXISTS deposit_event (
    id                BIGSERIAL PRIMARY KEY,
    chain_id          INT NOT NULL,
    user_address      BYTEA NOT NULL,
    asset             BYTEA NOT NULL,
    amount            NUMERIC(78, 0) NOT NULL,
    source_chain      INT NOT NULL,
    tx_hash           BYTEA NOT NULL,
    block_number      BIGINT NOT NULL,
    block_hash        BYTEA NOT NULL,
    log_index         INT NOT NULL,
    timestamp         TIMESTAMPTZ NOT NULL,
    UNIQUE (tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS idx_deposit_event_user
    ON deposit_event (user_address);

CREATE TABLE IF NOT EXISTS withdrawal_request (
    request_id              BYTEA PRIMARY KEY,
    user_address            BYTEA NOT NULL,
    asset                   BYTEA NOT NULL,
    amount                  NUMERIC(78, 0) NOT NULL,
    target_chain            INT NOT NULL,
    state                   TEXT NOT NULL,
    created_at              TIMESTAMPTZ NOT NULL,
    updated_at              TIMESTAMPTZ NOT NULL,
    completed_at            TIMESTAMPTZ,
    applied_by_tx_hash      BYTEA,
    applied_by_log_index    INT,
    applied_by_block_hash   BYTEA,
    applied_by_block_number BIGINT
);

CREATE INDEX IF NOT EXISTS idx_withdrawal_user_state
    ON withdrawal_request (user_address, state);

CREATE TABLE IF NOT EXISTS cross_chain_deposit (
    deposit_id              BYTEA PRIMARY KEY,
    user_address            BYTEA NOT NULL,
    source_chain            INT NOT NULL,
    asset                   BYTEA NOT NULL,
    amount                  NUMERIC(78, 0) NOT NULL,
    custody_type            TEXT NOT NULL,
    state                   TEXT NOT NULL,
    initiated_at            TIMESTAMPTZ NOT NULL,
    credited_at             TIMESTAMPTZ,
    bridged_at              TIMESTAMPTZ,
    applied_by_tx_hash      BYTEA,
    applied_by_log_index    INT,
    applied_by_block_hash   BYTEA,
    applied_by_block_number BIGINT
);

CREATE INDEX IF NOT EXISTS idx_crosschain_user_state
    ON cross_chain_deposit (user_address, state);

CREATE TABLE IF NOT EXISTS bond_token (
    address      BYTEA PRIMARY KEY,
    asset        BYTEA NOT NULL,
    maturity     BIGINT NOT NULL,
    total_supply NUMERIC(78, 0) NOT NULL DEFAULT 0
);

-- SPOKE_NATIVE per-chain rollup (§C11). Hooks only in Phase 1.
CREATE TABLE IF NOT EXISTS chain_liquidity (
    token                   BYTEA NOT NULL,
    chain_id                INT NOT NULL,
    amount                  NUMERIC(78, 0) NOT NULL DEFAULT 0,
    applied_by_tx_hash      BYTEA,
    applied_by_log_index    INT,
    applied_by_block_hash   BYTEA,
    applied_by_block_number BIGINT,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (token, chain_id)
);

-- Migration bookkeeping.
CREATE TABLE IF NOT EXISTS schema_migrations (
    name       TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
