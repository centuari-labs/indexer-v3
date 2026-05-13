import {
    type Abi,
    type Address,
    type Hex,
    decodeEventLog,
    keccak256,
    toHex,
} from "viem";
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

async function alreadyApplied(
    ctx: ProcessorContext,
    table: "market" | "borrow_position" | "lend_position",
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
        await alreadyApplied(
            ctx,
            "borrow_position",
            "market_id = $1 AND borrower = $2",
            [hexToBytea(args.marketId), hexToBytea(args.borrower)],
            stamps.txHash,
            stamps.logIndex,
        )
    ) {
        return;
    }

    await ctx.client.query(
        `INSERT INTO borrow_position
            (market_id, borrower, principal, debt, rate,
             applied_by_tx_hash, applied_by_log_index,
             applied_by_block_hash, applied_by_block_number, updated_at)
         VALUES ($1, $2, $3::numeric, $4::numeric, $5::numeric,
                 $6, $7, $8, $9, now())
         ON CONFLICT (market_id, borrower) DO UPDATE SET
            principal = borrow_position.principal + EXCLUDED.principal,
            debt = borrow_position.debt + EXCLUDED.debt,
            rate = EXCLUDED.rate,
            applied_by_tx_hash = EXCLUDED.applied_by_tx_hash,
            applied_by_log_index = EXCLUDED.applied_by_log_index,
            applied_by_block_hash = EXCLUDED.applied_by_block_hash,
            applied_by_block_number = EXCLUDED.applied_by_block_number,
            updated_at = now()`,
        [
            hexToBytea(args.marketId),
            hexToBytea(args.borrower),
            args.principal.toString(),
            args.debt.toString(),
            args.rate.toString(),
            hexToBytea(stamps.txHash),
            stamps.logIndex,
            hexToBytea(stamps.blockHash),
            stamps.blockNumber.toString(),
        ],
    );
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
        await alreadyApplied(
            ctx,
            "borrow_position",
            "market_id = $1 AND borrower = $2",
            [hexToBytea(args.marketId), hexToBytea(args.borrower)],
            stamps.txHash,
            stamps.logIndex,
        )
    ) {
        return;
    }

    // Invariant: do NOT touch used_as_collateral. Unflag is the user's explicit
    // action through CollateralManager after a 24h lock; never implicit.
    const res = await ctx.client.query(
        `UPDATE borrow_position
            SET debt = GREATEST(debt - $3::numeric, 0),
                applied_by_tx_hash = $4,
                applied_by_log_index = $5,
                applied_by_block_hash = $6,
                applied_by_block_number = $7,
                updated_at = now()
          WHERE market_id = $1 AND borrower = $2 AND debt > 0`,
        [
            hexToBytea(args.marketId),
            hexToBytea(args.borrower),
            args.amount.toString(),
            hexToBytea(stamps.txHash),
            stamps.logIndex,
            hexToBytea(stamps.blockHash),
            stamps.blockNumber.toString(),
        ],
    );
    if (res.rowCount === 0) {
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
        await alreadyApplied(
            ctx,
            "lend_position",
            "market_id = $1 AND lender = $2",
            [hexToBytea(args.marketId), hexToBytea(args.lender)],
            stamps.txHash,
            stamps.logIndex,
        )
    ) {
        return;
    }

    await ctx.client.query(
        `INSERT INTO lend_position
            (market_id, lender, bond_token, cbt_balance, principal, rate,
             applied_by_tx_hash, applied_by_log_index,
             applied_by_block_hash, applied_by_block_number, updated_at)
         VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6::numeric,
                 $7, $8, $9, $10, now())
         ON CONFLICT (market_id, lender) DO UPDATE SET
            bond_token = EXCLUDED.bond_token,
            cbt_balance = lend_position.cbt_balance + EXCLUDED.cbt_balance,
            principal = lend_position.principal + EXCLUDED.principal,
            rate = EXCLUDED.rate,
            applied_by_tx_hash = EXCLUDED.applied_by_tx_hash,
            applied_by_log_index = EXCLUDED.applied_by_log_index,
            applied_by_block_hash = EXCLUDED.applied_by_block_hash,
            applied_by_block_number = EXCLUDED.applied_by_block_number,
            updated_at = now()`,
        [
            hexToBytea(args.marketId),
            hexToBytea(args.lender),
            hexToBytea(args.bondToken),
            args.cbtAmount.toString(),
            args.principal.toString(),
            args.rate.toString(),
            hexToBytea(stamps.txHash),
            stamps.logIndex,
            hexToBytea(stamps.blockHash),
            stamps.blockNumber.toString(),
        ],
    );
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
        await alreadyApplied(
            ctx,
            "lend_position",
            "market_id = $1 AND lender = $2",
            [hexToBytea(args.marketId), hexToBytea(args.lender)],
            stamps.txHash,
            stamps.logIndex,
        )
    ) {
        return;
    }

    const res = await ctx.client.query(
        `UPDATE lend_position
            SET cbt_balance = GREATEST(cbt_balance - $3::numeric, 0),
                principal = GREATEST(principal - $4::numeric, 0),
                applied_by_tx_hash = $5,
                applied_by_log_index = $6,
                applied_by_block_hash = $7,
                applied_by_block_number = $8,
                updated_at = now()
          WHERE market_id = $1 AND lender = $2 AND cbt_balance > 0`,
        [
            hexToBytea(args.marketId),
            hexToBytea(args.lender),
            args.cbtBurned.toString(),
            args.amountWithdrawn.toString(),
            hexToBytea(stamps.txHash),
            stamps.logIndex,
            hexToBytea(stamps.blockHash),
            stamps.blockNumber.toString(),
        ],
    );
    if (res.rowCount === 0) {
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
