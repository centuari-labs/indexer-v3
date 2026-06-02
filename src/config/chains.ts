import type { Hex } from "viem";

export type ChainRole = "hub" | "spoke";

export interface ChainConfig {
    id: number;
    key: string; // stable key for env prefix / logs: HUB, SPOKE_BASE, ...
    role: ChainRole;
    rpcUrlWs: string;
    rpcUrlHttp: string;
    startBlock: bigint;
    /**
     * Depth we consider final. Reorg detection keeps the last N block hashes
     * and replays from the fork point on divergence.
     */
    finalityDepth: number;
    contracts: ChainContracts;
}

export interface ChainContracts {
    /** Hub-only contracts are undefined on spokes, and vice versa. */
    balanceLedger?: Hex;
    centuari?: Hex;
    hubDepositor?: Hex;
    hubIntentSettler?: Hex;
    withdrawalRegistry?: Hex;
    settlementLedger?: Hex;
    collateralManager?: Hex;
    liquidationEngine?: Hex;

    spokeDepositGateway?: Hex;
    spokeVaultStable?: Hex;
}

/** Default finality depths — overridable via env. */
export const DEFAULT_FINALITY: Record<ChainRole, number> = {
    hub: 12, // Arbitrum
    spoke: 32, // Base / BNB / Polygon; Ethereum overridden to 64 via env
};

export const CHAIN_KEYS = {
    HUB: "HUB",
    SPOKE_BASE: "SPOKE_BASE",
    SPOKE_ETHEREUM: "SPOKE_ETHEREUM",
    SPOKE_BNB: "SPOKE_BNB",
    SPOKE_POLYGON: "SPOKE_POLYGON",
} as const;

export type ChainKey = (typeof CHAIN_KEYS)[keyof typeof CHAIN_KEYS];
