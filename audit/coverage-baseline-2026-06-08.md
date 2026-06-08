# indexer-v3 — Test Coverage Baseline (2026-06-08)

External-audit prep, Phase 2.3. Captures the coverage baseline of the Jest +
pg-mem suite after the Phase 2.1 hub-processor idempotency additions.

- **Command:** `TZ=UTC NODE_OPTIONS=--experimental-vm-modules npx jest --coverage --collectCoverageFrom='src/**/*.ts' --collectCoverageFrom='!src/abi/**' --collectCoverageFrom='!src/index.ts'`
- **Result:** 16 test suites, **76 tests, all passing.**
- **Scope note:** ABIs (`src/abi/**`, generated) and the `src/index.ts` boot
  wiring are excluded from the denominator; everything else under `src/` is in scope.

## Summary

| Metric | % |
|---|---|
| Statements | **89.04** |
| Branches | **65.44** |
| Functions | **97.10** |
| Lines | **95.05** |

## Per-area

| Area / file | % Stmts | % Branch | % Funcs | % Lines |
|---|---|---|---|---|
| **api/server.ts** | 66.66 | 100 | 50 | 66.66 |
| **api/routes/health.ts** | 100 | 88.88 | 100 | 100 |
| **core/block-cursor.ts** | 100 | 100 | 100 | 100 |
| **core/chain-scope.ts** | 100 | 100 | 100 | 100 |
| **core/event-dispatcher.ts** | 100 | 100 | 100 | 100 |
| **core/recent-hashes.ts** | 91.66 | 100 | 80 | 90 |
| **core/reorg-detector.ts** | 96.42 | 85.71 | 100 | 100 |
| **core/stamped-tables.ts** | 100 | 100 | 100 | 100 |
| **core/stamps.ts** | 75 | 80 | 100 | 75 |
| **core/wedged-chains.ts** | 100 | 100 | 100 | 100 |
| **db/bytea.ts** | 80 | 33.33 | 100 | 80 |
| **observability/logger.ts** | 100 | 50 | 100 | 100 |
| **observability/metrics.ts** | 100 | 100 | 100 | 100 |
| **processors/balance-ledger.processor.ts** | 91.17 | 83.33 | 100 | 93.93 |
| **processors/centuari.processor.ts** | 81.01 | 25 | 100 | 95.52 |
| **processors/hub-depositor.processor.ts** | 87.5 | 75 | 100 | 87.5 |
| **processors/hub-intent-settler.processor.ts** | 88 | 80 | 100 | 91.3 |
| **processors/liquidation-engine.processor.ts** | 84 | 20 | 100 | 100 |
| **processors/settlement-ledger.processor.ts** | 100 | 100 | 100 | 100 |
| **processors/spoke-deposit-gateway.processor.ts** | 87.09 | 77.77 | 100 | 89.65 |
| **processors/spoke-vault.processor.ts** | 100 | 100 | 100 | 100 |
| **processors/withdrawal-registry.processor.ts** | 87.32 | 52.38 | 100 | 96.82 |

## Hub-scope coverage (audit-relevant)

The in-scope **hub** event processors and the reorg/rewind core are all covered:

- **BalanceLedger** — Credited/Debited/CollateralFlagSet row writes, idempotency
  (already-stamped skip), defensive bail on missing stamps, pending-flag queue
  cleanup.
- **Centuari** — MarketCreated, Borrow/Lend position writes, Repaid /
  LiquidationRepaid (flag untouched), idempotency skips.
- **HubDepositor** — Deposited / PayoutReleased audit-row writes with
  `ON CONFLICT (tx_hash, log_index) DO NOTHING` idempotency at the SQL layer.
- **WithdrawalRegistry** — full state machine (PENDING→PROCESSING→COMPLETED/FAILED),
  PayoutDispatched re-stamp guard, ChainLiquidity verbatim writes, **plus the
  new already-stamped no-op (idempotency) tests added this round.**
- **SettlementLedger** — asserted dormant (empty processor list) for Phase 1.
- **Reorg/rewind** (`core/chain-scope.ts`, `core/reorg-detector.ts`) — 100% / 96%
  stmts: hub rewind deletes only hub rows beyond the fork point; a spoke rewind
  does not touch hub rows; fork-point walk and too-deep-reorg guards.

## Notes on the gaps

- Lowest-branch files (`centuari` 25%, `liquidation-engine` 20%, `db/bytea` 33%)
  are mostly defensive `eventName`-mismatch early-returns and the spoke/liquidation
  paths that are **out of hub-only scope**. Lines are well covered (95–100%);
  the uncovered branches are guard clauses, not business logic.
- `api/server.ts` (66%) is the Fastify boot/listen wiring exercised at runtime,
  not in unit tests; `health.ts` route logic is at 100%.
- This is a **baseline**, not a threshold gate — no coverage floor is enforced in
  `jest.config.cjs` yet.
