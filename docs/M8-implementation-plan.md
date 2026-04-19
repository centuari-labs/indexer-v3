# M8 — indexer-v3 Implementation Plan

**Status:** DRAFT — 2026-04-19
**Source of truth:** `smart-contract-revamp/docs/phase-1-cross-chain-balance-ledger.md` Module 8 (lines 733–900) and `smart-contract-revamp/docs/collateral-loophole-fix-plan.md` P4/P5.
**Repo:** `indexer-v3/` (created, empty except `.git/`).

## Context

M8 is the custom Node.js/TypeScript indexer that replaces the legacy Ponder-based `indexer-v2`. It tails on-chain events from the Arbitrum hub and 4 spokes (Base, Ethereum, BNB, Polygon) and is the canonical read source for every other service. It also ships the shared `applyOnChainEffect` C10 idempotency helper that backend-v2, settlement-engine, and sweeper-bot (M7) import.

M8 is unblocked (M1–M5 done). Starting M8 also lands **P5** (collateral event processor) and **P4** (backend flag/unflag endpoints) inside the same window, because both need the C10 helper and the event processor that only exist once M8 is live.

## Goals (what "done" looks like)

1. `indexer-v3` container runs on `docker-compose up -d` and reaches `GET /health` OK within 30s, with per-chain block-lag < 10s on testnet.
2. All 10 event processors tail testnet and persist to Postgres with C10 idempotency stamps.
3. `POST /collateral/flag` and `POST /collateral/unflag` in backend-v2 work end-to-end using indexer-v3's `applyOnChainEffect` helper (P4 + P5 acceptance).
4. Matching engine reads `GET /balance/:user/:asset` successfully (retires the chain-RPC read path in M9).
5. Reorg handling validated: forced reorg on Arbitrum Sepolia via test harness rolls back affected rows.

## Architecture

```
indexer-v3/
├── src/
│   ├── main.ts                          # entry: boot watchers + HTTP server
│   ├── config/
│   │   ├── env.ts                       # Zod-validated env (DATABASE_URL, per-chain RPC_*, START_BLOCK_*, CONTRACTS_*)
│   │   └── chains.ts                    # chain registry (hub + 4 spokes) with finality depths
│   ├── core/
│   │   ├── chain-watcher.ts             # Viem createPublicClient + watchEvent per chain
│   │   ├── block-cursor.ts              # persists {chainId, lastBlock, lastBlockHash}
│   │   ├── reorg-detector.ts            # compares recent N-block hashes, rolls back
│   │   └── event-dispatcher.ts          # routes decoded logs to processors
│   ├── processors/
│   │   ├── balance-ledger.processor.ts  # Credited, Debited, CollateralFlagSet (5-param)
│   │   ├── centuari.processor.ts        # Order, Match, Repay, BondMint
│   │   ├── hub-depositor.processor.ts   # Deposit, Payout
│   │   ├── hub-intent-settler.processor.ts  # DepositConfirmed
│   │   ├── withdrawal-registry.processor.ts # WithdrawalRequested, WithdrawalStateChanged
│   │   ├── settlement-ledger.processor.ts   # dormant stub, decode-only
│   │   ├── spoke-deposit-gateway.processor.ts # DepositInitiated
│   │   └── spoke-vault.processor.ts     # custody events
│   ├── shared/
│   │   └── apply-on-chain-effect.ts     # C10 helper — exported as npm-linkable package
│   ├── db/
│   │   ├── pool.ts                      # pg Pool
│   │   ├── migrations/001_init.sql      # see schema below
│   │   └── migrate.ts                   # sequential runner (pattern from matching-engine)
│   ├── api/
│   │   ├── server.ts                    # Fastify / Hono (pick one — recommend Hono for consistency with backend)
│   │   └── routes/
│   │       ├── balance.ts
│   │       ├── portfolio.ts
│   │       ├── collateral.ts
│   │       ├── deposits.ts
│   │       ├── withdrawals.ts
│   │       └── health.ts
│   └── observability/
│       ├── logger.ts                    # Pino JSON to stdout
│       └── metrics.ts                   # prom-client on /metrics
├── abi/                                 # copied from smart-contract-revamp/abi/ via export-abi.sh
├── test/
│   ├── unit/
│   └── integration/                     # uses anvil fork + ephemeral Postgres
├── Dockerfile                           # multi-stage node:22-alpine
├── package.json                         # pnpm
├── tsconfig.json                        # ES2020, CommonJS (matches matching-engine)
└── .env.example
```

## Database schema (`migrations/001_init.sql`)

All timestamps `TIMESTAMPTZ`. Namespace idempotency stamps `applied_by_*` across every mutable table.

```sql
CREATE TABLE block_cursor (
  chain_id          INT PRIMARY KEY,
  last_block        BIGINT NOT NULL,
  last_block_hash   BYTEA NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_balance (
  user_address            BYTEA NOT NULL,
  asset                   BYTEA NOT NULL,
  available               NUMERIC(78,0) NOT NULL DEFAULT 0,
  in_orders               NUMERIC(78,0) NOT NULL DEFAULT 0,
  in_yield_router         NUMERIC(78,0) NOT NULL DEFAULT 0,
  used_as_collateral      BOOLEAN NOT NULL DEFAULT false,
  flagged_at              BIGINT NOT NULL DEFAULT 0,
  applied_by_tx_hash      BYTEA,
  applied_by_log_index    INT,
  applied_by_block_hash   BYTEA,
  applied_by_block_number BIGINT,
  PRIMARY KEY (user_address, asset)
);

CREATE TABLE deposit_event (
  id                SERIAL PRIMARY KEY,
  chain_id          INT NOT NULL,
  user_address      BYTEA NOT NULL,
  asset             BYTEA NOT NULL,
  amount            NUMERIC(78,0) NOT NULL,
  source_chain      INT NOT NULL,
  tx_hash           BYTEA NOT NULL,
  block_number      BIGINT NOT NULL,
  block_hash        BYTEA NOT NULL,
  log_index         INT NOT NULL,
  timestamp         TIMESTAMPTZ NOT NULL,
  UNIQUE (tx_hash, log_index)
);

CREATE TABLE withdrawal_request (
  request_id              BYTEA PRIMARY KEY,
  user_address            BYTEA NOT NULL,
  asset                   BYTEA NOT NULL,
  amount                  NUMERIC(78,0) NOT NULL,
  target_chain            INT NOT NULL,
  state                   TEXT NOT NULL,           -- PENDING | PROCESSING | COMPLETED | FAILED
  created_at              TIMESTAMPTZ NOT NULL,
  updated_at              TIMESTAMPTZ NOT NULL,
  completed_at            TIMESTAMPTZ,
  applied_by_tx_hash      BYTEA,
  applied_by_log_index    INT,
  applied_by_block_hash   BYTEA,
  applied_by_block_number BIGINT
);

CREATE TABLE cross_chain_deposit (
  deposit_id              BYTEA PRIMARY KEY,
  user_address            BYTEA NOT NULL,
  source_chain            INT NOT NULL,
  asset                   BYTEA NOT NULL,
  amount                  NUMERIC(78,0) NOT NULL,
  custody_type            TEXT NOT NULL,           -- HUB_NATIVE | SPOKE_NATIVE
  state                   TEXT NOT NULL,           -- INITIATED | CREDITED | BRIDGED | REFUNDED
  initiated_at            TIMESTAMPTZ NOT NULL,
  credited_at             TIMESTAMPTZ,
  bridged_at              TIMESTAMPTZ,
  applied_by_tx_hash      BYTEA,
  applied_by_log_index    INT,
  applied_by_block_hash   BYTEA,
  applied_by_block_number BIGINT
);

CREATE TABLE bond_token (
  address      BYTEA PRIMARY KEY,
  asset        BYTEA NOT NULL,
  maturity     BIGINT NOT NULL,
  total_supply NUMERIC(78,0) NOT NULL DEFAULT 0
);

CREATE INDEX idx_user_balance_flagged ON user_balance (user_address) WHERE used_as_collateral = true;
CREATE INDEX idx_withdrawal_user_state ON withdrawal_request (user_address, state);
CREATE INDEX idx_crosschain_user_state ON cross_chain_deposit (user_address, state);
```

## Critical event shape — `CollateralFlagSet` (5-param)

Decoder MUST match `event CollateralFlagSet(address indexed writer, address indexed user, address indexed asset, bool used, uint64 flaggedAt)`. Source: `src/interfaces/IBalanceLedger.sol`.

- `flaggedAt == 0` on unmark (sentinel).
- Repeat mark does NOT refresh `flaggedAt` (protocol invariant — `test_RepeatedMark_DoesNotExtendLock`).
- Processor writes `used_as_collateral = used`, `flagged_at = flaggedAt` verbatim, then stamps `applied_by_*`.

## `applyOnChainEffect` helper (C10)

Exported from `indexer-v3/src/shared/apply-on-chain-effect.ts`. Signature:

```ts
interface OnChainEffectArgs<T> {
  chainId: number;
  txHash: `0x${string}`;
  expectedEventTopic: `0x${string}`;
  expectedArgsPredicate: (decoded: T) => boolean;
  mutation: (decoded: T, stamp: IdempotencyStamp) => Promise<void>;
}

export async function applyOnChainEffect<T>(args: OnChainEffectArgs<T>): Promise<void>
```

Behavior:
1. Fetch tx receipt; abort if `status != success`.
2. Find the log matching `expectedEventTopic` in the receipt; decode with viem.
3. Assert `expectedArgsPredicate(decoded)` — else abort with `UnexpectedEventArgs`.
4. Inside a DB transaction: run `mutation`, stamp `applied_by_tx_hash / log_index / block_hash / block_number`.
5. Indexer processor for the same event will see `applied_by_tx_hash = txHash` and skip (safety-net idempotency).

Consumers: backend-v2 (`/collateral/flag`, `/collateral/unflag`, deposits, withdrawals), settlement-engine (batch submit), sweeper-bot (M7 bridging).

## REST API

Hono + Zod. JSON only. All reads protected by optional Privy JWT (authoritative list of who owns what goes through backend; indexer is read-only public portfolio data).

| Method | Path | Consumer | Returns |
|---|---|---|---|
| GET | `/health` | docker, ops | `{ chains: [{chainId, blockLag, lastBlock}] }` |
| GET | `/metrics` | prometheus | plain text |
| GET | `/balance/:user` | matching-engine, backend | all assets, 3-state + collateral |
| GET | `/balance/:user/:asset` | matching-engine (hot path) | single-asset 3-state + collateral |
| GET | `/portfolio/:user` | frontend, backend | aggregated view incl. flagged assets + open withdrawals + in-flight deposits |
| GET | `/collateral/:user/:asset` | backend `/collateral/unflag` guard | `{ used, flaggedAt, unlocksAt }` |
| GET | `/deposits/:user` | frontend | list of cross-chain + hub-native deposits |
| GET | `/deposits/:depositId` | frontend polling | single deposit state |
| GET | `/withdrawals/:user` | frontend | withdrawal requests + states |

Latency budget: matching-engine balance read must be sub-ms on the same docker network.

## Multi-chain + reorg handling

- Per chain: `ChainWatcher` with Viem `createPublicClient({ transport: webSocket(..., { reconnect: true }) })`, HTTP fallback via `fallback([webSocket, http])`.
- Finality depths (configurable via env, defaults per chain): Arbitrum 12, Ethereum Sepolia 64, Base/BNB/Polygon 32.
- Every new head: fetch last `N` block hashes; compare against `block_cursor.last_block_hash` trail. On mismatch, binary-search for fork point, DELETE rows WHERE `applied_by_block_hash` beyond fork point, rewind cursor, replay.
- Block cursor + entity updates atomic per block (single pg transaction).

## Implementation order (execute in sequence)

Each step ends with a green test run before moving on.

1. **Scaffold repo** — `pnpm init`, `tsconfig.json` (ES2020/CJS), Dockerfile (node:22-alpine multi-stage), `.env.example`, `package.json` scripts (`dev`, `build`, `start`, `migrate`, `test`).
2. **Config + chains** — `src/config/env.ts` Zod-validated, `src/config/chains.ts` registry.
3. **Logger + metrics** — Pino JSON to stdout, prom-client `/metrics` endpoint skeleton.
4. **DB pool + migration runner** — `pg` Pool, sequential runner from `db/migrations/`. Land `001_init.sql`.
5. **Block cursor + reorg detector** — unit-tested against mocked chain (viem test client).
6. **ChainWatcher skeleton** — connects to one chain, tails blocks, persists cursor.
7. **Event dispatcher + ABI loader** — decodes logs via viem, routes by event topic.
8. **Processor: `balance-ledger.processor.ts`** — implement `Credited`, `Debited`, and **`CollateralFlagSet` (5-param)**. This is the P5 deliverable — test decoder against a live contract emit. Stamp `applied_by_*`.
9. **`applyOnChainEffect` helper** — ship as internal module; export for backend consumption. Unit tests cover: success, tx reverted, event missing, predicate fails, duplicate-call skip.
10. **REST API: `/health`, `/balance`, `/collateral`, `/portfolio`** — Hono routes + Zod response schemas. Integration test boots indexer + seeded Postgres and hits endpoints.
11. **Remaining processors** — centuari, hub-depositor, hub-intent-settler, withdrawal-registry, spoke-deposit-gateway, spoke-vault. settlement-ledger is decode-only stub (dormant Phase 1).
12. **Multi-chain integration** — wire all 5 chains via env. Smoke-test against Arbitrum Sepolia + Base Sepolia using real RPC.
13. **Docker-compose wiring** — update the existing `indexer-v2` service block in `docker-compose.yml` (lines 131–147) to `indexer-v3` + bump context + env path. Verify `docker-compose up -d` brings it up healthy.
14. **P4 backend wiring (companion change)** — in `backend-v2`, rewrite `collateral.controller.ts` to use `applyOnChainEffect` + new endpoints; delete legacy `/internal/collateral` relay. This is a separate review but lands in the same window.
15. **E2E acceptance** on Arbitrum Sepolia: deposit USDC → `POST /collateral/flag` → observe `CollateralFlagSet(writer=CollateralManager, user, USDC, true, flaggedAt)` → indexer writes `used_as_collateral = true` + `flagged_at`. Repeat after 24h: `POST /collateral/unflag` before 24h reverts `FlagLockActive`; direct `WithdrawalRegistry.requestWithdrawal` bypass reverts `WithdrawalBlockedByHF`.

## Files to consult (source of truth)

- `smart-contract-revamp/docs/phase-1-cross-chain-balance-ledger.md` Module 8 — scope + C10 spec.
- `smart-contract-revamp/docs/collateral-loophole-fix-plan.md` P4/P5 — collateral event + backend endpoints.
- `smart-contract-revamp/src/interfaces/IBalanceLedger.sol` — `CollateralFlagSet` event shape (5-param).
- `smart-contract-revamp/src/interfaces/ICentuari.sol`, `ISettlement.sol`, `cross-chain/IHubIntentSettler.sol`, `IWithdrawalRegistry.sol`, `ISettlementLedger.sol` — every event topic the indexer subscribes to.
- `smart-contract-revamp/abi/` — generated ABIs; run `./bin/export-abi.sh` before starting and copy into `indexer-v3/abi/`.
- `matching-engine/` — pattern reference for Pino logging, migration runner, pg Pool usage, TS config.

## Non-goals for M8

- Solver reimbursement tracking — `SettlementLedger` processor is decode-only. Deferred.
- Per-chain liquidity rollup for SPOKE_NATIVE (C11) — hooks in place, rollup logic in M9 or later.
- Backend/frontend/settlement-engine updates — these are M9/M10.
- GraphQL surface — REST only in Phase 1.

## Verification

- `pnpm test` — unit + integration green (reorg detector, processors, helper, API).
- `docker-compose up -d` — `indexer-v3` healthy within 30s.
- `curl http://localhost:42069/health` returns per-chain block lag.
- Forked-chain integration test drives a `CollateralFlagSet` emit and asserts the DB row matches (used + flagged_at + applied_by_*).
- P4+P5 acceptance test from `collateral-loophole-fix-plan.md` §Verification step 3 passes against testnet.
