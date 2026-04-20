-- Centuari position tables. One row per (market, user); principal/debt/cbt roll
-- up across multiple events. All mutable rows carry applied_by_* stamps and
-- participate in reorg eviction via rewindTo.

CREATE TABLE IF NOT EXISTS market (
    market_id               BYTEA PRIMARY KEY,
    loan_token              BYTEA NOT NULL,
    maturity                BIGINT NOT NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_by_tx_hash      BYTEA,
    applied_by_log_index    INT,
    applied_by_block_hash   BYTEA,
    applied_by_block_number BIGINT
);
CREATE INDEX IF NOT EXISTS idx_market_loan_token_maturity
    ON market (loan_token, maturity);

CREATE TABLE IF NOT EXISTS borrow_position (
    market_id               BYTEA NOT NULL,
    borrower                BYTEA NOT NULL,
    principal               NUMERIC(78, 0) NOT NULL DEFAULT 0,
    debt                    NUMERIC(78, 0) NOT NULL DEFAULT 0,
    rate                    NUMERIC(78, 0) NOT NULL DEFAULT 0,
    applied_by_tx_hash      BYTEA,
    applied_by_log_index    INT,
    applied_by_block_hash   BYTEA,
    applied_by_block_number BIGINT,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (market_id, borrower)
);
CREATE INDEX IF NOT EXISTS idx_borrow_position_borrower
    ON borrow_position (borrower)
    WHERE debt > 0;

CREATE TABLE IF NOT EXISTS lend_position (
    market_id               BYTEA NOT NULL,
    lender                  BYTEA NOT NULL,
    bond_token              BYTEA NOT NULL,
    cbt_balance             NUMERIC(78, 0) NOT NULL DEFAULT 0,
    principal               NUMERIC(78, 0) NOT NULL DEFAULT 0,
    rate                    NUMERIC(78, 0) NOT NULL DEFAULT 0,
    applied_by_tx_hash      BYTEA,
    applied_by_log_index    INT,
    applied_by_block_hash   BYTEA,
    applied_by_block_number BIGINT,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (market_id, lender)
);
CREATE INDEX IF NOT EXISTS idx_lend_position_lender
    ON lend_position (lender)
    WHERE cbt_balance > 0;
