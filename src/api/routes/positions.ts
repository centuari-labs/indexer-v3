import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { byteaToHex, hexToBytea } from "../../db/bytea.js";

const addressParam = z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/u)
    .transform((v) => v.toLowerCase() as `0x${string}`);

const marketIdParam = z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/u)
    .transform((v) => v.toLowerCase() as `0x${string}`);

export async function registerPositionsRoutes(
    app: FastifyInstance,
    pool: Pool,
): Promise<void> {
    app.get("/markets", async () => {
        const res = await pool.query(
            `SELECT market_id, loan_token, maturity, created_at
               FROM market
              ORDER BY maturity DESC`,
        );
        return {
            markets: res.rows.map((r) => ({
                marketId: byteaToHex(r.market_id),
                loanToken: byteaToHex(r.loan_token),
                maturity: Number(r.maturity),
                createdAt: r.created_at,
            })),
        };
    });

    app.get("/markets/:marketId", async (req, reply) => {
        const parsed = z
            .object({ marketId: marketIdParam })
            .safeParse(req.params);
        if (!parsed.success)
            return reply.code(400).send({ error: "bad market id" });
        const marketIdBytea = hexToBytea(parsed.data.marketId);

        const [market, borrowStats, lendStats] = await Promise.all([
            pool.query(
                `SELECT market_id, loan_token, maturity, created_at
                   FROM market
                  WHERE market_id = $1`,
                [marketIdBytea],
            ),
            pool.query(
                `SELECT count(*)::int AS open_count,
                        COALESCE(sum(principal), 0)::text AS total_principal,
                        COALESCE(sum(debt), 0)::text AS total_debt
                   FROM borrow_position
                  WHERE market_id = $1 AND debt > 0`,
                [marketIdBytea],
            ),
            pool.query(
                `SELECT count(*)::int AS open_count,
                        COALESCE(sum(cbt_balance), 0)::text AS total_cbt,
                        COALESCE(sum(principal), 0)::text AS total_principal
                   FROM lend_position
                  WHERE market_id = $1 AND cbt_balance > 0`,
                [marketIdBytea],
            ),
        ]);

        const row = market.rows[0];
        if (!row) return reply.code(404).send({ error: "not found" });

        return {
            marketId: byteaToHex(row.market_id),
            loanToken: byteaToHex(row.loan_token),
            maturity: Number(row.maturity),
            createdAt: row.created_at,
            borrow: borrowStats.rows[0],
            lend: lendStats.rows[0],
        };
    });

    app.get("/positions/borrow/:user", async (req, reply) => {
        const parsed = z.object({ user: addressParam }).safeParse(req.params);
        if (!parsed.success) return reply.code(400).send({ error: "bad user" });
        const res = await pool.query(
            `SELECT market_id, principal, debt, rate, updated_at
               FROM borrow_position
              WHERE borrower = $1 AND debt > 0
              ORDER BY updated_at DESC`,
            [hexToBytea(parsed.data.user)],
        );
        return {
            positions: res.rows.map((r) => ({
                marketId: byteaToHex(r.market_id),
                principal: r.principal,
                debt: r.debt,
                rate: r.rate,
                updatedAt: r.updated_at,
            })),
        };
    });

    app.get("/positions/lend/:user", async (req, reply) => {
        const parsed = z.object({ user: addressParam }).safeParse(req.params);
        if (!parsed.success) return reply.code(400).send({ error: "bad user" });
        const res = await pool.query(
            `SELECT market_id, bond_token, cbt_balance, principal, rate, updated_at
               FROM lend_position
              WHERE lender = $1 AND cbt_balance > 0
              ORDER BY updated_at DESC`,
            [hexToBytea(parsed.data.user)],
        );
        return {
            positions: res.rows.map((r) => ({
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
