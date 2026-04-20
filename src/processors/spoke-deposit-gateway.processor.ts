import type { EventProcessor } from "../core/event-dispatcher.js";

/**
 * Stub — Step 11.
 * Emits `DepositInitiated` on the spoke; seeds
 * `cross_chain_deposit (state=INITIATED, custody_type=BRIDGED|SPOKE_NATIVE)`.
 */
export const spokeDepositGatewayProcessors: EventProcessor[] = [];
