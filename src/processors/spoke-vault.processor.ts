import { type Address, type Hex, decodeEventLog, keccak256, toHex } from "viem";
import type {
    EventProcessor,
    ProcessorContext,
} from "../core/event-dispatcher.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("spoke-vault");

/**
 * Spoke-side custody motion events. Hub-authoritative `chain_liquidity` is
 * driven by WithdrawalRegistry events on the hub, so the spoke vault's
 * custody motions are audit-only in Phase 1. We decode + log so operators
 * can correlate the two sides during diagnostics; no DB writes.
 *
 *   BridgedDeposited(asset, from, amount)      // BRIDGED custody in
 *   BridgedRecalled(asset, to, amount)         // BRIDGED custody out
 *   SpokeNativeDeposited(asset, from, amount)  // SPOKE_NATIVE custody in
 *   SpokeNativeReleased(asset, to, amount)     // SPOKE_NATIVE custody out
 */
const ABI = [
    {
        type: "event",
        name: "BridgedDeposited",
        inputs: [
            { name: "asset", type: "address", indexed: true },
            { name: "from", type: "address", indexed: true },
            { name: "amount", type: "uint256", indexed: false },
        ],
    },
    {
        type: "event",
        name: "BridgedRecalled",
        inputs: [
            { name: "asset", type: "address", indexed: true },
            { name: "to", type: "address", indexed: true },
            { name: "amount", type: "uint256", indexed: false },
        ],
    },
    {
        type: "event",
        name: "SpokeNativeDeposited",
        inputs: [
            { name: "asset", type: "address", indexed: true },
            { name: "from", type: "address", indexed: true },
            { name: "amount", type: "uint256", indexed: false },
        ],
    },
    {
        type: "event",
        name: "SpokeNativeReleased",
        inputs: [
            { name: "asset", type: "address", indexed: true },
            { name: "to", type: "address", indexed: true },
            { name: "amount", type: "uint256", indexed: false },
        ],
    },
] as const;

function topicFor(sig: string): Hex {
    return keccak256(toHex(sig));
}

const TOPIC_BRIDGED_DEPOSITED = topicFor(
    "BridgedDeposited(address,address,uint256)",
);
const TOPIC_BRIDGED_RECALLED = topicFor(
    "BridgedRecalled(address,address,uint256)",
);
const TOPIC_SPOKE_NATIVE_DEPOSITED = topicFor(
    "SpokeNativeDeposited(address,address,uint256)",
);
const TOPIC_SPOKE_NATIVE_RELEASED = topicFor(
    "SpokeNativeReleased(address,address,uint256)",
);

async function auditLog(
    ctx: ProcessorContext,
    event: string,
    counterpartyField: "from" | "to",
): Promise<void> {
    const decoded = decodeEventLog({
        abi: ABI,
        data: ctx.log.data,
        topics: ctx.log.topics,
    });
    const args = decoded.args as {
        asset: Address;
        amount: bigint;
    } & Record<"from" | "to", Address>;
    log.info(
        {
            event,
            chainId: ctx.chain.id,
            asset: args.asset,
            counterparty: args[counterpartyField],
            amount: args.amount.toString(),
            txHash: ctx.log.transactionHash,
            blockNumber: ctx.log.blockNumber?.toString(),
        },
        "spoke vault custody motion",
    );
}

export const bridgedDeposited: EventProcessor = {
    contract: "SpokeVaultStable",
    event: "BridgedDeposited",
    topic0: TOPIC_BRIDGED_DEPOSITED,
    handle: (ctx) => auditLog(ctx, "BridgedDeposited", "from"),
};

export const bridgedRecalled: EventProcessor = {
    contract: "SpokeVaultStable",
    event: "BridgedRecalled",
    topic0: TOPIC_BRIDGED_RECALLED,
    handle: (ctx) => auditLog(ctx, "BridgedRecalled", "to"),
};

export const spokeNativeDeposited: EventProcessor = {
    contract: "SpokeVaultStable",
    event: "SpokeNativeDeposited",
    topic0: TOPIC_SPOKE_NATIVE_DEPOSITED,
    handle: (ctx) => auditLog(ctx, "SpokeNativeDeposited", "from"),
};

export const spokeNativeReleased: EventProcessor = {
    contract: "SpokeVaultStable",
    event: "SpokeNativeReleased",
    topic0: TOPIC_SPOKE_NATIVE_RELEASED,
    handle: (ctx) => auditLog(ctx, "SpokeNativeReleased", "to"),
};

export const spokeVaultProcessors: EventProcessor[] = [
    bridgedDeposited,
    bridgedRecalled,
    spokeNativeDeposited,
    spokeNativeReleased,
];
