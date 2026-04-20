import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { byteaToHex, hexToBytea } from "../../db/bytea.js";

const addressParam = z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/u)
    .transform((v) => v.toLowerCase() as `0x${string}`);

export async function registerWithdrawalsRoutes(
    app: FastifyInstance,
    pool: Pool,
): Promise<void> {
    app.get("/withdrawals/:user", async (req, reply) => {
        const parsed = z.object({ user: addressParam }).safeParse(req.params);
        if (!parsed.success) return reply.code(400).send({ error: "bad user" });

        const res = await pool.query(
            `SELECT request_id, asset, amount, target_chain, state,
                    created_at, updated_at, completed_at
               FROM withdrawal_request
              WHERE user_address = $1
              ORDER BY created_at DESC`,
            [hexToBytea(parsed.data.user)],
        );
        return {
            withdrawals: res.rows.map((r) => ({
                requestId: byteaToHex(r.request_id),
                asset: byteaToHex(r.asset),
                amount: r.amount,
                targetChain: r.target_chain,
                state: r.state,
                createdAt: r.created_at,
                updatedAt: r.updated_at,
                completedAt: r.completed_at,
            })),
        };
    });
}
