import { EventDispatcher } from "../core/event-dispatcher.js";
import { balanceLedgerProcessors } from "./balance-ledger.processor.js";
import { centuariProcessors } from "./centuari.processor.js";
import { hubDepositorProcessors } from "./hub-depositor.processor.js";
import { hubIntentSettlerProcessors } from "./hub-intent-settler.processor.js";
import { settlementLedgerProcessors } from "./settlement-ledger.processor.js";
import { spokeDepositGatewayProcessors } from "./spoke-deposit-gateway.processor.js";
import { spokeVaultProcessors } from "./spoke-vault.processor.js";
import { withdrawalRegistryProcessors } from "./withdrawal-registry.processor.js";

export function buildDispatcher(): EventDispatcher {
    const d = new EventDispatcher();
    for (const p of [
        ...balanceLedgerProcessors,
        ...centuariProcessors,
        ...hubDepositorProcessors,
        ...hubIntentSettlerProcessors,
        ...settlementLedgerProcessors,
        ...spokeDepositGatewayProcessors,
        ...spokeVaultProcessors,
        ...withdrawalRegistryProcessors,
    ]) {
        d.register(p);
    }
    return d;
}
