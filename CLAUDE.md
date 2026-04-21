# CLAUDE.md — indexer-v3 (Custom Blockchain Indexer)

> **Status:** feature-complete, hub-only burn-in passed 2026-04-21. Ten processors, four migrations, Fastify REST, shared `apply-on-chain-effect` all live. Still unverified against real events: spoke processors, `HubIntentSettler.confirmDeposit` (LZ), Centuari positions processor. Ponder was explicitly rejected — do not reach for it.

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
pnpm run copy-abi   # copy JSON ABIs from ../smart-contract-revamp/abi/ into src/abi/
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
│   ├── shared/
│   │   └── apply-on-chain-effect.ts  # C10 idempotency helper — EXPORTED for re-use by backend-v2, settlement-engine, sweeper-bot
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
│   │   ├── server.ts            # Fastify bootstrap, Pino logger, /metrics (Prometheus)
│   │   └── routes/
│   │       ├── balance.ts       # GET /balance/:user, GET /balance/:user/:asset
│   │       ├── collateral.ts    # GET /collateral/:user/:asset — READ-ONLY (no write endpoint)
│   │       ├── withdrawals.ts   # GET /withdrawals/:user
│   │       ├── deposits.ts      # GET /deposits/:user, GET /deposits/:depositId
│   │       ├── portfolio.ts     # GET /portfolio/:user — aggregates balance + open withdrawals + in-flight deposits
│   │       └── health.ts        # GET /health — per-chain cursor lag
│   └── abi/                     # generated TS ABI constants (produced by `pnpm run copy-abi`)
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

### C10 Idempotency — `apply-on-chain-effect.ts`

This is the single source of truth for the "verify-then-apply" invariant. Exported so that `backend-v2`, `settlement-engine`, and the Phase 1 sweeper-bot can import it and share the idempotency stamps with the indexer.

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

Fastify, JSON only, port `42069`. No GraphQL.

| Route | Consumer | Purpose |
|---|---|---|
| `GET /balance/:user` | frontend, backend | All balances across assets |
| `GET /balance/:user/:asset` | matching-engine (hot path) | Single `available` lookup (sub-ms, same docker network) |
| `GET /collateral/:user/:asset` | backend, frontend | `{ used, flaggedAt, unlocksAt }`. **READ-ONLY.** There is no write endpoint — flag mutations happen on-chain only. |
| `GET /withdrawals/:user` | backend, frontend | Withdrawal request list |
| `GET /deposits/:user` · `GET /deposits/:depositId` | backend, frontend | Cross-chain deposit tracking |
| `GET /portfolio/:user` | frontend | One-call aggregate: balances + open withdrawals + in-flight cross-chain deposits |
| `GET /health` | ops, backend fallback logic | Per-chain cursor lag in seconds |
| `GET /metrics` | Prometheus | `indexer_block_lag_seconds{chain_id}`, `indexer_events_processed_total{chain_id,contract}`, `indexer_reorg_depth{chain_id}` |

## Event → Entity Map (Phase 1 active)

| Event (source contract) | Processor | Mutation |
|---|---|---|
| `BalanceLedger.Credited / Debited` | balance-ledger | `user_balance.available += / -=` |
| `BalanceLedger.CollateralFlagSet(writer, user, asset, used, flaggedAt)` | balance-ledger | `user_balance.used_as_collateral` + `flagged_at` |
| `Centuari.*` (Order / Match / Repay / Bond mint) | centuari | position + bond rows. Repay auto-unflag surfaces via `CollateralFlagSet` — not touched here directly. |
| `HubDepositor.Deposit / Payout` | hub-depositor | `deposit_event` row; balance change comes from `BalanceLedger.Credited/Debited` |
| `HubIntentSettler.DepositConfirmed` | hub-intent-settler | `cross_chain_deposit.state = CREDITED`, `credited_at = now` |
| `HubIntentSettler.SolverFillRegistered` | hub-intent-settler | **dormant** — decode gracefully; no solver fills happen in Phase 1 |
| `WithdrawalRegistry.WithdrawalRequest*` | withdrawal-registry | `withdrawal_request.state` transitions |
| `SettlementLedger.*` | settlement-ledger | **dormant processor** — keep stub; no events expected |
| `SpokeDepositGateway.DepositInitiated` | spoke-deposit-gateway | seed `cross_chain_deposit (state=INITIATED, custody_type=BRIDGED\|SPOKE_NATIVE)` |
| `SpokeVaultStable.*` | spoke-vault | spoke custody accounting |

## Code Standards

1. **Zod at every boundary** — env, HTTP request params, RPC decoded args. Reject early, never trust `unknown`.
2. **Raw `pg`, no ORM.** Parameterised queries only. No string interpolation into SQL.
3. **Transactional per block.** A processor MUST NOT `COMMIT` mid-block. All events of one `(chain, block_number)` are one transaction with the cursor update.
4. **Idempotency stamps are mandatory.** Every mutation must write the four `applied_by_*` columns. If a row cannot carry the stamps, it does not belong in a processor.
5. **Biome** (copy config from `backend-v2/biome.json`). No ESLint, no Prettier.
6. **Pino structured logs** to stdout. Never `console.log`.
7. **Custom errors over string messages** — define small `class X extends Error` types per processor.
8. **Strict TypeScript** — `"strict": true`, `"noUncheckedIndexedAccess": true`.
9. **No cross-service imports.** Services consume indexer-v3 via REST. The only exported symbol for re-use is `apply-on-chain-effect.ts` (imported by backend-v2 / settlement-engine / sweeper-bot).
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

## Testing

- **Unit** (jest): decode an event fixture, assert the DB mutation against an ephemeral Postgres (testcontainers) or `pg-mem`.
- **Reorg replay**: seed blocks 100–110, replay 105–112 with different hashes, assert rows ≥106 deleted and replaced.
- **Integration**: Anvil on a single chain; deploy `BalanceLedger`; run watcher; trigger `credit`; assert `GET /balance/:user/:asset` reflects within 2s.
- **Idempotency**: call `applyOnChainEffect` twice with the same tx hash → second call is no-op, row unchanged.

## Verification (Module 8 exit criteria)

- `pnpm run dev` boots, runs migrations, connects to all five chains, begins tailing.
- `curl localhost:42069/health` reports per-chain block-lag under 10s on testnet.
- Trigger a deposit via `HubDepositor.deposit` on Arbitrum Sepolia → `GET /balance/0x<user>/0x<asset>` shows updated `available` within 2 seconds.
- Trigger a cross-chain deposit via `SpokeDepositGateway.deposit` on Base Sepolia → `GET /deposits/<depositId>` walks through `INITIATED → CREDITED → BRIDGED`.
- `CollateralFlagSet` from `Centuari.settleMatch()` reflects in `GET /collateral/:user/:asset` within 2s.

## Phase 1 Plan Reference

Full module spec, dependencies, and verification checklist: `smart-contract-revamp/docs/phase-1-cross-chain-balance-ledger.md` — Module 8. Read C6 (Ponder rejection), C10 (two-writer idempotency pattern), C11 (SPOKE_NATIVE custody) before editing any processor.
