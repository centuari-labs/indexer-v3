import {
    type Abi,
    type Address,
    type Hex,
    decodeEventLog,
    keccak256,
    toHex,
} from "viem";
import liquidationEngineAbi from "../abi/LiquidationEngine.json" with {
    type: "json",
};
import type {
    EventProcessor,
    ProcessorContext,
} from "../core/event-dispatcher.js";
import { createLogger } from "../observability/logger.js";
import { hexToBytea } from "../db/bytea.js";

const log = createLogger("liquidation-engine");

/**
 * Permissionless liquidation audit trail. `Liquidated` seeds one
 * liquidation_event row; `BadDebtRemains` (emitted in the SAME tx, right after
 * Liquidated, only on a collateral-capped seizure) stamps the residual onto it.
 *
 *   event Liquidated(address indexed borrower, address indexed liquidator,
 *                    bytes32 indexed marketId, address loanToken,
 *                    address collateralAsset, uint256 repaid,
 *                    uint256 collateralSeized, bool viaMaturity);
 *   event BadDebtRemains(address indexed borrower, bytes32 indexed marketId,
 *                        uint256 remainingDebt);
 *
 * The debt-clearing + collateral-seizure balance effects of a liquidation are
 * indexed elsewhere: Centuari.LiquidationRepaid (borrow_position.debt) and
 * BalanceLedger.Debited/Credited/CollateralFlagSet (user_balance). This
 * processor only records the liquidation itself for history / bad-debt accounting.
 *
 * Full ABI synced from smart-contract-revamp/abi/LiquidationEngine.json.
 */
const ABI = liquidationEngineAbi as Abi;

function topicFor(sig: string): Hex {
    return keccak256(toHex(sig));
}

const TOPIC_LIQUIDATED = topicFor(
    "Liquidated(address,address,bytes32,address,address,uint256,uint256,bool)",
);
const TOPIC_BAD_DEBT_REMAINS = topicFor(
    "BadDebtRemains(address,bytes32,uint256)",
);

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

async function handleLiquidated(ctx: ProcessorContext): Promise<void> {
    const decoded = decodeEventLog({
        abi: ABI,
        data: ctx.log.data,
        topics: ctx.log.topics,
    });
    if (decoded.eventName !== "Liquidated") return;
    const args = decoded.args as unknown as {
        borrower: Address;
        liquidator: Address;
        marketId: Hex;
        loanToken: Address;
        collateralAsset: Address;
        repaid: bigint;
        collateralSeized: bigint;
        viaMaturity: boolean;
    };
    const stamps = requireStamps(ctx);
    if (!stamps) return;

    // Idempotent on the (tx, logIndex) stamp. A reorg evicts the row by
    // block_number first (rewindTo), then replay re-inserts cleanly.
    await ctx.client.query(
        `INSERT INTO liquidation_event
            (borrower, liquidator, market_id, loan_token, collateral_asset,
             repaid, collateral_seized, via_maturity,
             applied_by_tx_hash, applied_by_log_index,
             applied_by_block_hash, applied_by_block_number)
         VALUES ($1, $2, $3, $4, $5, $6::numeric, $7::numeric, $8, $9, $10, $11, $12)
         ON CONFLICT (applied_by_tx_hash, applied_by_log_index) DO NOTHING`,
        [
            hexToBytea(args.borrower),
            hexToBytea(args.liquidator),
            hexToBytea(args.marketId),
            hexToBytea(args.loanToken),
            hexToBytea(args.collateralAsset),
            args.repaid.toString(),
            args.collateralSeized.toString(),
            args.viaMaturity,
            hexToBytea(stamps.txHash),
            stamps.logIndex,
            hexToBytea(stamps.blockHash),
            stamps.blockNumber.toString(),
        ],
    );
}

async function handleBadDebtRemains(ctx: ProcessorContext): Promise<void> {
    const decoded = decodeEventLog({
        abi: ABI,
        data: ctx.log.data,
        topics: ctx.log.topics,
    });
    if (decoded.eventName !== "BadDebtRemains") return;
    const args = decoded.args as unknown as {
        borrower: Address;
        marketId: Hex;
        remainingDebt: bigint;
    };
    const stamps = requireStamps(ctx);
    if (!stamps) return;

    // Enrich the matching Liquidated row with the residual. The contract emits
    // BadDebtRemains immediately after its Liquidated (same tx, same borrower +
    // market, strictly higher logIndex), so we target the NEAREST PRECEDING
    // Liquidated row — robust even if one tx liquidates the same (borrower,
    // market) more than once (e.g. a batched/keeper call): each BadDebtRemains
    // pairs with its own Liquidated, never smearing across rows.
    //
    // No applied_by_* stamp is written here: this is an enrichment of a row that
    // already carries its Liquidated stamp (same block), which is the key reorg
    // eviction uses — the residual rides along and is evicted with that row.
    // Idempotent: re-applying sets the same value on the same row.
    const res = await ctx.client.query(
        `UPDATE liquidation_event
            SET remaining_debt = $5::numeric
          WHERE id = (
            SELECT id FROM liquidation_event
             WHERE applied_by_tx_hash = $1
               AND borrower = $2
               AND market_id = $3
               AND applied_by_log_index < $4
             ORDER BY applied_by_log_index DESC
             LIMIT 1
          )`,
        [
            hexToBytea(stamps.txHash),
            hexToBytea(args.borrower),
            hexToBytea(args.marketId),
            stamps.logIndex,
            args.remainingDebt.toString(),
        ],
    );
    if (res.rowCount === 0) {
        log.warn(
            { borrower: args.borrower, marketId: args.marketId },
            "BadDebtRemains with no matching liquidation_event row",
        );
    }
}

export const liquidated: EventProcessor = {
    contract: "LiquidationEngine",
    event: "Liquidated",
    topic0: TOPIC_LIQUIDATED,
    handle: handleLiquidated,
};

export const badDebtRemains: EventProcessor = {
    contract: "LiquidationEngine",
    event: "BadDebtRemains",
    topic0: TOPIC_BAD_DEBT_REMAINS,
    handle: handleBadDebtRemains,
};

export const liquidationEngineProcessors: EventProcessor[] = [
    liquidated,
    badDebtRemains,
];
