import {
    borrowPositionCreated,
    lendPositionCreated,
    lendPositionWithdrawn,
    marketCreated,
    repaid,
} from "../../src/processors/centuari.processor.js";
import { hexToBytea } from "../../src/db/bytea.js";
import { makeHubChain } from "../helpers/chain.js";
import {
    FakePoolClient,
    asPoolClient,
    stageAlreadyStamped,
    stageNotYetStamped,
} from "../helpers/fake-client.js";
import { makeLog } from "../helpers/log.js";

const MARKET_ID = ("0x" + "11".repeat(32)) as `0x${string}`;
const LOAN_TOKEN = "0x2222222222222222222222222222222222222222" as const;
const BORROWER = "0x3333333333333333333333333333333333333333" as const;
const LENDER = "0x4444444444444444444444444444444444444444" as const;
const BOND_TOKEN = "0x5555555555555555555555555555555555555555" as const;

const MARKET_CREATED_EVENT = {
    type: "event",
    name: "MarketCreated",
    inputs: [
        { name: "marketId", type: "bytes32", indexed: true },
        { name: "loanToken", type: "address", indexed: true },
        { name: "maturity", type: "uint256", indexed: true },
    ],
} as const;

const BORROW_POSITION_CREATED_EVENT = {
    type: "event",
    name: "BorrowPositionCreated",
    inputs: [
        { name: "marketId", type: "bytes32", indexed: true },
        { name: "borrower", type: "address", indexed: true },
        { name: "principal", type: "uint256", indexed: false },
        { name: "debt", type: "uint256", indexed: false },
        { name: "rate", type: "uint256", indexed: false },
    ],
} as const;

const LEND_POSITION_CREATED_EVENT = {
    type: "event",
    name: "LendPositionCreated",
    inputs: [
        { name: "marketId", type: "bytes32", indexed: true },
        { name: "lender", type: "address", indexed: true },
        { name: "bondToken", type: "address", indexed: true },
        { name: "cbtAmount", type: "uint256", indexed: false },
        { name: "principal", type: "uint256", indexed: false },
        { name: "rate", type: "uint256", indexed: false },
    ],
} as const;

const LEND_POSITION_WITHDRAWN_EVENT = {
    type: "event",
    name: "LendPositionWithdrawn",
    inputs: [
        { name: "marketId", type: "bytes32", indexed: true },
        { name: "lender", type: "address", indexed: true },
        { name: "cbtBurned", type: "uint256", indexed: false },
        { name: "amountWithdrawn", type: "uint256", indexed: false },
    ],
} as const;

const REPAID_EVENT = {
    type: "event",
    name: "Repaid",
    inputs: [
        { name: "marketId", type: "bytes32", indexed: true },
        { name: "borrower", type: "address", indexed: true },
        { name: "amount", type: "uint256", indexed: false },
    ],
} as const;

describe("centuari processor", () => {
    test("MarketCreated upserts market with INSERT...DO NOTHING shape", async () => {
        const fake = new FakePoolClient();
        await marketCreated.handle({
            client: asPoolClient(fake),
            chain: makeHubChain(),
            log: makeLog({
                event: MARKET_CREATED_EVENT,
                args: {
                    marketId: MARKET_ID,
                    loanToken: LOAN_TOKEN,
                    maturity: 1_800_000_000n,
                },
            }),
        });
        const insert = fake.findBySqlContains("INSERT INTO market");
        expect(insert).toBeDefined();
        expect(insert!.sql).toContain("ON CONFLICT (market_id) DO NOTHING");
        expect(insert!.params[0]).toEqual(hexToBytea(MARKET_ID));
        expect(insert!.params[1]).toEqual(hexToBytea(LOAN_TOKEN));
        expect(insert!.params[2]).toBe("1800000000");
    });

    test("BorrowPositionCreated stamps + accumulates principal/debt + EXCLUDED.rate", async () => {
        const fake = new FakePoolClient();
        stageNotYetStamped(fake);

        await borrowPositionCreated.handle({
            client: asPoolClient(fake),
            chain: makeHubChain(),
            log: makeLog({
                event: BORROW_POSITION_CREATED_EVENT,
                args: {
                    marketId: MARKET_ID,
                    borrower: BORROWER,
                    principal: 1000n,
                    debt: 1100n,
                    rate: 500n,
                },
            }),
        });
        const insert = fake.findBySqlContains("INSERT INTO borrow_position");
        expect(insert).toBeDefined();
        expect(insert!.sql).toContain(
            "principal = borrow_position.principal + EXCLUDED.principal",
        );
        expect(insert!.sql).toContain(
            "debt = borrow_position.debt + EXCLUDED.debt",
        );
        expect(insert!.sql).toContain("rate = EXCLUDED.rate");
        expect(insert!.params[2]).toBe("1000");
        expect(insert!.params[3]).toBe("1100");
        expect(insert!.params[4]).toBe("500");
    });

    test("BorrowPositionCreated skips when already stamped", async () => {
        const fake = new FakePoolClient();
        stageAlreadyStamped(fake);
        await borrowPositionCreated.handle({
            client: asPoolClient(fake),
            chain: makeHubChain(),
            log: makeLog({
                event: BORROW_POSITION_CREATED_EVENT,
                args: {
                    marketId: MARKET_ID,
                    borrower: BORROWER,
                    principal: 1n,
                    debt: 1n,
                    rate: 1n,
                },
            }),
        });
        expect(
            fake.filterBySqlContains("INSERT INTO borrow_position"),
        ).toHaveLength(0);
    });

    test("LendPositionCreated accumulates cbt_balance + principal + latest-wins rate", async () => {
        const fake = new FakePoolClient();
        stageNotYetStamped(fake);

        await lendPositionCreated.handle({
            client: asPoolClient(fake),
            chain: makeHubChain(),
            log: makeLog({
                event: LEND_POSITION_CREATED_EVENT,
                args: {
                    marketId: MARKET_ID,
                    lender: LENDER,
                    bondToken: BOND_TOKEN,
                    cbtAmount: 500n,
                    principal: 500n,
                    rate: 450n,
                },
            }),
        });
        const insert = fake.findBySqlContains("INSERT INTO lend_position");
        expect(insert).toBeDefined();
        expect(insert!.sql).toContain(
            "cbt_balance = lend_position.cbt_balance + EXCLUDED.cbt_balance",
        );
        expect(insert!.sql).toContain(
            "principal = lend_position.principal + EXCLUDED.principal",
        );
        expect(insert!.params[2]).toEqual(hexToBytea(BOND_TOKEN));
    });

    test("LendPositionWithdrawn produces an UPDATE with GREATEST(cbt - x, 0)", async () => {
        const fake = new FakePoolClient();
        stageNotYetStamped(fake);

        await lendPositionWithdrawn.handle({
            client: asPoolClient(fake),
            chain: makeHubChain(),
            log: makeLog({
                event: LEND_POSITION_WITHDRAWN_EVENT,
                args: {
                    marketId: MARKET_ID,
                    lender: LENDER,
                    cbtBurned: 100n,
                    amountWithdrawn: 110n,
                },
            }),
        });
        const upd = fake.findBySqlContains("UPDATE lend_position");
        expect(upd).toBeDefined();
        expect(upd!.sql).toContain(
            "cbt_balance = GREATEST(cbt_balance - $3::numeric, 0)",
        );
        expect(upd!.sql).toContain(
            "principal = GREATEST(principal - $4::numeric, 0)",
        );
        expect(upd!.sql).toContain("WHERE market_id = $1 AND lender = $2");
    });

    test("Repaid produces an UPDATE that does NOT touch used_as_collateral", async () => {
        const fake = new FakePoolClient();
        stageNotYetStamped(fake);

        await repaid.handle({
            client: asPoolClient(fake),
            chain: makeHubChain(),
            log: makeLog({
                event: REPAID_EVENT,
                args: {
                    marketId: MARKET_ID,
                    borrower: BORROWER,
                    amount: 200n,
                },
            }),
        });
        const upd = fake.findBySqlContains("UPDATE borrow_position");
        expect(upd).toBeDefined();
        // Loophole-fix invariant: repay must not call BalanceLedger.unmarkCollateral
        // and must not write to user_balance from this processor.
        expect(upd!.sql).not.toContain("used_as_collateral");
        expect(upd!.sql).not.toContain("user_balance");
        expect(upd!.sql).toContain("debt = GREATEST(debt - $3::numeric, 0)");
        expect(upd!.params[2]).toBe("200");
    });
});
