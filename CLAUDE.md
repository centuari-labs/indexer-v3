# CLAUDE.md — indexer-v3 (Custom Blockchain Indexer)

> **Status:** feature-complete, hub-only burn-in passed 2026-04-21. Ten processors, four migrations, Fastify ops surface (`/health` + `/metrics` only — data routes removed 2026-05-12), external `@centuari-labs/on-chain-effects` package integrated. Still unverified against real events: spoke processors, `HubIntentSettler.confirmDeposit` (LZ), Centuari positions processor. Ponder was explicitly rejected — do not reach for it.

## Stack

Node.js 22 · TypeScript (strict, ES2022, nodenext) · pnpm · Viem (`watchEvent` / `getLogs`, WS with HTTP fallback) · raw `pg` · Fastify · Zod · Pino · Biome · Docker (multi-stage, Node 22-alpine)

**No framework.** No Ponder, no The Graph, no subgraphs. Custom event watcher + custom Postgres schema. Same stack conventions as `backend-v2` and `matching-engine`.

## Port

`42069` — already referenced in `docker-compose.yml`.

## Commands

```bash
pnpm run dev        # tsx watch src/index.ts
pnpm run build      # tsc
pnpm run start      # node dist/index.js
pnpm run migrate    # ts-node migrations/runner.ts (sequential .sql files)
pnpm run test       # jest (processor unit tests + reorg replay)
pnpm run lint       # biome check --apply
pnpm run format     # biome format --write
pnpm run typecheck  # tsc --noEmit
```

All commands MUST run with `TZ=UTC` (docker-compose sets this; for local, prefix `TZ=UTC pnpm run dev`).

## Architecture

```
indexer-v3/
├── migrations/
│   ├── 001_init.sql             # Postgres schema (see Schema section)
│   └── runner.ts                # sequential .sql migration runner
├── src/
│   ├── index.ts                 # entry: load config → migrate → start watchers → start Fastify
│   ├── config.ts                # Zod-validated env (DATABASE_URL, per-chain RPC URLs + contract addrs + start blocks)
│   ├── db/
│   │   ├── client.ts            # shared pg.Pool
│   │   └── queries.ts           # typed helpers per entity
│   ├── chain/
│   │   ├── chain-watcher.ts     # one ChainWatcher per chain; takes chain config + list of (contract, processor) pairs
│   │   └── reorg-detector.ts    # block-hash comparison (N=12 Arbitrum, N=64 Ethereum, N=32 others)
│   ├── processors/
│   │   ├── balance-ledger.processor.ts       # Credited / Debited / CollateralFlagSet → user_balance
│   │   ├── centuari.processor.ts             # Order / Match / Repay / Bond mint events
│   │   ├── hub-depositor.processor.ts        # Deposit / Payout on Arbitrum
│   │   ├── hub-intent-settler.processor.ts   # DepositConfirmed (LZ-confirmed credits). SolverFillRegistered decoded but dormant
│   │   ├── withdrawal-registry.processor.ts  # WithdrawalRequest state transitions
│   │   ├── settlement-ledger.processor.ts    # dormant in Phase 1 (no solver reimbursement); keep stub for forward compat
│   │   ├── spoke-deposit-gateway.processor.ts # DepositInitiated on spoke → seeds cross_chain_deposit rows
│   │   └── spoke-vault.processor.ts          # spoke custody events
│   ├── api/
│   │   ├── server.ts            # Fastify bootstrap, /metrics (Prometheus)
│   │   └── routes/
│   │       └── health.ts        # GET /health — per-chain cursor lag (ops only)
│   └── abi/                     # full ABI JSON files (synced from smart-contract-revamp via bin/sync-to-services.sh)
├── biome.json                   # copy from backend-v2
├── tsconfig.json                # strict, nodenext, ES2022
├── .env.example
└── Dockerfile                   # multi-stage, Node 22-alpine
```

### ChainWatcher Layer

- Five watchers in a single Node process: one per chain (hub Arbitrum Sepolia + 4 spokes: Base, Ethereum, BNB, Polygon Sepolia).
- Each watcher uses Viem `createPublicClient` with a WS transport and HTTP fallback.
- `BlockCursor` table per chain tracks `last_block` + `last_block_hash`. On restart: replay from `last_block + 1`.
- All writes for a single block on a single chain happen in **one `pg` transaction** (`BEGIN` → processor writes + cursor update → `COMMIT`). Block cursor advance and entity mutations are atomic.
- Error boundary per chain — a crash on one chain does not stop the others.

### Reorg Handling

- On every new head, compare the last N stored `block_hash` values against live RPC `block_hash`.
- On divergence: delete rows with `block_number > forkPoint` and replay from `forkPoint + 1`.
- N per chain: **12 (Arbitrum)**, **64 (Ethereum)**, **32 (others)** — configurable in `config.ts`.
- Eager-path rows (created by backend-v2 / settlement-engine via `applyOnChainEffect`) are evicted by the same mechanism because they carry `applied_by_block_hash` + `applied_by_block_number`.

### C10 Idempotency — `@centuari-labs/on-chain-effects`

The single source of truth for the "verify-then-apply" invariant lives in the external private npm package `@centuari-labs/on-chain-effects` (published via GitHub Packages under the `centuari-labs` org). `indexer-v3` processors, `backend-v2`, `settlement-engine`, and the Phase 1 sweeper-bot all depend on the same published version, so every eager-path writer and the indexer tail run byte-identical stamp logic.

Signature (sketch):

```ts
applyOnChainEffect({
  txHash: Hex,
  expectedEventSelector: Hex,
  expectedArgsPredicate: (args: unknown) => boolean,
  mutationFn: (tx: PoolClient, stamp: ApplyStamp) => Promise<void>,
}): Promise<{ applied: boolean; reason?: "already_stamped" | "receipt_reverted" | "event_missing" | "args_mismatch" }>
```

Behaviour:

1. Fetch receipt via Viem; verify `status === "success"` and the expected event log is present with matching args.
2. Begin `pg` transaction; check if the target row already carries `applied_by_tx_hash === txHash` → skip (idempotent no-op).
3. Call `mutationFn(tx, stamp)` where `stamp = { tx_hash, log_index, block_hash, block_number }` — the mutation MUST write those four columns onto every row it touches.
4. Commit. Reorg eviction will later clean up the row if the block is replaced.

## Postgres Schema (migrations/001_init.sql)

All timestamp columns are `TIMESTAMPTZ`. Addresses and hashes stored as `BYTEA`. Token amounts as `NUMERIC(78,0)` (fits uint256).

- `block_cursor (chain_id PK, last_block, last_block_hash, updated_at)`
- `user_balance (user_address, asset, available, in_orders=0, in_yield_router=0, used_as_collateral, flagged_at, applied_by_*, updated_at; PK (user_address, asset))`
  - NO `collateral` column. Collateral is virtual / HF-gated.
  - `used_as_collateral` + `flagged_at` are mirrored from the `CollateralFlagSet(writer, user, asset, used, flaggedAt)` event (5 params; `writer` is the first indexed param).
- `deposit_event (id=chain:tx:log PK, chain_id, user, asset, amount, source_chain, tx_hash, block_*, log_index, timestamp)`
- `withdrawal_request (request_id PK, user, asset, amount, target_chain, state PENDING|PROCESSING|COMPLETED|FAILED, timestamps, applied_by_*)`
- `cross_chain_deposit (deposit_id PK, user, source_chain, asset, amount, custody_type BRIDGED|SPOKE_NATIVE, state INITIATED|CREDITED|BRIDGED|REFUNDED, timestamps, applied_by_*)`
  - No `solver` column in Phase 1. Solver is deferred; when added, this table gains `solver BYTEA`, `filled_at TIMESTAMPTZ`, and a `FILLED` state between `INITIATED` and `CREDITED`.
- `bond_token (address PK, asset, maturity, total_supply)`
- `chain_liquidity (token, chain_id, amount, applied_by_*; PK (token, chain_id))` — SPOKE_NATIVE per-chain balances; checked by `WithdrawalRegistry` path.

## REST API Surface

Fastify, JSON only, port `42069`. **Ops surface only** — no consumer-facing data API.

| Route | Consumer | Purpose |
|---|---|---|
| `GET /health` | docker healthcheck, ops | Per-chain cursor lag in seconds |
| `GET /metrics` | Prometheus | `indexer_block_lag_seconds{chain_id}`, `indexer_events_processed_total{chain_id,contract}`, `indexer_reorg_depth{chain_id}` |

**Reads:** No consumer-facing data API exists. Backend-v2, matching-engine, and every other reader queries the shared Postgres schema (`user_balance`, `withdrawal_request`, `cross_chain_deposit`, `deposit_event`, etc.) directly via its own DB pool. Frontend only calls backend-v2 — never indexer-v3.

**Writes:** The indexer's only writes are via its own processors (event-tail safety net) and via `@centuari-labs/on-chain-effects` called from eager-path services (backend-v2, settlement-engine, sweeper-bot). The indexer exposes no HTTP write endpoints.

**Historical note:** A consumer-facing data API (`/balance`, `/collateral`, `/portfolio`, `/deposits`, `/withdrawals`, `/positions`) was scoped in Phase 1 docs but never wired up by any consumer. Removed 2026-05-12.

## Event → Entity Map (Phase 1 active)

| Event (source contract) | Processor | Mutation |
|---|---|---|
| `BalanceLedger.Credited / Debited` | balance-ledger | `user_balance.available += / -=` |
| `BalanceLedger.CollateralFlagSet(writer, user, asset, used, flaggedAt)` | balance-ledger | `user_balance.used_as_collateral` + `flagged_at`; also DELETEs the matching `pending_collateral_flags` row (Phase 4 tail-path queue cleanup — idempotent peer writer alongside backend-v2 dequeue and settlement-engine eager DELETE) |
| `Centuari.*` (Order / Match / Repay / Bond mint) | centuari | position + bond rows. Repay auto-unflag surfaces via `CollateralFlagSet` — not touched here directly. |
| `HubDepositor.Deposit / Payout` | hub-depositor | `deposit_event` row; balance change comes from `BalanceLedger.Credited/Debited` |
| `HubIntentSettler.DepositConfirmed` | hub-intent-settler | `cross_chain_deposit.state = CREDITED`, `credited_at = now` |
| `HubIntentSettler.SolverFillRegistered` | hub-intent-settler | **dormant** — decode gracefully; no solver fills happen in Phase 1 |
| `WithdrawalRegistry.WithdrawalRequest*` | withdrawal-registry | `withdrawal_request.state` transitions |
| `SettlementLedger.*` | settlement-ledger | **dormant processor** — keep stub; no events expected |
| `SpokeDepositGateway.DepositInitiated` | spoke-deposit-gateway | seed `cross_chain_deposit (state=INITIATED, custody_type=BRIDGED\|SPOKE_NATIVE)` |
| `SpokeVaultStable.*` | spoke-vault | spoke custody accounting |

## Cross-service tables

The Postgres database is shared with backend-v2, settlement-engine, and the matching-engine's db-writer. Most tables are owned by indexer-v3 (the shared on-chain-state schema in `migrations/001_init.sql`). One Phase 1 table is owned cross-service:

| Table | Migration owner | Writers | Notes |
|---|---|---|---|
| `pending_collateral_flags` | backend-v2 (`20260506120000_add_pending_collateral_flags.sql`) | backend-v2 INSERT/DELETE; settlement-engine DELETE; indexer-v3 (this service) DELETE | Pre-settlement intent buffer for collateral flags. The user toggles via `POST /collateral/flag` (backend INSERTs); backend dequeues on `POST /collateral/unflag` if the asset is still queue-only; settlement-engine eager-DELETEs on the receipt of its own `Settlement.settleMatches` tx; this indexer DELETEs in `balance-ledger.processor.ts.handleCollateralFlagSet` for every observed `CollateralFlagSet` (covers direct-caller `CollateralManager.flag(asset)` events and any eager-path crashes). All four DELETE paths are idempotent — `DELETE WHERE` is naturally a no-op on a missing row. |

Future consolidation: move the migration into indexer-v3's runner so the schema home matches the cross-service write surface. Deferred — it would require coordinating downtime across all consuming services, and the current setup works.

## Code Standards

1. **Zod at every boundary** — env, HTTP request params, RPC decoded args. Reject early, never trust `unknown`.
2. **Raw `pg`, no ORM.** Parameterised queries only. No string interpolation into SQL.
3. **Transactional per block.** A processor MUST NOT `COMMIT` mid-block. All events of one `(chain, block_number)` are one transaction with the cursor update.
4. **Idempotency stamps are mandatory.** Every mutation must write the four `applied_by_*` columns. If a row cannot carry the stamps, it does not belong in a processor.
5. **Biome** (copy config from `backend-v2/biome.json`). No ESLint, no Prettier.
6. **Pino structured logs** to stdout. Never `console.log`.
7. **Custom errors over string messages** — define small `class X extends Error` types per processor.
8. **Strict TypeScript** — `"strict": true`, `"noUncheckedIndexedAccess": true`.
9. **No cross-service imports.** Services consume indexer-v3 state by reading the shared Postgres schema directly via their own DB pools — not via HTTP (the indexer exposes only `/health` + `/metrics`). The C10 idempotency helper is distributed as the external npm package `@centuari-labs/on-chain-effects` (GitHub Packages) and pulled in directly by backend-v2 / settlement-engine / sweeper-bot — no `@centuari/indexer-v3` imports anywhere.
10. **Constants only, no magic.** Chain IDs, reorg depths, block polling intervals — all named constants in `config.ts`.

## Configuration

Required env (see `.env.example`):

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Postgres 16 connection (shared with backend / matching-engine / settlement-engine) |
| `HUB_CHAIN_ID` · `HUB_RPC_URL_WS` · `HUB_RPC_URL_HTTP` · `HUB_START_BLOCK` | Arbitrum Sepolia |
| `SPOKE_BASE_*` · `SPOKE_ETHEREUM_*` · `SPOKE_BNB_*` · `SPOKE_POLYGON_*` | Spoke chains (same 4 fields each) |
| `BALANCE_LEDGER_ADDRESS` · `CENTUARI_ADDRESS` · `HUB_DEPOSITOR_ADDRESS` · `HUB_INTENT_SETTLER_ADDRESS` · `WITHDRAWAL_REGISTRY_ADDRESS` · `SETTLEMENT_LEDGER_ADDRESS` | Hub contract addresses |
| `SPOKE_DEPOSIT_GATEWAY_ADDRESS_<CHAIN>` · `SPOKE_VAULT_STABLE_ADDRESS_<CHAIN>` | Per-spoke addresses |
| `PORT` | default `42069` |
| `LOG_LEVEL` | pino level (default `info`) |

All addresses come from `smart-contract-revamp/deployments/deploy-<network>-latest.json` after running `./bin/run-all.sh`.

### Address loading

`src/index.ts` and `test/helpers/setup.ts` both call `dotenv.config({ path: '.env.contracts' })` followed by `dotenv.config()`. dotenv only sets unset keys by default, so `.env.contracts` (auto-generated, machine-managed) wins over `.env` (hand-edited, used for `DATABASE_URL`, RPC URLs, secrets). Regenerate `.env.contracts` and the synced ABIs by running:

```bash
cd smart-contract-revamp && ./bin/sync-to-services.sh
```

`bin/run-all.sh` invokes the sync script automatically at the end of a deploy (skip with `SKIP_SYNC=1`), then re-runs it with `--check` to fail the deploy if any service drifted. Run `./bin/sync-to-services.sh --check` yourself to confirm indexer-v3's `.env.contracts` + `src/abi/*.json` match the latest deployment (non-zero exit on drift).

## Testing

- **Unit** (jest): decode an event fixture, assert the DB mutation against an ephemeral Postgres (testcontainers) or `pg-mem`.
- **Reorg replay**: seed blocks 100–110, replay 105–112 with different hashes, assert rows ≥106 deleted and replaced.
- **Integration**: Anvil on a single chain; deploy `BalanceLedger`; run watcher; trigger `credit`; assert the `user_balance` row in Postgres reflects within 2s (direct DB SELECT, not HTTP).
- **Idempotency**: call `applyOnChainEffect` twice with the same tx hash → second call is no-op, row unchanged.

## Verification (Module 8 exit criteria)

- `pnpm run dev` boots, runs migrations, connects to all five chains, begins tailing.
- `curl localhost:42069/health` reports per-chain block-lag under 10s on testnet.
- `curl localhost:42069/metrics` returns Prometheus output with `indexer_block_lag_seconds` per chain.
- Trigger a deposit via `HubDepositor.deposit` on Arbitrum Sepolia → `SELECT available FROM user_balance WHERE user_address = $1 AND asset = $2` shows updated value within 2 seconds.
- Trigger a cross-chain deposit via `SpokeDepositGateway.deposit` on Base Sepolia → `SELECT state FROM cross_chain_deposit WHERE deposit_id = $1` walks through `INITIATED → CREDITED → BRIDGED`.
- `CollateralFlagSet` from `Centuari.settleMatch()` reflects in `SELECT used_as_collateral, flagged_at FROM user_balance WHERE user_address = $1 AND asset = $2` within 2s.

## Phase 1 Plan Reference

Full module spec: `dev-docs/architecture-html/launches/cross-chain.html` §4.1 (M8 / indexer-v3 cross-chain processors) — read §2 (C6 Ponder rejection, C10 two-writer idempotency, C11 SPOKE_NATIVE custody) before editing any processor. Original Module 8 detail preserved in `smart-contract-revamp/docs/archive/phase-1-cross-chain-balance-ledger.md`.
