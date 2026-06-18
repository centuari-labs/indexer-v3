import { type Hex, keccak256, toHex } from "viem";
import type { ProcessorContext } from "./event-dispatcher.js";

/**
 * Idempotency-stamp helpers shared by every event processor.
 *
 * These touch the C10 verify-then-apply invariant (see CLAUDE.md): every
 * mutation must write the four `applied_by_*` columns so the indexer tail and
 * the eager-path writers (backend-v2, settlement-engine, sweeper-bot) converge
 * idempotently. Keeping a single copy here prevents the copies from drifting
 * apart — e.g. one gaining a field the others miss.
 */

/** keccak256 topic hash for a Solidity event signature string. */
export function topicFor(sig: string): Hex {
    return keccak256(toHex(sig));
}

/** The four `applied_by_*` idempotency-stamp values for one log. */
export interface Stamps {
    txHash: Hex;
    blockHash: Hex;
    blockNumber: bigint;
    logIndex: number;
}

/**
 * Extract the idempotency stamps from a log, or `null` if any required field is
 * absent (a still-pending log). Callers MUST early-return on `null`.
 */
export function requireStamps(ctx: ProcessorContext): Stamps | null {
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
