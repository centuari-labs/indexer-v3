import { decodeEventLog, keccak256, toHex, type Address, type Hex } from "viem";
import { hexToBytea } from "../db/bytea.js";
import type {
    EventProcessor,
    ProcessorContext,
} from "../core/event-dispatcher.js";

/**
 * BalanceLedger events (abridged — full ABI is copied from smart-contract-revamp/abi).
 *
 * The `CollateralFlagSet` signature is the protocol-critical 5-param shape:
 *   event CollateralFlagSet(address indexed writer, address indexed user,
 *                           address indexed asset, bool used, uint64 flaggedAt);
 * Invariants:
 *  - flaggedAt == 0 is the unmark sentinel.
 *  - Repeat-mark does NOT refresh flaggedAt (BalanceLedger enforces; we mirror).
 */
const ABI = [
    {
        type: "event",
        name: "Credited",
        inputs: [
            { name: "writer", type: "address", indexed: true },
            { name: "user", type: "address", indexed: true },
            { name: "asset", type: "address", indexed: true },
            { name: "amount", type: "uint256", indexed: false },
            { name: "newAvailable", type: "uint256", indexed: false },
        ],
    },
    {
        type: "event",
        name: "Debited",
        inputs: [
            { name: "writer", type: "address", indexed: true },
            { name: "user", type: "address", indexed: true },
            { name: "asset", type: "address", indexed: true },
            { name: "amount", type: "uint256", indexed: false },
            { name: "newAvailable", type: "uint256", indexed: false },
        ],
    },
    {
        type: "event",
        name: "CollateralFlagSet",
        inputs: [
            { name: "writer", type: "address", indexed: true },
            { name: "user", type: "address", indexed: true },
            { name: "asset", type: "address", indexed: true },
            { name: "used", type: "bool", indexed: false },
            { name: "flaggedAt", type: "uint64", indexed: false },
        ],
    },
] as const;

function topicFor(sig: string): Hex {
    return keccak256(toHex(sig));
}

const TOPIC_CREDITED = topicFor(
    "Credited(address,address,address,uint256,uint256)",
);
const TOPIC_DEBITED = topicFor(
    "Debited(address,address,address,uint256,uint256)",
);
const TOPIC_COLLATERAL_FLAG_SET = topicFor(
    "CollateralFlagSet(address,address,address,bool,uint64)",
);

export const credited: EventProcessor = {
    contract: "BalanceLedger",
    event: "Credited",
    topic0: TOPIC_CREDITED,
    handle: async (ctx) => handleBalanceDelta(ctx, "credit"),
};

export const debited: EventProcessor = {
    contract: "BalanceLedger",
    event: "Debited",
    topic0: TOPIC_DEBITED,
    handle: async (ctx) => handleBalanceDelta(ctx, "debit"),
};

export const collateralFlagSet: EventProcessor = {
    contract: "BalanceLedger",
    event: "CollateralFlagSet",
    topic0: TOPIC_COLLATERAL_FLAG_SET,
    handle: handleCollateralFlagSet,
};

async function handleBalanceDelta(
    ctx: ProcessorContext,
    op: "credit" | "debit",
): Promise<void> {
    const decoded = decodeEventLog({
        abi: ABI,
        data: ctx.log.data,
        topics: ctx.log.topics,
    });
    if (decoded.eventName !== "Credited" && decoded.eventName !== "Debited") {
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

    // Idempotency safety net: if this exact (tx_hash, log_index) has already
    // been stamped by the eager path, skip.
    const stamped = await ctx.client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM user_balance
          WHERE user_address = $1 AND asset = $2
            AND applied_by_tx_hash = $3 AND applied_by_log_index = $4`,
        [
            hexToBytea(args.user),
            hexToBytea(args.asset),
            hexToBytea(ctx.log.transactionHash),
            ctx.log.logIndex,
        ],
    );
    if (stamped.rows[0] && Number(stamped.rows[0].count) > 0) {
        return;
    }

    const delta =
        op === "credit" ? args.amount.toString() : `-${args.amount.toString()}`;

    await ctx.client.query(
        `INSERT INTO user_balance
            (user_address, asset, available, used_as_collateral, flagged_at,
             applied_by_tx_hash, applied_by_log_index,
             applied_by_block_hash, applied_by_block_number, updated_at)
         VALUES ($1, $2, $3::numeric, false, 0, $4, $5, $6, $7, now())
         ON CONFLICT (user_address, asset) DO UPDATE SET
            available = user_balance.available + EXCLUDED.available,
            applied_by_tx_hash = EXCLUDED.applied_by_tx_hash,
            applied_by_log_index = EXCLUDED.applied_by_log_index,
            applied_by_block_hash = EXCLUDED.applied_by_block_hash,
            applied_by_block_number = EXCLUDED.applied_by_block_number,
            updated_at = now()`,
        [
            hexToBytea(args.user),
            hexToBytea(args.asset),
            delta,
            hexToBytea(ctx.log.transactionHash),
            ctx.log.logIndex,
            hexToBytea(ctx.log.blockHash),
            ctx.log.blockNumber.toString(),
        ],
    );
}

async function handleCollateralFlagSet(ctx: ProcessorContext): Promise<void> {
    const decoded = decodeEventLog({
        abi: ABI,
        data: ctx.log.data,
        topics: ctx.log.topics,
    });
    if (decoded.eventName !== "CollateralFlagSet") return;
    const args = decoded.args as {
        writer: Address;
        user: Address;
        asset: Address;
        used: boolean;
        flaggedAt: bigint;
    };

    if (
        ctx.log.transactionHash === null ||
        ctx.log.blockHash === null ||
        ctx.log.blockNumber === null ||
        ctx.log.logIndex === null
    ) {
        return;
    }

    // C10 safety net: if the eager path already stamped this row with the
    // same tx hash, skip entirely — do not overwrite stamps or flip the flag.
    const stamped = await ctx.client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM user_balance
          WHERE user_address = $1 AND asset = $2
            AND applied_by_tx_hash = $3 AND applied_by_log_index = $4`,
        [
            hexToBytea(args.user),
            hexToBytea(args.asset),
            hexToBytea(ctx.log.transactionHash),
            ctx.log.logIndex,
        ],
    );
    if (stamped.rows[0] && Number(stamped.rows[0].count) > 0) {
        return;
    }

    // Write the flag verbatim. `flaggedAt == 0` on unmark is authoritative.
    // Repeat-mark is a no-op on flaggedAt at the contract level; we simply
    // mirror whatever the event carries.
    await ctx.client.query(
        `INSERT INTO user_balance
            (user_address, asset, used_as_collateral, flagged_at,
             applied_by_tx_hash, applied_by_log_index,
             applied_by_block_hash, applied_by_block_number, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (user_address, asset) DO UPDATE SET
            used_as_collateral = EXCLUDED.used_as_collateral,
            flagged_at = EXCLUDED.flagged_at,
            applied_by_tx_hash = EXCLUDED.applied_by_tx_hash,
            applied_by_log_index = EXCLUDED.applied_by_log_index,
            applied_by_block_hash = EXCLUDED.applied_by_block_hash,
            applied_by_block_number = EXCLUDED.applied_by_block_number,
            updated_at = now()`,
        [
            hexToBytea(args.user),
            hexToBytea(args.asset),
            args.used,
            args.flaggedAt.toString(),
            hexToBytea(ctx.log.transactionHash),
            ctx.log.logIndex,
            hexToBytea(ctx.log.blockHash),
            ctx.log.blockNumber.toString(),
        ],
    );

    // Phase 4 tail-path queue cleanup. The shared `pending_collateral_flags`
    // table is the user's pre-settlement intent buffer; once the on-chain
    // event lands the queue row is meaningless and must be removed so future
    // borrow orders don't re-encode this asset. This DELETE rides on the
    // same per-block transaction as the user_balance upsert above.
    //
    // Three writers can DELETE this row:
    //   1. backend-v2 on `POST /collateral/unflag` while the asset is still
    //      queue-only (Phase 2 dequeue branch — user explicitly takes back
    //      their pending intent before any tx fires).
    //   2. settlement-engine eager path on receipt success (Phase 3 —
    //      parses CollateralFlagSet logs from its own settleMatches receipt).
    //   3. THIS processor (Phase 4 tail) — covers direct-caller events
    //      (`CollateralManager.flag(asset)` / `unflag(asset)` from msg.sender)
    //      that the eager path never sees, plus any eager-path crashes that
    //      stamped state but missed the DELETE.
    //
    // DELETE WHERE is naturally idempotent: a row already removed by a
    // peer writer is a no-op (rowCount=0, no error). We do not gate this
    // on `args.used` — defensively clean up on `used=false` events too,
    // which never appear in a settle-driven receipt today (Centuari only
    // emits used=true at settlement) but cost nothing to handle and
    // future-proof against unflag emissions slipping into the same tx.
    //
    // Cross-service note: the migration for this table lives in backend-v2
    // (`20260506120000_add_pending_collateral_flags.sql`) but the same
    // Postgres database is shared across services. See indexer-v3 CLAUDE.md
    // "Cross-service tables".
    await ctx.client.query(
        `DELETE FROM pending_collateral_flags
          WHERE user_address = $1 AND asset = $2`,
        [hexToBytea(args.user), hexToBytea(args.asset)],
    );
}

export const balanceLedgerProcessors: EventProcessor[] = [
    credited,
    debited,
    collateralFlagSet,
];
