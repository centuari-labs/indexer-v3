import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

export async function registerHealthRoutes(
    app: FastifyInstance,
    pool: Pool,
): Promise<void> {
    app.get("/health", async () => {
        const res = await pool.query<{
            chain_id: number;
            last_block: string;
            updated_at: Date;
        }>(
            `SELECT chain_id, last_block, updated_at
               FROM block_cursor
              ORDER BY chain_id`,
        );
        const now = Date.now();
        return {
            chains: res.rows.map((r) => ({
                chainId: r.chain_id,
                lastBlock: r.last_block,
                blockLagSeconds: Math.max(
                    0,
                    Math.round((now - r.updated_at.getTime()) / 1000),
                ),
            })),
        };
    });
}
