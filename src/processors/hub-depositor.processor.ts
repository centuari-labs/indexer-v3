import { type Address, type Hex, decodeEventLog, keccak256, toHex } from "viem";
import type {
    EventProcessor,
    ProcessorContext,
} from "../core/event-dispatcher.js";
import { hexToBytea } from "../db/bytea.js";

/**
 * HubDepositor emits audit events for hub-native direct deposits and payouts.
 * Balance changes surface separately via BalanceLedger.Credited / Debited
 * (HubDepositor internally calls the ledger). We only record the audit row.
 *
 *   event Deposited(address indexed user, address indexed asset, uint256 amount);
 *   event PayoutReleased(address indexed user, address indexed asset, uint256 amount);
 *
 * `deposit_event` idempotency is row-level via UNIQUE (tx_hash, log_index);
 * re-delivery is absorbed by ON CONFLICT DO NOTHING.
 */
const ABI = [
    {
        type: "event",
        name: "Deposited",
        inputs: [
            { name: "user", type: "address", indexed: true },
            { name: "asset", type: "address", indexed: true },
            { name: "amount", type: "uint256", indexed: false },
        ],
    },
    {
        type: "event",
        name: "PayoutReleased",
        inputs: [
            { name: "user", type: "address", indexed: true },
            { name: "asset", type: "address", indexed: true },
            { name: "amount", type: "uint256", indexed: false },
        ],
    },
] as const;

function topicFor(sig: string): Hex {
    return keccak256(toHex(sig));
}

const TOPIC_DEPOSITED = topicFor("Deposited(address,address,uint256)");
const TOPIC_PAYOUT_RELEASED = topicFor(
    "PayoutReleased(address,address,uint256)",
);

async function insertDepositEvent(
    ctx: ProcessorContext,
    kind: "DEPOSIT" | "PAYOUT",
): Promise<void> {
    const decoded = decodeEventLog({
        abi: ABI,
        data: ctx.log.data,
        topics: ctx.log.topics,
    });
    if (
        decoded.eventName !== "Deposited" &&
        decoded.eventName !== "PayoutReleased"
    ) {
        return;
    }
    const args = decoded.args as {
        user: Address;
        asset: Address;
        amount: bigint;
    };

    if (
        ctx.log.transactionHash === null ||
        ctx.log.blockHash === null ||
        ctx.log.blockNumber === null ||
        ctx.log.logIndex === null
    ) {
        return;
    }

    await ctx.client.query(
        `INSERT INTO deposit_event
            (chain_id, user_address, asset, amount, source_chain,
             tx_hash, block_number, block_hash, log_index, timestamp, kind)
         VALUES ($1, $2, $3, $4::numeric, $1, $5, $6, $7, $8, now(), $9)
         ON CONFLICT (tx_hash, log_index) DO NOTHING`,
        [
            ctx.chain.id,
            hexToBytea(args.user),
            hexToBytea(args.asset),
            args.amount.toString(),
            hexToBytea(ctx.log.transactionHash),
            ctx.log.blockNumber.toString(),
            hexToBytea(ctx.log.blockHash),
            ctx.log.logIndex,
            kind,
        ],
    );
}

export const deposited: EventProcessor = {
    contract: "HubDepositor",
    event: "Deposited",
    topic0: TOPIC_DEPOSITED,
    handle: (ctx) => insertDepositEvent(ctx, "DEPOSIT"),
};

export const payoutReleased: EventProcessor = {
    contract: "HubDepositor",
    event: "PayoutReleased",
    topic0: TOPIC_PAYOUT_RELEASED,
    handle: (ctx) => insertDepositEvent(ctx, "PAYOUT"),
};

export const hubDepositorProcessors: EventProcessor[] = [
    deposited,
    payoutReleased,
];
