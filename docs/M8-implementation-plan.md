# M8 — indexer-v3 Implementation Plan

**Status:** DRAFT — 2026-04-19
**Source of truth:** `smart-contract-revamp/docs/phase-1-cross-chain-balance-ledger.md` Module 8 (lines 733–900) and `smart-contract-revamp/docs/collateral-loophole-fix-plan.md` P4/P5.
**Repo:** `indexer-v3/` (created, empty except `.git/`).

> **UPDATE 2026-04-22 — C10 helper extracted to external package.** The `applyOnChainEffect` primitive has been moved out of `indexer-v3/src/shared/` and published as the private npm package [`@centuari-labs/on-chain-effects`](https://github.com/centuari-labs/on-chain-effects) on GitHub Packages. Consumers (indexer-v3, backend-v2, settlement-engine, sweeper-bot) now import `from "@centuari-labs/on-chain-effects"` — **not** `from "@centuari/indexer-v3/shared/apply-on-chain-effect"`. Consequently, Step 1's `./shared/apply-on-chain-effect` subpath export is obsolete, Step 9's workspace-boundary check no longer applies, and the umbrella `pnpm-workspace.yaml` from Prerequisite 2 is slated for removal in Phase E of the package-extraction migration (`~/.claude/plans/yes-help-me-create-enumerated-lightning.md`). The body below is preserved as a historical record of what was built.

> **UPDATE 2026-05-12 — consumer-facing data API removed.** indexer-v3 now exposes only `/health` and `/metrics` on port 42069. The original `/balance`, `/collateral`, `/portfolio`, `/deposits`, `/withdrawals`, `/positions` routes were never wired up by any consumer (matching-engine, backend, frontend, settlement-engine) — all read paths go directly against the shared Postgres schema. The indexer's role is now strictly (1) apply on-chain effects via `@centuari-labs/on-chain-effects` from its ChainWatchers, (2) backfill from chain history. Frontend continues to talk only to backend-v2. The route-table body below is preserved as historical record.

## Context

M8 is the custom Node.js/TypeScript indexer that replaces the legacy Ponder-based `indexer-v2`. It tails on-chain events from the Arbitrum hub and 4 spokes (Base, Ethereum, BNB, Polygon) and writes the canonical on-chain-state Postgres schema that every other service reads directly via its own DB pool. It also ships the shared `applyOnChainEffect` C10 idempotency helper that backend-v2, settlement-engine, and sweeper-bot (M7) import.

M8 is unblocked (M1–M5 done). Starting M8 also lands **P5** (collateral event processor) and **P4** (backend flag/unflag endpoints) inside the same window, because both need the C10 helper and the event processor that only exist once M8 is live.

## Prerequisites

Two blockers must be resolved before Phase 1 implementation can begin.

1. **ABI export.** Run `cd smart-contract-revamp && forge build && ./bin/export-abi.sh`. Five Phase 1 ABIs are currently missing from `smart-contract-revamp/abi/` (only 7 of 13 present): **WithdrawalRegistry, HubIntentSettler, SettlementLedger, SpokeDepositGateway, SpokeVaultStable**. Step 11 (remaining processors) is blocked until these land. If any contract still fails to compile, stub its processor as decode-only and file a follow-up.

2. **pnpm workspace scaffolding.** Create a root `pnpm-workspace.yaml` listing every service directory (`backend-v2`, `frontend-revamp`, `matching-engine`, `settlement-engine`, `indexer-v3`, and `sweeper-bot` once it exists) and revise root `CLAUDE.md` to scope "no monorepo workspace" to "no runtime coupling" (see phase-1 §C10.3 for mechanism; the revision lands as Phase 0.4 of the doc-update pass). This unblocks Step 1's `@centuari/indexer-v3` package naming and Step 9's consumer-boundary verification.

## Goals (what "done" looks like)

1. `indexer-v3` container runs on `docker-compose up -d` and reaches `GET /health` OK within 30s, with per-chain block-lag < 10s on testnet.
2. All 10 event processors tail testnet and persist to Postgres with C10 idempotency stamps.
3. `POST /collateral/flag` and `POST /collateral/unflag` in backend-v2 work end-to-end using indexer-v3's `applyOnChainEffect` helper (P4 + P5 acceptance).
4. Matching engine reads `user_balance` directly from the shared Postgres schema (retires the chain-RPC read path in M9). No HTTP hop to indexer-v3.
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
│   │   ├── server.ts                    # Fastify — /health + /metrics only (ops surface)
│   │   └── routes/
│   │       └── health.ts                # GET /health — per-chain cursor lag
│   └── observability/
│       ├── logger.ts                    # Pino JSON to stdout
│       └── metrics.ts                   # prom-client on /metrics
├── abi/                                 # copied from smart-contract-revamp/abi/ via export-abi.sh
├── test/
│   ├── unit/
│   └── integration/                     # uses anvil fork + ephemeral Postgres
├── Dockerfile                           # multi-stage node:22-alpine
├── package.json                         # pnpm
├── tsconfig.json                        # ES2022, module: nodenext, strict + noUncheckedIndexedAccess (per indexer-v3/CLAUDE.md)
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

Fastify, JSON only. **Ops surface only** — no consumer-facing data API. All other services read the shared Postgres schema directly via their own DB pools.

| Method | Path | Consumer | Returns |
|---|---|---|---|
| GET | `/health` | docker healthcheck, ops | `{ chains: [{chainId, blockLag, lastBlock}] }` |
| GET | `/metrics` | prometheus | `indexer_block_lag_seconds{chain_id}`, `indexer_events_processed_total`, `indexer_reorg_depth` |

Latency budget: consumers reading `user_balance` directly from the shared Postgres pool must complete sub-ms on the same docker network. The HTTP API exists only for ops/monitoring and is not on any hot path.

**Historical note:** The original M8 design exposed `/balance`, `/collateral`, `/portfolio`, `/deposits`, `/withdrawals`, and `/positions` routes scoped for matching-engine/backend/frontend. None were ever consumed at runtime (consumers went direct to Postgres). The data routes were removed on 2026-05-12.

## Multi-chain + reorg handling

- Per chain: `ChainWatcher` with Viem `createPublicClient({ transport: webSocket(..., { reconnect: true }) })`, HTTP fallback via `fallback([webSocket, http])`.
- Finality depths (configurable via env, defaults per chain): Arbitrum 12, Ethereum Sepolia 64, Base/BNB/Polygon 32.
- Every new head: fetch last `N` block hashes; compare against `block_cursor.last_block_hash` trail. On mismatch, binary-search for fork point, DELETE rows WHERE `applied_by_block_hash` beyond fork point, rewind cursor, replay.
- Block cursor + entity updates atomic per block (single pg transaction).

## Implementation order (execute in sequence)

Each step ends with a green test run before moving on.

1. **Scaffold repo.** All under `indexer-v3/`:
   - `package.json` — pnpm. Fields: `"name": "@centuari/indexer-v3"`, `"main": "./dist/index.js"`, `"types": "./dist/index.d.ts"`. Declare the helper as a first-class import subpath so consumers (`backend-v2`, `settlement-engine`, future `sweeper-bot`) can import it as `@centuari/indexer-v3/shared/apply-on-chain-effect`:
     ```jsonc
     "exports": {
       ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
       "./shared/apply-on-chain-effect": {
         "types": "./dist/shared/apply-on-chain-effect.d.ts",
         "default": "./dist/shared/apply-on-chain-effect.js"
       }
     }
     ```
     Scripts: `dev` (tsx watch), `build` (tsc), `start`, `migrate`, `copy-abi`, `test`, `lint`, `format`, `typecheck`.
   - `tsconfig.json` — `target: ES2022`, `module: nodenext`, `moduleResolution: nodenext`, `strict: true`, `noUncheckedIndexedAccess: true`, `declaration: true`, `sourceMap: true`, `outDir: dist`, `rootDir: src`, `resolveJsonModule: true`, `esModuleInterop: true`. Emitting the full `src/` tree ensures `dist/shared/apply-on-chain-effect.{js,d.ts}` exists as a real file that the `exports` subpath resolves to.
   - `biome.json` — copy verbatim from [backend-v2/biome.json](backend-v2/biome.json).
   - `Dockerfile` — multi-stage, `node:22-alpine`, pnpm via corepack. Production stage must `COPY --from=builder /app/dist ./dist` (the full compiled tree, not only the server entry) so the helper subpath is present at runtime.
   - `.env.example`, `.gitignore`, `src/index.ts` stub.
2. **Config + chains** — `src/config/env.ts` Zod-validated, `src/config/chains.ts` registry.
3. **Logger + metrics** — Pino JSON to stdout, prom-client `/metrics` endpoint skeleton.
4. **DB pool + migration runner** — `pg` Pool, sequential runner from `db/migrations/`. Land `001_init.sql`.
5. **Block cursor + reorg detector** — unit-tested against mocked chain (viem test client).
6. **ChainWatcher skeleton** — connects to one chain, tails blocks, persists cursor.
7. **Event dispatcher + ABI loader** — decodes logs via viem, routes by event topic.
8. **Processor: `balance-ledger.processor.ts`** — implement `Credited`, `Debited`, and **`CollateralFlagSet` (5-param)**. This is the P5 deliverable — test decoder against a live contract emit. Stamp `applied_by_*`.
9. **`applyOnChainEffect` helper** — ship at `src/shared/apply-on-chain-effect.ts`; compiled output at `dist/shared/apply-on-chain-effect.{js,d.ts}`. Unit tests cover: success, tx reverted, event missing, predicate fails, duplicate-call skip. **Blocking before Step 10: verify the workspace package boundary.** In a scratch `packages/_boundary-check` workspace member (or a temporary sibling service): add `"@centuari/indexer-v3": "workspace:*"` to its `package.json`, run `pnpm install`, write a 10-line script importing `applyOnChainEffect` from `@centuari/indexer-v3/shared/apply-on-chain-effect`, run `tsc --noEmit` — must compile cleanly with full types. Then run `pnpm deploy --filter=_boundary-check --prod /tmp/out` and confirm `/tmp/out/node_modules/@centuari/indexer-v3/dist/shared/apply-on-chain-effect.js` is present. This proves the prod container shape (used by backend-v2 / settlement-engine / sweeper-bot Dockerfiles per phase-1 §C10.3) actually works end-to-end.
10. **REST API: `/health` + `/metrics` only** — Fastify ops surface. Integration test boots indexer + asserts `/health` returns per-chain block lag and `/metrics` returns Prometheus output. No consumer-facing data routes — all reads go direct to Postgres.
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
- Root `pnpm-workspace.yaml` (Prerequisite 2) — workspace definition enabling `@centuari/indexer-v3` imports from `backend-v2`, `settlement-engine`, and future `sweeper-bot`. See phase-1 §C10.3 for the full distribution mechanism.

## Non-goals for M8

- Solver reimbursement tracking — `SettlementLedger` processor is decode-only. Deferred.
- Per-chain liquidity rollup for SPOKE_NATIVE (C11) — hooks in place, rollup logic in M9 or later.
- Backend/frontend/settlement-engine updates — these are M9/M10.
- GraphQL surface — REST only in Phase 1.

## Verification

- `pnpm test` — unit + integration green (reorg detector, processors, helper).
- `docker-compose up -d` — `indexer-v3` healthy within 30s.
- `curl http://localhost:42069/health` returns per-chain block lag.
- `curl http://localhost:42069/metrics` returns Prometheus output.
- `curl http://localhost:42069/balance/0xabc` returns 404 (no data API — confirms routes removed).
- Forked-chain integration test drives a `CollateralFlagSet` emit and asserts the DB row matches (used + flagged_at + applied_by_*).
- P4+P5 acceptance test from `collateral-loophole-fix-plan.md` §Verification step 3 passes against testnet.
- **Package boundary proven:** scratch consumer from Step 9 compiles + `pnpm deploy` output contains the helper at the expected path.

## Appendix — Eager-path consumers & flows

`applyOnChainEffect` is imported by every service that submits on-chain txs whose results mutate shared DB state. Authoritative spec: phase-1 §C10.1–§C10.4. Summary here for execution reference.

### Consumer call-site catalog

| Flow | Tx submitter | Helper call site | Confirmation endpoint? |
|---|---|---|---|
| Deposit (hub-native) | Frontend (wagmi, user's wallet) | backend-v2 `POST /deposit/confirm` | **Yes** |
| Deposit (cross-chain, spoke-initiated) | Frontend (wagmi, on the spoke chain) | backend-v2 `POST /deposit/confirm` — stamps `cross_chain_deposit (state=INITIATED)` | **Yes** |
| Lend / Repay / Withdraw / Withdraw-lend | backend-v2 (protocol settlement key) | inline after `viem.writeContract` | No |
| Collateral flag / unflag | backend-v2 (protocol settlement key) | inline after `CollateralManager.{flagFor,unflagFor}` | No |
| Settlement batch | settlement-engine | inline after `Settlement.settle(batch)` | No |
| Sweeper bridge (M7) | sweeper-bot | inline after bridge tx | No |

Deposit is the **only** confirmation-endpoint flow — see §C10.2 for why (user-funded tx must originate from the wallet). Every other flow is backend-direct: the service owns both the submission and the helper invocation in one handler.

### Flow 1 — Deposit (frontend → backend confirmation)

```
Frontend (wagmi)
   │ 1. user signs + sends tx on-chain (user pays gas)
   │ 2. wait for receipt in the browser
   ▼
POST /deposit/confirm { txHash, sourceChain }
   │
   ▼
backend-v2 handler
   │ 3. applyOnChainEffect({ txHash, expectedEventTopic, expectedArgsPredicate, mutationFn })
   │      - re-fetches receipt (trusts nothing from client)
   │      - verifies status=success + expected event + args
   │      - opens pg tx, runs mutationFn with applied_by_* stamps
   │      - commits
   ▼
200 → frontend refetches portfolio, UI updates

Later: indexer-v3 tail decodes the same event
   → sees applied_by_tx_hash already set → no-op (safety net)
```

### Flow 2 — Backend-direct (all other flows)

```
Client → POST /<action>
   │
   ▼
backend-v2 (or settlement-engine / sweeper-bot) handler
   │ 1. viem.writeContract(...) → receives txHash
   │ 2. applyOnChainEffect({ txHash, expectedEventTopic, expectedArgsPredicate, mutationFn })
   │      inline in the same handler
   ▼
200

Later: indexer-v3 tail → no-op (same safety net)
```

On revert (`FlagLockActive`, `WouldMakeUnhealthy`, `InsufficientChainLiquidity`, etc.), `applyOnChainEffect` sees `receipt.status=reverted`, aborts without mutating DB, and the handler decodes the custom error into an HTTP 4xx. No bespoke retry queue — the tail would have done nothing anyway because the tx reverted.

### Three invariants (from phase-1 §C10.4)

1. **Each service writes only the rows it transacted to update.** Side-effect events emitted by the same tx (e.g. `BalanceLedger.Debited/Credited` from `Settlement.settle`) are left to the indexer tail. Prevents duplicate mutations.
2. **If a service has no eager writer for a given event** (e.g. the hub-side `HubIntentSettler.confirmDeposit` for spoke-initiated cross-chain deposits), the tail is the only writer. The flow still completes — just at tail latency.
3. **If a service crashes mid-handler** between `viem.writeContract` and `applyOnChainEffect`, the tail converges the row eventually. No bespoke recovery job needed. The `applied_by_tx_hash` stamp makes double-writes a no-op regardless of write order.
