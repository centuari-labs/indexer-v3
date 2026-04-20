import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { byteaToHex, hexToBytea } from "../../db/bytea.js";

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
            pool.query(
                `SELECT user_address, asset, available, in_orders, in_yield_router,
                        used_as_collateral, flagged_at
                   FROM user_balance
                  WHERE user_address = $1`,
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
            balances: balances.rows.map((r) => ({
                asset: byteaToHex(r.asset),
                available: r.available,
                inOrders: r.in_orders,
                inYieldRouter: r.in_yield_router,
                usedAsCollateral: r.used_as_collateral,
                flaggedAt: Number(r.flagged_at),
            })),
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
