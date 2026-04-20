import { Pool, type PoolConfig } from "pg";

let singleton: Pool | undefined;

export function createPool(databaseUrl: string): Pool {
    const config: PoolConfig = {
        connectionString: databaseUrl,
        max: 10,
        idleTimeoutMillis: 30_000,
    };
    return new Pool(config);
}

export function getPool(databaseUrl?: string): Pool {
    if (singleton) return singleton;
    if (!databaseUrl) {
        throw new Error(
            "getPool called before init; pass databaseUrl on first call.",
        );
    }
    singleton = createPool(databaseUrl);
    return singleton;
}

export async function closePool(): Promise<void> {
    if (singleton) {
        await singleton.end();
        singleton = undefined;
    }
}
