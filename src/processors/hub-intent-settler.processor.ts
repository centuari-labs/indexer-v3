import type { EventProcessor } from "../core/event-dispatcher.js";

/**
 * Stub — Step 11.
 * Active Phase 1 event: `DepositConfirmed` → `cross_chain_deposit.state = CREDITED`.
 * Decoded-but-dormant: `SolverFillRegistered` (no solver fills in Phase 1 — §C10.1).
 */
export const hubIntentSettlerProcessors: EventProcessor[] = [];
