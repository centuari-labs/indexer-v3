import { type Address, type Hex, decodeEventLog, keccak256, toHex } from "viem";
import type {
    EventProcessor,
    ProcessorContext,
} from "../core/event-dispatcher.js";
import { createLogger } from "../observability/logger.js";
import { hexToBytea } from "../db/bytea.js";

const log = createLogger("spoke-deposit-gateway");

/**
 * Spoke-side entry into the cross-chain deposit flow. Two initiate events
 * (BRIDGED vs SPOKE_NATIVE custody) seed a cross_chain_deposit row; the
 * refund event transitions the row to REFUNDED. The hub-side CREDITED
 * transition lives in hub-intent-settler.processor.
 *
 *   event DepositInitiated(bytes32 indexed depositId, address indexed user,
 *                          address indexed asset, uint256 amount,
 *                          uint32 hubEid, bytes32 lzGuid);
 *   event SpokeNativeDeposit(bytes32 indexed depositId, ...);        // same shape
 *   event DepositRefunded(bytes32 indexed depositId, address indexed user,
 *                         address indexed asset, uint256 amount);
 */
const ABI = [
    {
        type: "event",
        name: "DepositInitiated",
        inputs: [
            { name: "depositId", type: "bytes32", indexed: true },
            { name: "user", type: "address", indexed: true },
            { name: "asset", type: "address", indexed: true },
            { name: "amount", type: "uint256", indexed: false },
            { name: "hubEid", type: "uint32", indexed: false },
            { name: "lzGuid", type: "bytes32", indexed: false },
        ],
    },
    {
        type: "event",
        name: "SpokeNativeDeposit",
        inputs: [
            { name: "depositId", type: "bytes32", indexed: true },
            { name: "user", type: "address", indexed: true },
            { name: "asset", type: "address", indexed: true },
            { name: "amount", type: "uint256", indexed: false },
            { name: "hubEid", type: "uint32", indexed: false },
            { name: "lzGuid", type: "bytes32", indexed: false },
        ],
    },
    {
        type: "event",
        name: "DepositRefunded",
        inputs: [
            { name: "depositId", type: "bytes32", indexed: true },
            { name: "user", type: "address", indexed: true },
            { name: "asset", type: "address", indexed: true },
            { name: "amount", type: "uint256", indexed: false },
        ],
    },
] as const;

function topicFor(sig: string): Hex {
    return keccak256(toHex(sig));
}

const TOPIC_DEPOSIT_INITIATED = topicFor(
    "DepositInitiated(bytes32,address,address,uint256,uint32,bytes32)",
);
const TOPIC_SPOKE_NATIVE_DEPOSIT = topicFor(
    "SpokeNativeDeposit(bytes32,address,address,uint256,uint32,bytes32)",
);
const TOPIC_DEPOSIT_REFUNDED = topicFor(
    "DepositRefunded(bytes32,address,address,uint256)",
);

async function handleInitiate(
    ctx: ProcessorContext,
    custodyType: "BRIDGED" | "SPOKE_NATIVE",
): Promise<void> {
    const decoded = decodeEventLog({
        abi: ABI,
        data: ctx.log.data,
        topics: ctx.log.topics,
    });
    if (
        decoded.eventName !== "DepositInitiated" &&
        decoded.eventName !== "SpokeNativeDeposit"
    ) {
        return;
    }
    const args = decoded.args as {
        depositId: Hex;
        user: Address;
        asset: Address;
        amount: bigint;
        hubEid: number;
        lzGuid: Hex;
    };

    if (
        ctx.log.transactionHash === null ||
        ctx.log.blockHash === null ||
        ctx.log.blockNumber === null ||
        ctx.log.logIndex === null
    ) {
        return;
    }

    // Idempotency: if this row was already stamped by the exact (tx, logIndex),
    // skip. Otherwise upsert — a later re-delivery at a new block (reorg replay)
    // legitimately refreshes the stamp.
    const stamped = await ctx.client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM cross_chain_deposit
          WHERE deposit_id = $1
            AND applied_by_tx_hash = $2 AND applied_by_log_index = $3`,
        [
            hexToBytea(args.depositId),
            hexToBytea(ctx.log.transactionHash),
            ctx.log.logIndex,
        ],
    );
    if (stamped.rows[0] && Number(stamped.rows[0].count) > 0) return;

    await ctx.client.query(
        `INSERT INTO cross_chain_deposit
            (deposit_id, user_address, source_chain, asset, amount,
             custody_type, state, initiated_at,
             applied_by_tx_hash, applied_by_log_index,
             applied_by_block_hash, applied_by_block_number)
         VALUES ($1, $2, $3, $4, $5::numeric, $6, 'INITIATED', now(),
                 $7, $8, $9, $10)
         ON CONFLICT (deposit_id) DO UPDATE SET
            -- Only refresh if the new log strictly supersedes the previous stamp.
            custody_type = EXCLUDED.custody_type,
            applied_by_tx_hash = EXCLUDED.applied_by_tx_hash,
            applied_by_log_index = EXCLUDED.applied_by_log_index,
            applied_by_block_hash = EXCLUDED.applied_by_block_hash,
            applied_by_block_number = EXCLUDED.applied_by_block_number
          WHERE cross_chain_deposit.state = 'INITIATED'`,
        [
            hexToBytea(args.depositId),
            hexToBytea(args.user),
            ctx.chain.id,
            hexToBytea(args.asset),
            args.amount.toString(),
            custodyType,
            hexToBytea(ctx.log.transactionHash),
            ctx.log.logIndex,
            hexToBytea(ctx.log.blockHash),
            ctx.log.blockNumber.toString(),
        ],
    );
}

async function handleRefund(ctx: ProcessorContext): Promise<void> {
    const decoded = decodeEventLog({
        abi: ABI,
        data: ctx.log.data,
        topics: ctx.log.topics,
    });
    if (decoded.eventName !== "DepositRefunded") return;
    const args = decoded.args as {
        depositId: Hex;
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

    const res = await ctx.client.query(
        `UPDATE cross_chain_deposit
            SET state = 'REFUNDED',
                applied_by_tx_hash = $2,
                applied_by_log_index = $3,
                applied_by_block_hash = $4,
                applied_by_block_number = $5
          WHERE deposit_id = $1
            AND state <> 'REFUNDED'`,
        [
            hexToBytea(args.depositId),
            hexToBytea(ctx.log.transactionHash),
            ctx.log.logIndex,
            hexToBytea(ctx.log.blockHash),
            ctx.log.blockNumber.toString(),
        ],
    );
    if (res.rowCount === 0) {
        log.warn(
            { depositId: args.depositId, chainId: ctx.chain.id },
            "refund for missing or already-refunded deposit row",
        );
    }
}

export const depositInitiated: EventProcessor = {
    contract: "SpokeDepositGateway",
    event: "DepositInitiated",
    topic0: TOPIC_DEPOSIT_INITIATED,
    handle: (ctx) => handleInitiate(ctx, "BRIDGED"),
};

export const spokeNativeDeposit: EventProcessor = {
    contract: "SpokeDepositGateway",
    event: "SpokeNativeDeposit",
    topic0: TOPIC_SPOKE_NATIVE_DEPOSIT,
    handle: (ctx) => handleInitiate(ctx, "SPOKE_NATIVE"),
};

export const depositRefunded: EventProcessor = {
    contract: "SpokeDepositGateway",
    event: "DepositRefunded",
    topic0: TOPIC_DEPOSIT_REFUNDED,
    handle: handleRefund,
};

export const spokeDepositGatewayProcessors: EventProcessor[] = [
    depositInitiated,
    spokeNativeDeposit,
    depositRefunded,
];
