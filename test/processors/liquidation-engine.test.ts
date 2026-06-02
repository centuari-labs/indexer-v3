import {
    badDebtRemains,
    liquidated,
} from "../../src/processors/liquidation-engine.processor.js";
import { hexToBytea } from "../../src/db/bytea.js";
import { makeHubChain } from "../helpers/chain.js";
import { FakePoolClient, asPoolClient } from "../helpers/fake-client.js";
import { makeLog } from "../helpers/log.js";

const MARKET_ID = ("0x" + "11".repeat(32)) as `0x${string}`;
const BORROWER = "0x3333333333333333333333333333333333333333" as const;
const LIQUIDATOR = "0x6666666666666666666666666666666666666666" as const;
const LOAN_TOKEN = "0x2222222222222222222222222222222222222222" as const;
const COLLATERAL = "0x7777777777777777777777777777777777777777" as const;

const LIQUIDATED_EVENT = {
    type: "event",
    name: "Liquidated",
    inputs: [
        { name: "borrower", type: "address", indexed: true },
        { name: "liquidator", type: "address", indexed: true },
        { name: "marketId", type: "bytes32", indexed: true },
        { name: "loanToken", type: "address", indexed: false },
        { name: "collateralAsset", type: "address", indexed: false },
        { name: "repaid", type: "uint256", indexed: false },
        { name: "collateralSeized", type: "uint256", indexed: false },
        { name: "viaMaturity", type: "bool", indexed: false },
    ],
} as const;

const BAD_DEBT_REMAINS_EVENT = {
    type: "event",
    name: "BadDebtRemains",
    inputs: [
        { name: "borrower", type: "address", indexed: true },
        { name: "marketId", type: "bytes32", indexed: true },
        { name: "remainingDebt", type: "uint256", indexed: false },
    ],
} as const;

describe("liquidation-engine processor", () => {
    test("Liquidated inserts an audit row, idempotent on (tx, log)", async () => {
        const fake = new FakePoolClient();
        await liquidated.handle({
            client: asPoolClient(fake),
            chain: makeHubChain(),
            log: makeLog({
                event: LIQUIDATED_EVENT,
                args: {
                    borrower: BORROWER,
                    liquidator: LIQUIDATOR,
                    marketId: MARKET_ID,
                    loanToken: LOAN_TOKEN,
                    collateralAsset: COLLATERAL,
                    repaid: 1000n,
                    collateralSeized: 1080n,
                    viaMaturity: false,
                },
                logIndex: 5,
            }),
        });
        const ins = fake.findBySqlContains("INSERT INTO liquidation_event");
        expect(ins).toBeDefined();
        expect(ins!.sql).toContain(
            "ON CONFLICT (applied_by_tx_hash, applied_by_log_index) DO NOTHING",
        );
        expect(ins!.params[0]).toEqual(hexToBytea(BORROWER));
        expect(ins!.params[1]).toEqual(hexToBytea(LIQUIDATOR));
        expect(ins!.params[2]).toEqual(hexToBytea(MARKET_ID));
        expect(ins!.params[3]).toEqual(hexToBytea(LOAN_TOKEN));
        expect(ins!.params[4]).toEqual(hexToBytea(COLLATERAL));
        expect(ins!.params[5]).toBe("1000");
        expect(ins!.params[6]).toBe("1080");
        expect(ins!.params[7]).toBe(false);
        expect(ins!.params[9]).toBe(5); // applied_by_log_index
    });

    test("Liquidated carries viaMaturity=true for the matured path", async () => {
        const fake = new FakePoolClient();
        await liquidated.handle({
            client: asPoolClient(fake),
            chain: makeHubChain(),
            log: makeLog({
                event: LIQUIDATED_EVENT,
                args: {
                    borrower: BORROWER,
                    liquidator: LIQUIDATOR,
                    marketId: MARKET_ID,
                    loanToken: LOAN_TOKEN,
                    collateralAsset: COLLATERAL,
                    repaid: 2000n,
                    collateralSeized: 2160n,
                    viaMaturity: true,
                },
            }),
        });
        const ins = fake.findBySqlContains("INSERT INTO liquidation_event");
        expect(ins!.params[7]).toBe(true);
    });

    test("BadDebtRemains stamps the residual onto the nearest-preceding Liquidated row", async () => {
        const fake = new FakePoolClient();
        fake.queueResponse([{}]); // UPDATE matches one row
        await badDebtRemains.handle({
            client: asPoolClient(fake),
            chain: makeHubChain(),
            log: makeLog({
                event: BAD_DEBT_REMAINS_EVENT,
                args: {
                    borrower: BORROWER,
                    marketId: MARKET_ID,
                    remainingDebt: 500n,
                },
                logIndex: 6,
            }),
        });
        const upd = fake.findBySqlContains("UPDATE liquidation_event");
        expect(upd).toBeDefined();
        expect(upd!.sql).toContain("SET remaining_debt = $5::numeric");
        // Targets the nearest preceding Liquidated row (same tx/borrower/market,
        // strictly lower logIndex) so a multi-liquidation tx never smears.
        expect(upd!.sql).toContain("applied_by_tx_hash = $1");
        expect(upd!.sql).toContain("borrower = $2");
        expect(upd!.sql).toContain("market_id = $3");
        expect(upd!.sql).toContain("applied_by_log_index < $4");
        expect(upd!.sql).toContain("ORDER BY applied_by_log_index DESC");
        expect(upd!.params[1]).toEqual(hexToBytea(BORROWER));
        expect(upd!.params[2]).toEqual(hexToBytea(MARKET_ID));
        expect(upd!.params[3]).toBe(6); // this BadDebtRemains logIndex
        expect(upd!.params[4]).toBe("500");
    });

    test("BadDebtRemains with no matching Liquidated row issues the UPDATE and does not throw", async () => {
        const fake = new FakePoolClient();
        // No staged response → UPDATE returns rowCount 0 → warn branch.
        await expect(
            badDebtRemains.handle({
                client: asPoolClient(fake),
                chain: makeHubChain(),
                log: makeLog({
                    event: BAD_DEBT_REMAINS_EVENT,
                    args: {
                        borrower: BORROWER,
                        marketId: MARKET_ID,
                        remainingDebt: 1n,
                    },
                }),
            }),
        ).resolves.toBeUndefined();
        expect(
            fake.findBySqlContains("UPDATE liquidation_event"),
        ).toBeDefined();
    });
});
