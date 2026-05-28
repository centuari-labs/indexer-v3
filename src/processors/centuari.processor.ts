import {
    type Abi,
    type Address,
    type Hex,
    decodeEventLog,
    keccak256,
    toHex,
} from "viem";
import {
    applyBorrowPositionCreatedMutation,
    applyLendPositionCreatedMutation,
    applyLendPositionWithdrawnMutation,
    applyRepaidMutation,
    isAlreadyStamped,
} from "@centuari-labs/on-chain-effects";
import centuariAbi from "../abi/Centuari.json" with { type: "json" };
import type {
    EventProcessor,
    ProcessorContext,
} from "../core/event-dispatcher.js";
import { createLogger } from "../observability/logger.js";
import { hexToBytea } from "../db/bytea.js";

const log = createLogger("centuari");

/**
 * Centuari position events. Match/settlement surfaces via BalanceLedger.
 * This processor only touches market / borrow_position / lend_position.
 *
 * Collateral loophole invariant: Repaid does NOT touch used_as_collateral.
 * Flag state is owned exclusively by BalanceLedger.CollateralFlagSet; unflag
 * goes through CollateralManager.unflagFor after the 24h lock.
 * Full ABI synced from smart-contract-revamp/abi/Centuari.json.
 */
const ABI = centuariAbi as Abi;

function topicFor(sig: string): Hex {
    return keccak256(toHex(sig));
}

const TOPIC_MARKET_CREATED = topicFor("MarketCreated(bytes32,address,uint256)");
const TOPIC_BORROW_POSITION_CREATED = topicFor(
    "BorrowPositionCreated(bytes32,address,uint256,uint256,uint256)",
);
const TOPIC_LEND_POSITION_CREATED = topicFor(
    "LendPositionCreated(bytes32,address,address,uint256,uint256,uint256)",
);
const TOPIC_LEND_POSITION_WITHDRAWN = topicFor(
    "LendPositionWithdrawn(bytes32,address,uint256,uint256)",
);
const TOPIC_REPAID = topicFor("Repaid(bytes32,address,uint256)");

interface Stamps {
    txHash: Hex;
    blockHash: Hex;
    blockNumber: bigint;
    logIndex: number;
}

function requireStamps(ctx: ProcessorContext): Stamps | null {
    if (
        ctx.log.transactionHash === null ||
        ctx.log.blockHash === null ||
        ctx.log.blockNumber === null ||
        ctx.log.logIndex === null
    ) {
        return null;
    }
    return {
        txHash: ctx.log.transactionHash,
        blockHash: ctx.log.blockHash,
        blockNumber: ctx.log.blockNumber,
        logIndex: ctx.log.logIndex,
    };
}

async function handleMarketCreated(ctx: ProcessorContext): Promise<void> {
    const decoded = decodeEventLog({
        abi: ABI,
        data: ctx.log.data,
        topics: ctx.log.topics,
    });
    if (decoded.eventName !== "MarketCreated") return;
    const args = decoded.args as unknown as {
        marketId: Hex;
        loanToken: Address;
        maturity: bigint;
    };
    const stamps = requireStamps(ctx);
    if (!stamps) return;

    await ctx.client.query(
        `INSERT INTO market
            (market_id, loan_token, maturity, created_at,
             applied_by_tx_hash, applied_by_log_index,
             applied_by_block_hash, applied_by_block_number)
         VALUES ($1, $2, $3, now(), $4, $5, $6, $7)
         ON CONFLICT (market_id) DO NOTHING`,
        [
            hexToBytea(args.marketId),
            hexToBytea(args.loanToken),
            args.maturity.toString(),
            hexToBytea(stamps.txHash),
            stamps.logIndex,
            hexToBytea(stamps.blockHash),
            stamps.blockNumber.toString(),
        ],
    );
}

async function handleBorrowPositionCreated(
    ctx: ProcessorContext,
): Promise<void> {
    const decoded = decodeEventLog({
        abi: ABI,
        data: ctx.log.data,
        topics: ctx.log.topics,
    });
    if (decoded.eventName !== "BorrowPositionCreated") return;
    const args = decoded.args as unknown as {
        marketId: Hex;
        borrower: Address;
        principal: bigint;
        debt: bigint;
        rate: bigint;
    };
    const stamps = requireStamps(ctx);
    if (!stamps) return;

    if (
        await isAlreadyStamped(
            ctx.client,
            "borrow_position",
            "market_id = $1 AND borrower = $2",
            [hexToBytea(args.marketId), hexToBytea(args.borrower)],
            stamps,
        )
    ) {
        return;
    }

    await applyBorrowPositionCreatedMutation(ctx.client, args, stamps);
}

async function handleRepaid(ctx: ProcessorContext): Promise<void> {
    const decoded = decodeEventLog({
        abi: ABI,
        data: ctx.log.data,
        topics: ctx.log.topics,
    });
    if (decoded.eventName !== "Repaid") return;
    const args = decoded.args as unknown as {
        marketId: Hex;
        borrower: Address;
        amount: bigint;
    };
    const stamps = requireStamps(ctx);
    if (!stamps) return;

    if (
        await isAlreadyStamped(
            ctx.client,
            "borrow_position",
            "market_id = $1 AND borrower = $2",
            [hexToBytea(args.marketId), hexToBytea(args.borrower)],
            stamps,
        )
    ) {
        return;
    }

    // Invariant: do NOT touch used_as_collateral. Unflag is the user's explicit
    // action through CollateralManager after a 24h lock; never implicit.
    const rowCount = await applyRepaidMutation(ctx.client, args, stamps);
    if (rowCount === 0) {
        log.warn(
            { marketId: args.marketId, borrower: args.borrower },
            "Repaid for missing or already-zero borrow position",
        );
    }
}

async function handleLendPositionCreated(ctx: ProcessorContext): Promise<void> {
    const decoded = decodeEventLog({
        abi: ABI,
        data: ctx.log.data,
        topics: ctx.log.topics,
    });
    if (decoded.eventName !== "LendPositionCreated") return;
    const args = decoded.args as unknown as {
        marketId: Hex;
        lender: Address;
        bondToken: Address;
        cbtAmount: bigint;
        principal: bigint;
        rate: bigint;
    };
    const stamps = requireStamps(ctx);
    if (!stamps) return;

    if (
        await isAlreadyStamped(
            ctx.client,
            "lend_position",
            "market_id = $1 AND lender = $2",
            [hexToBytea(args.marketId), hexToBytea(args.lender)],
            stamps,
        )
    ) {
        return;
    }

    await applyLendPositionCreatedMutation(ctx.client, args, stamps);
}

async function handleLendPositionWithdrawn(
    ctx: ProcessorContext,
): Promise<void> {
    const decoded = decodeEventLog({
        abi: ABI,
        data: ctx.log.data,
        topics: ctx.log.topics,
    });
    if (decoded.eventName !== "LendPositionWithdrawn") return;
    const args = decoded.args as unknown as {
        marketId: Hex;
        lender: Address;
        cbtBurned: bigint;
        amountWithdrawn: bigint;
    };
    const stamps = requireStamps(ctx);
    if (!stamps) return;

    if (
        await isAlreadyStamped(
            ctx.client,
            "lend_position",
            "market_id = $1 AND lender = $2",
            [hexToBytea(args.marketId), hexToBytea(args.lender)],
            stamps,
        )
    ) {
        return;
    }

    const rowCount = await applyLendPositionWithdrawnMutation(
        ctx.client,
        args,
        stamps,
    );
    if (rowCount === 0) {
        log.warn(
            { marketId: args.marketId, lender: args.lender },
            "LendPositionWithdrawn for missing or zero-balance lend position",
        );
    }
}

export const marketCreated: EventProcessor = {
    contract: "Centuari",
    event: "MarketCreated",
    topic0: TOPIC_MARKET_CREATED,
    handle: handleMarketCreated,
};

export const borrowPositionCreated: EventProcessor = {
    contract: "Centuari",
    event: "BorrowPositionCreated",
    topic0: TOPIC_BORROW_POSITION_CREATED,
    handle: handleBorrowPositionCreated,
};

export const lendPositionCreated: EventProcessor = {
    contract: "Centuari",
    event: "LendPositionCreated",
    topic0: TOPIC_LEND_POSITION_CREATED,
    handle: handleLendPositionCreated,
};

export const lendPositionWithdrawn: EventProcessor = {
    contract: "Centuari",
    event: "LendPositionWithdrawn",
    topic0: TOPIC_LEND_POSITION_WITHDRAWN,
    handle: handleLendPositionWithdrawn,
};

export const repaid: EventProcessor = {
    contract: "Centuari",
    event: "Repaid",
    topic0: TOPIC_REPAID,
    handle: handleRepaid,
};

export const centuariProcessors: EventProcessor[] = [
    marketCreated,
    borrowPositionCreated,
    lendPositionCreated,
    lendPositionWithdrawn,
    repaid,
];
