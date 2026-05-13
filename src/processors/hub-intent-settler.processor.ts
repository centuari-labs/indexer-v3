import {
    type Abi,
    type Address,
    type Hex,
    decodeEventLog,
    keccak256,
    toHex,
} from "viem";
import hubIntentSettlerAbi from "../abi/HubIntentSettler.json" with {
    type: "json",
};
import type {
    EventProcessor,
    ProcessorContext,
} from "../core/event-dispatcher.js";
import { createLogger } from "../observability/logger.js";
import { hexToBytea } from "../db/bytea.js";

const log = createLogger("hub-intent-settler");

/**
 * Hub-side close-out of the cross-chain deposit flow.
 *
 * Active in Phase 1:
 *   event DepositConfirmed(bytes32 indexed depositId, address indexed user,
 *                          address asset, uint256 amount,
 *                          uint256 sourceChainId, uint8 classification);
 *     → cross_chain_deposit.state = CREDITED, credited_at = now()
 *
 * Dormant in Phase 1 (decode-only, no writes):
 *   event SolverFillRegistered(...);   // solver fast-fill path — not yet live
 *   event DepositMarkedNoFill(bytes32 indexed depositId);  // no-solver marker
 *
 * Full ABI synced from smart-contract-revamp/abi/HubIntentSettler.json.
 */
const ABI = hubIntentSettlerAbi as Abi;

function topicFor(sig: string): Hex {
    return keccak256(toHex(sig));
}

const TOPIC_DEPOSIT_CONFIRMED = topicFor(
    "DepositConfirmed(bytes32,address,address,uint256,uint256,uint8)",
);
const TOPIC_SOLVER_FILL_REGISTERED = topicFor(
    "SolverFillRegistered(bytes32,address,address,address,uint256,uint256)",
);
const TOPIC_DEPOSIT_MARKED_NO_FILL = topicFor("DepositMarkedNoFill(bytes32)");

async function handleDepositConfirmed(ctx: ProcessorContext): Promise<void> {
    const decoded = decodeEventLog({
        abi: ABI,
        data: ctx.log.data,
        topics: ctx.log.topics,
    });
    if (decoded.eventName !== "DepositConfirmed") return;
    const args = decoded.args as unknown as {
        depositId: Hex;
        user: Address;
        asset: Address;
        amount: bigint;
        sourceChainId: bigint;
        classification: number;
    };

    if (
        ctx.log.transactionHash === null ||
        ctx.log.blockHash === null ||
        ctx.log.blockNumber === null ||
        ctx.log.logIndex === null
    ) {
        return;
    }

    // Idempotency: if we already stamped this exact (tx, logIndex), skip.
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

    const res = await ctx.client.query(
        `UPDATE cross_chain_deposit
            SET state = 'CREDITED',
                credited_at = now(),
                applied_by_tx_hash = $2,
                applied_by_log_index = $3,
                applied_by_block_hash = $4,
                applied_by_block_number = $5
          WHERE deposit_id = $1
            AND state IN ('INITIATED', 'BRIDGED')`,
        [
            hexToBytea(args.depositId),
            hexToBytea(ctx.log.transactionHash),
            ctx.log.logIndex,
            hexToBytea(ctx.log.blockHash),
            ctx.log.blockNumber.toString(),
        ],
    );
    if (res.rowCount === 0) {
        // Either the spoke tail hasn't caught up yet (cold start) or the row
        // was already credited / refunded. Both are safe to ignore; loud log
        // helps surface genuine cross-chain desync.
        log.warn(
            {
                depositId: args.depositId,
                chainId: ctx.chain.id,
                user: args.user,
            },
            "DepositConfirmed for missing or non-initiated cross_chain_deposit row",
        );
    }
}

async function decodeOnly(ctx: ProcessorContext): Promise<void> {
    // Phase 1 dormant events. Decode to validate the log shape and suppress
    // unknown-topic log spam, but write nothing.
    try {
        decodeEventLog({
            abi: ABI,
            data: ctx.log.data,
            topics: ctx.log.topics,
        });
    } catch (err) {
        log.warn(
            { err, topics: ctx.log.topics },
            "failed to decode dormant event",
        );
    }
}

export const depositConfirmed: EventProcessor = {
    contract: "HubIntentSettler",
    event: "DepositConfirmed",
    topic0: TOPIC_DEPOSIT_CONFIRMED,
    handle: handleDepositConfirmed,
};

export const solverFillRegistered: EventProcessor = {
    contract: "HubIntentSettler",
    event: "SolverFillRegistered",
    topic0: TOPIC_SOLVER_FILL_REGISTERED,
    handle: decodeOnly,
};

export const depositMarkedNoFill: EventProcessor = {
    contract: "HubIntentSettler",
    event: "DepositMarkedNoFill",
    topic0: TOPIC_DEPOSIT_MARKED_NO_FILL,
    handle: decodeOnly,
};

export const hubIntentSettlerProcessors: EventProcessor[] = [
    depositConfirmed,
    solverFillRegistered,
    depositMarkedNoFill,
];
