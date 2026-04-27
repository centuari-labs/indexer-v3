import type { ChainConfig } from "../../src/config/chains.js";

export function makeHubChain(overrides: Partial<ChainConfig> = {}): ChainConfig {
    return {
        id: 421614,
        key: "HUB",
        role: "hub",
        rpcUrlWs: "ws://localhost:0",
        rpcUrlHttp: "http://localhost:0",
        startBlock: 0n,
        finalityDepth: 12,
        contracts: {
            balanceLedger: "0x0000000000000000000000000000000000000001",
            centuari: "0x0000000000000000000000000000000000000002",
            hubDepositor: "0x0000000000000000000000000000000000000003",
            hubIntentSettler: "0x0000000000000000000000000000000000000004",
            withdrawalRegistry: "0x0000000000000000000000000000000000000005",
            settlementLedger: "0x0000000000000000000000000000000000000006",
            collateralManager: "0x0000000000000000000000000000000000000007",
        },
        ...overrides,
    };
}

export function makeSpokeChain(
    overrides: Partial<ChainConfig> = {},
): ChainConfig {
    return {
        id: 84532,
        key: "SPOKE_BASE",
        role: "spoke",
        rpcUrlWs: "ws://localhost:0",
        rpcUrlHttp: "http://localhost:0",
        startBlock: 0n,
        finalityDepth: 32,
        contracts: {
            spokeDepositGateway: "0x0000000000000000000000000000000000000010",
            spokeVaultStable: "0x0000000000000000000000000000000000000011",
        },
        ...overrides,
    };
}
