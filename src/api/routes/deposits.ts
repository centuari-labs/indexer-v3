import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { byteaToHex, hexToBytea } from "../../db/bytea.js";

const addressParam = z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/u)
    .transform((v) => v.toLowerCase() as `0x${string}`);

const depositIdParam = z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/u)
    .transform((v) => v.toLowerCase() as `0x${string}`);

export async function registerDepositsRoutes(
    app: FastifyInstance,
    pool: Pool,
): Promise<void> {
    // Single route dispatches by param shape: 40-hex = user address, 64-hex = deposit id.
    // Two routes would collide because Fastify ignores the param name when matching.
    app.get("/deposits/:id", async (req, reply) => {
        const raw = (req.params as { id?: string }).id ?? "";
        const asAddress = addressParam.safeParse(raw);
        if (asAddress.success) {
            const res = await pool.query(
                `SELECT deposit_id, source_chain, asset, amount, custody_type,
                        state, initiated_at, credited_at, bridged_at
                   FROM cross_chain_deposit
                  WHERE user_address = $1
                  ORDER BY initiated_at DESC`,
                [hexToBytea(asAddress.data)],
            );
            return { deposits: res.rows.map(serialize) };
        }
        const asDepositId = depositIdParam.safeParse(raw);
        if (asDepositId.success) {
            const res = await pool.query(
                `SELECT deposit_id, source_chain, asset, amount, custody_type,
                        state, initiated_at, credited_at, bridged_at
                   FROM cross_chain_deposit
                  WHERE deposit_id = $1`,
                [hexToBytea(asDepositId.data)],
            );
            const row = res.rows[0];
            if (!row) return reply.code(404).send({ error: "not found" });
            return serialize(row);
        }
        return reply
            .code(400)
            .send({ error: "expected 20-byte address or 32-byte deposit id" });
    });
}

function serialize(r: {
    deposit_id: Buffer;
    source_chain: number;
    asset: Buffer;
    amount: string;
    custody_type: string;
    state: string;
    initiated_at: Date;
    credited_at: Date | null;
    bridged_at: Date | null;
}) {
    return {
        depositId: byteaToHex(r.deposit_id),
        sourceChain: r.source_chain,
        asset: byteaToHex(r.asset),
        amount: r.amount,
        custodyType: r.custody_type,
        state: r.state,
        initiatedAt: r.initiated_at,
        creditedAt: r.credited_at,
        bridgedAt: r.bridged_at,
    };
}
