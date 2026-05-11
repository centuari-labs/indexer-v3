import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { byteaToHex, hexToBytea } from "../../db/bytea.js";
import { FLAG_LOCK_SECONDS } from "./collateral.js";

const addressParam = z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/u)
    .transform((v) => v.toLowerCase() as `0x${string}`);

export async function registerPortfolioRoutes(
    app: FastifyInstance,
    pool: Pool,
): Promise<void> {
    app.get("/portfolio/:user", async (req, reply) => {
        const parsed = z.object({ user: addressParam }).safeParse(req.params);
        if (!parsed.success) return reply.code(400).send({ error: "bad user" });
        const user = hexToBytea(parsed.data.user);

        const [
            balances,
            openWithdrawals,
            inFlightDeposits,
            borrowPositions,
            lendPositions,
        ] = await Promise.all([
            // LEFT JOIN pending_collateral_flags so the frontend can render the
            // three-state badge (none / pending / onchain) without a second
            // round trip. The join is by (user, asset) — matches the table's
            // UNIQUE (user_address, asset) constraint, so at most one row hits.
            pool.query(
                `SELECT b.user_address, b.asset, b.available, b.in_orders,
                        b.in_yield_router, b.used_as_collateral, b.flagged_at,
                        (p.user_address IS NOT NULL) AS pending_collateral_flag
                   FROM user_balance b
                   LEFT JOIN pending_collateral_flags p
                          ON p.user_address = b.user_address
                         AND p.asset = b.asset
                  WHERE b.user_address = $1`,
                [user],
            ),
            pool.query(
                `SELECT request_id, asset, amount, target_chain, state,
                        created_at, updated_at
                   FROM withdrawal_request
                  WHERE user_address = $1
                    AND state IN ('PENDING', 'PROCESSING')`,
                [user],
            ),
            pool.query(
                `SELECT deposit_id, source_chain, asset, amount,
                        custody_type, state, initiated_at
                   FROM cross_chain_deposit
                  WHERE user_address = $1
                    AND state IN ('INITIATED', 'CREDITED')`,
                [user],
            ),
            pool.query(
                `SELECT market_id, principal, debt, rate, updated_at
                   FROM borrow_position
                  WHERE borrower = $1 AND debt > 0`,
                [user],
            ),
            pool.query(
                `SELECT market_id, bond_token, cbt_balance, principal, rate, updated_at
                   FROM lend_position
                  WHERE lender = $1 AND cbt_balance > 0`,
                [user],
            ),
        ]);

        return {
            user: parsed.data.user,
            balances: balances.rows.map((r) => {
                const flaggedAt = Number(r.flagged_at);
                const usedAsCollateral = r.used_as_collateral as boolean;
                // `unlocksAt` matches the convention used by /collateral/:user/:asset:
                // 0 when the asset isn't on-chain flagged, else flaggedAt + 24h.
                // Frontend derives the badge state from (usedAsCollateral,
                // pendingCollateralFlag) and only reads flaggedAt / unlocksAt
                // for the `onchain` variant.
                const unlocksAt =
                    usedAsCollateral && flaggedAt > 0
                        ? flaggedAt + FLAG_LOCK_SECONDS
                        : 0;
                return {
                    asset: byteaToHex(r.asset),
                    available: r.available,
                    inOrders: r.in_orders,
                    inYieldRouter: r.in_yield_router,
                    usedAsCollateral,
                    flaggedAt,
                    unlocksAt,
                    pendingCollateralFlag: r.pending_collateral_flag as boolean,
                };
            }),
            openWithdrawals: openWithdrawals.rows.map((r) => ({
                requestId: byteaToHex(r.request_id),
                asset: byteaToHex(r.asset),
                amount: r.amount,
                targetChain: r.target_chain,
                state: r.state,
                createdAt: r.created_at,
                updatedAt: r.updated_at,
            })),
            inFlightDeposits: inFlightDeposits.rows.map((r) => ({
                depositId: byteaToHex(r.deposit_id),
                sourceChain: r.source_chain,
                asset: byteaToHex(r.asset),
                amount: r.amount,
                custodyType: r.custody_type,
                state: r.state,
                initiatedAt: r.initiated_at,
            })),
            borrowPositions: borrowPositions.rows.map((r) => ({
                marketId: byteaToHex(r.market_id),
                principal: r.principal,
                debt: r.debt,
                rate: r.rate,
                updatedAt: r.updated_at,
            })),
            lendPositions: lendPositions.rows.map((r) => ({
                marketId: byteaToHex(r.market_id),
                bondToken: byteaToHex(r.bond_token),
                cbtBalance: r.cbt_balance,
                principal: r.principal,
                rate: r.rate,
                updatedAt: r.updated_at,
            })),
        };
    });
}
