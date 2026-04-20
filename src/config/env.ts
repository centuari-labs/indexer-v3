import { z } from "zod";
import {
    CHAIN_KEYS,
    type ChainConfig,
    type ChainContracts,
    type ChainKey,
    type ChainRole,
    DEFAULT_FINALITY,
} from "./chains.js";

const hexAddress = z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/u, "expected 0x-prefixed 20-byte address")
    .transform((v) => v.toLowerCase() as `0x${string}`);

const optionalHex = hexAddress.optional();

const baseEnvSchema = z.object({
    DATABASE_URL: z.string().url(),
    PORT: z.coerce.number().int().positive().default(42069),
    LOG_LEVEL: z
        .enum(["trace", "debug", "info", "warn", "error", "fatal"])
        .default("info"),
    NODE_ENV: z
        .enum(["development", "test", "production"])
        .default("development"),

    // Hub (Arbitrum)
    HUB_CHAIN_ID: z.coerce.number().int().positive(),
    HUB_RPC_URL_WS: z.string().url(),
    HUB_RPC_URL_HTTP: z.string().url(),
    HUB_START_BLOCK: z.coerce.bigint().default(0n),
    HUB_FINALITY_DEPTH: z.coerce
        .number()
        .int()
        .positive()
        .default(DEFAULT_FINALITY.hub),

    // Hub contracts
    BALANCE_LEDGER_ADDRESS: optionalHex,
    CENTUARI_ADDRESS: optionalHex,
    HUB_DEPOSITOR_ADDRESS: optionalHex,
    HUB_INTENT_SETTLER_ADDRESS: optionalHex,
    WITHDRAWAL_REGISTRY_ADDRESS: optionalHex,
    SETTLEMENT_LEDGER_ADDRESS: optionalHex,
    COLLATERAL_MANAGER_ADDRESS: optionalHex,

    // Spokes
    SPOKE_BASE_CHAIN_ID: z.coerce.number().int().positive(),
    SPOKE_BASE_RPC_URL_WS: z.string().url(),
    SPOKE_BASE_RPC_URL_HTTP: z.string().url(),
    SPOKE_BASE_START_BLOCK: z.coerce.bigint().default(0n),
    SPOKE_BASE_FINALITY_DEPTH: z.coerce
        .number()
        .int()
        .positive()
        .default(DEFAULT_FINALITY.spoke),
    SPOKE_BASE_DEPOSIT_GATEWAY_ADDRESS: optionalHex,
    SPOKE_BASE_VAULT_STABLE_ADDRESS: optionalHex,

    SPOKE_ETHEREUM_CHAIN_ID: z.coerce.number().int().positive(),
    SPOKE_ETHEREUM_RPC_URL_WS: z.string().url(),
    SPOKE_ETHEREUM_RPC_URL_HTTP: z.string().url(),
    SPOKE_ETHEREUM_START_BLOCK: z.coerce.bigint().default(0n),
    SPOKE_ETHEREUM_FINALITY_DEPTH: z.coerce
        .number()
        .int()
        .positive()
        .default(64),
    SPOKE_ETHEREUM_DEPOSIT_GATEWAY_ADDRESS: optionalHex,
    SPOKE_ETHEREUM_VAULT_STABLE_ADDRESS: optionalHex,

    SPOKE_BNB_CHAIN_ID: z.coerce.number().int().positive(),
    SPOKE_BNB_RPC_URL_WS: z.string().url(),
    SPOKE_BNB_RPC_URL_HTTP: z.string().url(),
    SPOKE_BNB_START_BLOCK: z.coerce.bigint().default(0n),
    SPOKE_BNB_FINALITY_DEPTH: z.coerce
        .number()
        .int()
        .positive()
        .default(DEFAULT_FINALITY.spoke),
    SPOKE_BNB_DEPOSIT_GATEWAY_ADDRESS: optionalHex,
    SPOKE_BNB_VAULT_STABLE_ADDRESS: optionalHex,

    SPOKE_POLYGON_CHAIN_ID: z.coerce.number().int().positive(),
    SPOKE_POLYGON_RPC_URL_WS: z.string().url(),
    SPOKE_POLYGON_RPC_URL_HTTP: z.string().url(),
    SPOKE_POLYGON_START_BLOCK: z.coerce.bigint().default(0n),
    SPOKE_POLYGON_FINALITY_DEPTH: z.coerce
        .number()
        .int()
        .positive()
        .default(DEFAULT_FINALITY.spoke),
    SPOKE_POLYGON_DEPOSIT_GATEWAY_ADDRESS: optionalHex,
    SPOKE_POLYGON_VAULT_STABLE_ADDRESS: optionalHex,
});

export type RawEnv = z.infer<typeof baseEnvSchema>;

export interface AppConfig {
    databaseUrl: string;
    port: number;
    logLevel: string;
    nodeEnv: "development" | "test" | "production";
    chains: ChainConfig[];
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
    const parsed = baseEnvSchema.safeParse(source);
    if (!parsed.success) {
        const issues = parsed.error.issues
            .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
            .join("\n");
        throw new Error(`Invalid indexer-v3 configuration:\n${issues}`);
    }
    const env = parsed.data;

    const chains: ChainConfig[] = [
        buildChain(env, CHAIN_KEYS.HUB, "hub", {
            balanceLedger: env.BALANCE_LEDGER_ADDRESS,
            centuari: env.CENTUARI_ADDRESS,
            hubDepositor: env.HUB_DEPOSITOR_ADDRESS,
            hubIntentSettler: env.HUB_INTENT_SETTLER_ADDRESS,
            withdrawalRegistry: env.WITHDRAWAL_REGISTRY_ADDRESS,
            settlementLedger: env.SETTLEMENT_LEDGER_ADDRESS,
            collateralManager: env.COLLATERAL_MANAGER_ADDRESS,
        }),
        buildChain(env, CHAIN_KEYS.SPOKE_BASE, "spoke", {
            spokeDepositGateway: env.SPOKE_BASE_DEPOSIT_GATEWAY_ADDRESS,
            spokeVaultStable: env.SPOKE_BASE_VAULT_STABLE_ADDRESS,
        }),
        buildChain(env, CHAIN_KEYS.SPOKE_ETHEREUM, "spoke", {
            spokeDepositGateway: env.SPOKE_ETHEREUM_DEPOSIT_GATEWAY_ADDRESS,
            spokeVaultStable: env.SPOKE_ETHEREUM_VAULT_STABLE_ADDRESS,
        }),
        buildChain(env, CHAIN_KEYS.SPOKE_BNB, "spoke", {
            spokeDepositGateway: env.SPOKE_BNB_DEPOSIT_GATEWAY_ADDRESS,
            spokeVaultStable: env.SPOKE_BNB_VAULT_STABLE_ADDRESS,
        }),
        buildChain(env, CHAIN_KEYS.SPOKE_POLYGON, "spoke", {
            spokeDepositGateway: env.SPOKE_POLYGON_DEPOSIT_GATEWAY_ADDRESS,
            spokeVaultStable: env.SPOKE_POLYGON_VAULT_STABLE_ADDRESS,
        }),
    ];

    return {
        databaseUrl: env.DATABASE_URL,
        port: env.PORT,
        logLevel: env.LOG_LEVEL,
        nodeEnv: env.NODE_ENV,
        chains,
    };
}

function buildChain(
    env: RawEnv,
    key: ChainKey,
    role: ChainRole,
    contracts: ChainContracts,
): ChainConfig {
    // Address the env entries by key prefix.
    const prefix = key as keyof RawEnv & string;
    const read = <T>(field: string): T => {
        const value = (env as unknown as Record<string, T | undefined>)[
            `${prefix}_${field}`
        ];
        if (value === undefined) {
            throw new Error(`Missing env: ${prefix}_${field}`);
        }
        return value;
    };

    return {
        id: read<number>("CHAIN_ID"),
        key,
        role,
        rpcUrlWs: read<string>("RPC_URL_WS"),
        rpcUrlHttp: read<string>("RPC_URL_HTTP"),
        startBlock: read<bigint>("START_BLOCK"),
        finalityDepth: read<number>("FINALITY_DEPTH"),
        contracts,
    };
}
