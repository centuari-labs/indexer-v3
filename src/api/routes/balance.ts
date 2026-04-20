import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { byteaToHex, hexToBytea } from "../../db/bytea.js";

const addressParam = z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/u)
    .transform((v) => v.toLowerCase() as `0x${string}`);

export async function registerBalanceRoutes(
    app: FastifyInstance,
    pool: Pool,
): Promise<void> {
    app.get("/balance/:user", async (req, reply) => {
        const parsed = z.object({ user: addressParam }).safeParse(req.params);
        if (!parsed.success) return reply.code(400).send({ error: "bad user" });

        const res = await pool.query<BalanceRow>(
            `SELECT user_address, asset, available, in_orders, in_yield_router,
                    used_as_collateral, flagged_at
               FROM user_balance
              WHERE user_address = $1`,
            [hexToBytea(parsed.data.user)],
        );
        return { balances: res.rows.map(serializeBalance) };
    });

    app.get("/balance/:user/:asset", async (req, reply) => {
        const parsed = z
            .object({ user: addressParam, asset: addressParam })
            .safeParse(req.params);
        if (!parsed.success)
            return reply.code(400).send({ error: "bad params" });

        const res = await pool.query<BalanceRow>(
            `SELECT user_address, asset, available, in_orders, in_yield_router,
                    used_as_collateral, flagged_at
               FROM user_balance
              WHERE user_address = $1 AND asset = $2`,
            [hexToBytea(parsed.data.user), hexToBytea(parsed.data.asset)],
        );
        const row = res.rows[0];
        if (!row) {
            return {
                user: parsed.data.user,
                asset: parsed.data.asset,
                available: "0",
                inOrders: "0",
                inYieldRouter: "0",
                usedAsCollateral: false,
                flaggedAt: 0,
            };
        }
        return serializeBalance(row);
    });
}

interface BalanceRow {
    user_address: Buffer;
    asset: Buffer;
    available: string;
    in_orders: string;
    in_yield_router: string;
    used_as_collateral: boolean;
    flagged_at: string;
}

function serializeBalance(row: BalanceRow) {
    return {
        user: byteaToHex(row.user_address),
        asset: byteaToHex(row.asset),
        available: row.available,
        inOrders: row.in_orders,
        inYieldRouter: row.in_yield_router,
        usedAsCollateral: row.used_as_collateral,
        flaggedAt: Number(row.flagged_at),
    };
}
