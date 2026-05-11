import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { hexToBytea } from "../../db/bytea.js";

const addressParam = z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/u)
    .transform((v) => v.toLowerCase() as `0x${string}`);

export const FLAG_LOCK_SECONDS = 24 * 60 * 60;

export async function registerCollateralRoutes(
    app: FastifyInstance,
    pool: Pool,
): Promise<void> {
    // READ-ONLY. Flag mutations happen on-chain only; backend-v2 calls
    // CollateralManager.{flagFor,unflagFor} then applyOnChainEffect.
    app.get("/collateral/:user/:asset", async (req, reply) => {
        const parsed = z
            .object({ user: addressParam, asset: addressParam })
            .safeParse(req.params);
        if (!parsed.success)
            return reply.code(400).send({ error: "bad params" });

        const res = await pool.query<{
            used_as_collateral: boolean;
            flagged_at: string;
        }>(
            `SELECT used_as_collateral, flagged_at
               FROM user_balance
              WHERE user_address = $1 AND asset = $2`,
            [hexToBytea(parsed.data.user), hexToBytea(parsed.data.asset)],
        );
        const row = res.rows[0];
        const flaggedAt = row ? Number(row.flagged_at) : 0;
        const used = row?.used_as_collateral ?? false;
        return {
            user: parsed.data.user,
            asset: parsed.data.asset,
            used,
            flaggedAt,
            unlocksAt:
                used && flaggedAt > 0 ? flaggedAt + FLAG_LOCK_SECONDS : 0,
        };
    });
}
