import { type Abi, type Address, type Hex, decodeEventLog } from "viem";
import withdrawalRegistryAbi from "../abi/WithdrawalRegistry.json" with {
    type: "json",
};
import type {
    EventProcessor,
    ProcessorContext,
} from "../core/event-dispatcher.js";
import { requireStamps, topicFor } from "../core/stamps.js";
import { createLogger } from "../observability/logger.js";
import { hexToBytea } from "../db/bytea.js";

const log = createLogger("withdrawal-registry");

/**
 * Hub-side withdrawal lifecycle.
 *
 * State machine:
 *   PENDING (WithdrawalRequested)
 *      → PROCESSING (WithdrawalAuthorized, then PayoutDispatched refreshes timestamps)
 *      → COMPLETED (WithdrawalCompleted) | FAILED (WithdrawalFailed)
 *
 * Hub-authoritative per-chain liquidity rollup (C11) lives on
 * ChainLiquidityIncremented / ChainLiquidityDecremented — `newTotal` is the
 * snapshot; we write it verbatim rather than deltaing.
 *
 * Full ABI synced from smart-contract-revamp/abi/WithdrawalRegistry.json.
 */
const ABI = withdrawalRegistryAbi as Abi;

const TOPIC_WITHDRAWAL_REQUESTED = topicFor(
    "WithdrawalRequested(bytes32,address,address,uint256,uint256)",
);
const TOPIC_WITHDRAWAL_AUTHORIZED = topicFor("WithdrawalAuthorized(bytes32)");
const TOPIC_PAYOUT_DISPATCHED = topicFor(
    "PayoutDispatched(bytes32,uint256,bytes32)",
);
const TOPIC_WITHDRAWAL_COMPLETED = topicFor("WithdrawalCompleted(bytes32)");
const TOPIC_WITHDRAWAL_FAILED = topicFor("WithdrawalFailed(bytes32)");
const TOPIC_CHAIN_LIQUIDITY_INCREMENTED = topicFor(
    "ChainLiquidityIncremented(address,uint256,uint256,uint256)",
);
const TOPIC_CHAIN_LIQUIDITY_DECREMENTED = topicFor(
    "ChainLiquidityDecremented(address,uint256,uint256,uint256)",
);

async function alreadyApplied(
    ctx: ProcessorContext,
    table: "withdrawal_request" | "chain_liquidity",
    pkCols: string,
    pkValues: unknown[],
    txHash: Hex,
    logIndex: number,
): Promise<boolean> {
    const res = await ctx.client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM ${table}
          WHERE ${pkCols}
            AND applied_by_tx_hash = $${pkValues.length + 1}
            AND applied_by_log_index = $${pkValues.length + 2}`,
        [...pkValues, hexToBytea(txHash), logIndex],
    );
    return Boolean(res.rows[0] && Number(res.rows[0].count) > 0);
}

async function handleWithdrawalRequested(ctx: ProcessorContext): Promise<void> {
    const decoded = decodeEventLog({
        abi: ABI,
        data: ctx.log.data,
        topics: ctx.log.topics,
    });
    if (decoded.eventName !== "WithdrawalRequested") return;
    const args = decoded.args as unknown as {
        requestId: Hex;
        user: Address;
        asset: Address;
        amount: bigint;
        targetChainId: bigint;
    };
    const stamps = requireStamps(ctx);
    if (!stamps) return;

    if (
        await alreadyApplied(
            ctx,
            "withdrawal_request",
            "request_id = $1",
            [hexToBytea(args.requestId)],
            stamps.txHash,
            stamps.logIndex,
        )
    ) {
        return;
    }

    await ctx.client.query(
        `INSERT INTO withdrawal_request
            (request_id, user_address, asset, amount, target_chain, state,
             created_at, updated_at,
             applied_by_tx_hash, applied_by_log_index,
             applied_by_block_hash, applied_by_block_number)
         VALUES ($1, $2, $3, $4::numeric, $5, 'PENDING', now(), now(),
                 $6, $7, $8, $9)
         ON CONFLICT (request_id) DO NOTHING`,
        [
            hexToBytea(args.requestId),
            hexToBytea(args.user),
            hexToBytea(args.asset),
            args.amount.toString(),
            Number(args.targetChainId),
            hexToBytea(stamps.txHash),
            stamps.logIndex,
            hexToBytea(stamps.blockHash),
            stamps.blockNumber.toString(),
        ],
    );
}

async function transitionState(
    ctx: ProcessorContext,
    expectedEvent:
        | "WithdrawalAuthorized"
        | "WithdrawalCompleted"
        | "WithdrawalFailed",
    toState: "PROCESSING" | "COMPLETED" | "FAILED",
    allowedFromStates: string[],
): Promise<void> {
    const decoded = decodeEventLog({
        abi: ABI,
        data: ctx.log.data,
        topics: ctx.log.topics,
    });
    if (decoded.eventName !== expectedEvent) return;
    const args = decoded.args as unknown as { requestId: Hex };
    const stamps = requireStamps(ctx);
    if (!stamps) return;

    if (
        await alreadyApplied(
            ctx,
            "withdrawal_request",
            "request_id = $1",
            [hexToBytea(args.requestId)],
            stamps.txHash,
            stamps.logIndex,
        )
    ) {
        return;
    }

    const completedAt = toState === "COMPLETED" ? ", completed_at = now()" : "";
    const stateList = allowedFromStates.map((s) => `'${s}'`).join(", ");
    const res = await ctx.client.query(
        `UPDATE withdrawal_request
            SET state = $2,
                updated_at = now()${completedAt},
                applied_by_tx_hash = $3,
                applied_by_log_index = $4,
                applied_by_block_hash = $5,
                applied_by_block_number = $6
          WHERE request_id = $1
            AND state IN (${stateList})`,
        [
            hexToBytea(args.requestId),
            toState,
            hexToBytea(stamps.txHash),
            stamps.logIndex,
            hexToBytea(stamps.blockHash),
            stamps.blockNumber.toString(),
        ],
    );
    if (res.rowCount === 0) {
        log.warn(
            {
                requestId: args.requestId,
                event: expectedEvent,
                toState,
            },
            "state transition missed: row absent or not in allowed prior state",
        );
    }
}

async function handlePayoutDispatched(ctx: ProcessorContext): Promise<void> {
    const decoded = decodeEventLog({
        abi: ABI,
        data: ctx.log.data,
        topics: ctx.log.topics,
    });
    if (decoded.eventName !== "PayoutDispatched") return;
    const args = decoded.args as unknown as {
        requestId: Hex;
        targetChainId: bigint;
        lzGuid: Hex;
    };
    const stamps = requireStamps(ctx);
    if (!stamps) return;

    if (
        await alreadyApplied(
            ctx,
            "withdrawal_request",
            "request_id = $1",
            [hexToBytea(args.requestId)],
            stamps.txHash,
            stamps.logIndex,
        )
    ) {
        return;
    }

    // No state change — Authorized already moved us to PROCESSING. Just refresh
    // stamps + updated_at to record that the payout was dispatched; surface the
    // lzGuid in structured logs for operator correlation with LZ Scan.
    // State guard (mirrors transitionState): only touch a row still in
    // PROCESSING so a replayed/duplicate PayoutDispatched can't re-stamp a row
    // that has since moved to a terminal COMPLETED/FAILED state.
    const res = await ctx.client.query(
        `UPDATE withdrawal_request
            SET updated_at = now(),
                applied_by_tx_hash = $2,
                applied_by_log_index = $3,
                applied_by_block_hash = $4,
                applied_by_block_number = $5
          WHERE request_id = $1
            AND state = 'PROCESSING'`,
        [
            hexToBytea(args.requestId),
            hexToBytea(stamps.txHash),
            stamps.logIndex,
            hexToBytea(stamps.blockHash),
            stamps.blockNumber.toString(),
        ],
    );
    if (res.rowCount === 0) {
        log.warn(
            { requestId: args.requestId, lzGuid: args.lzGuid },
            "PayoutDispatched for missing withdrawal row",
        );
    } else {
        log.info(
            {
                requestId: args.requestId,
                targetChainId: Number(args.targetChainId),
                lzGuid: args.lzGuid,
            },
            "PayoutDispatched",
        );
    }
}

async function handleChainLiquidity(ctx: ProcessorContext): Promise<void> {
    const decoded = decodeEventLog({
        abi: ABI,
        data: ctx.log.data,
        topics: ctx.log.topics,
    });
    if (
        decoded.eventName !== "ChainLiquidityIncremented" &&
        decoded.eventName !== "ChainLiquidityDecremented"
    ) {
        return;
    }
    const args = decoded.args as unknown as {
        asset: Address;
        chainId: bigint;
        amount: bigint;
        newTotal: bigint;
    };
    const stamps = requireStamps(ctx);
    if (!stamps) return;

    const chainIdNum = Number(args.chainId);
    if (
        await alreadyApplied(
            ctx,
            "chain_liquidity",
            "token = $1 AND chain_id = $2",
            [hexToBytea(args.asset), chainIdNum],
            stamps.txHash,
            stamps.logIndex,
        )
    ) {
        return;
    }

    await ctx.client.query(
        `INSERT INTO chain_liquidity
            (token, chain_id, amount,
             applied_by_tx_hash, applied_by_log_index,
             applied_by_block_hash, applied_by_block_number, updated_at)
         VALUES ($1, $2, $3::numeric, $4, $5, $6, $7, now())
         ON CONFLICT (token, chain_id) DO UPDATE SET
            amount = EXCLUDED.amount,
            applied_by_tx_hash = EXCLUDED.applied_by_tx_hash,
            applied_by_log_index = EXCLUDED.applied_by_log_index,
            applied_by_block_hash = EXCLUDED.applied_by_block_hash,
            applied_by_block_number = EXCLUDED.applied_by_block_number,
            updated_at = now()`,
        [
            hexToBytea(args.asset),
            chainIdNum,
            args.newTotal.toString(),
            hexToBytea(stamps.txHash),
            stamps.logIndex,
            hexToBytea(stamps.blockHash),
            stamps.blockNumber.toString(),
        ],
    );
}

export const withdrawalRequested: EventProcessor = {
    contract: "WithdrawalRegistry",
    event: "WithdrawalRequested",
    topic0: TOPIC_WITHDRAWAL_REQUESTED,
    handle: handleWithdrawalRequested,
};

export const withdrawalAuthorized: EventProcessor = {
    contract: "WithdrawalRegistry",
    event: "WithdrawalAuthorized",
    topic0: TOPIC_WITHDRAWAL_AUTHORIZED,
    handle: (ctx) =>
        transitionState(ctx, "WithdrawalAuthorized", "PROCESSING", ["PENDING"]),
};

export const payoutDispatched: EventProcessor = {
    contract: "WithdrawalRegistry",
    event: "PayoutDispatched",
    topic0: TOPIC_PAYOUT_DISPATCHED,
    handle: handlePayoutDispatched,
};

export const withdrawalCompleted: EventProcessor = {
    contract: "WithdrawalRegistry",
    event: "WithdrawalCompleted",
    topic0: TOPIC_WITHDRAWAL_COMPLETED,
    handle: (ctx) =>
        transitionState(ctx, "WithdrawalCompleted", "COMPLETED", [
            "PENDING",
            "PROCESSING",
        ]),
};

export const withdrawalFailed: EventProcessor = {
    contract: "WithdrawalRegistry",
    event: "WithdrawalFailed",
    topic0: TOPIC_WITHDRAWAL_FAILED,
    handle: (ctx) =>
        transitionState(ctx, "WithdrawalFailed", "FAILED", [
            "PENDING",
            "PROCESSING",
        ]),
};

export const chainLiquidityIncremented: EventProcessor = {
    contract: "WithdrawalRegistry",
    event: "ChainLiquidityIncremented",
    topic0: TOPIC_CHAIN_LIQUIDITY_INCREMENTED,
    handle: handleChainLiquidity,
};

export const chainLiquidityDecremented: EventProcessor = {
    contract: "WithdrawalRegistry",
    event: "ChainLiquidityDecremented",
    topic0: TOPIC_CHAIN_LIQUIDITY_DECREMENTED,
    handle: handleChainLiquidity,
};

export const withdrawalRegistryProcessors: EventProcessor[] = [
    withdrawalRequested,
    withdrawalAuthorized,
    payoutDispatched,
    withdrawalCompleted,
    withdrawalFailed,
    chainLiquidityIncremented,
    chainLiquidityDecremented,
];
