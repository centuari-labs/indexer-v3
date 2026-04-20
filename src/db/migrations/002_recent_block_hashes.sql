-- Rolling per-chain buffer of committed block hashes.
-- Used by reorg-detector.ts to binary-walk back to a fork point: on cursor
-- divergence we load the last (finalityDepth + 1) rows for the chain, compare
-- each persisted block_hash against the live chain, and the highest match is
-- the fork point. rewindTo evicts rows with block_number > fork_point.
-- Pruned inside chain-watcher.processRange once block_number drops below
-- (committed_block - finalityDepth * 2), so size stays O(finalityDepth) per chain.

CREATE TABLE IF NOT EXISTS recent_block_hashes (
    chain_id     INT    NOT NULL,
    block_number BIGINT NOT NULL,
    block_hash   BYTEA  NOT NULL,
    inserted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, block_number)
);

CREATE INDEX IF NOT EXISTS idx_recent_block_hashes_chain_block
    ON recent_block_hashes (chain_id, block_number DESC);
