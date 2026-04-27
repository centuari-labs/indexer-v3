import {
    collateralFlagSet,
    credited,
    debited,
} from "../../src/processors/balance-ledger.processor.js";
import { hexToBytea } from "../../src/db/bytea.js";
import { makeHubChain } from "../helpers/chain.js";
import {
    FakePoolClient,
    asPoolClient,
    stageAlreadyStamped,
    stageNotYetStamped,
} from "../helpers/fake-client.js";
import { makeLog } from "../helpers/log.js";

const USER = "0x1111111111111111111111111111111111111111" as const;
const ASSET = "0x2222222222222222222222222222222222222222" as const;
const WRITER = "0x3333333333333333333333333333333333333333" as const;
const TX = ("0x" + "aa".repeat(32)) as `0x${string}`;
const BLOCK = ("0x" + "bb".repeat(32)) as `0x${string}`;

const CREDITED_EVENT = {
    type: "event",
    name: "Credited",
    inputs: [
        { name: "writer", type: "address", indexed: true },
        { name: "user", type: "address", indexed: true },
        { name: "asset", type: "address", indexed: true },
        { name: "amount", type: "uint256", indexed: false },
        { name: "newAvailable", type: "uint256", indexed: false },
    ],
} as const;

const DEBITED_EVENT = {
    type: "event",
    name: "Debited",
    inputs: [
        { name: "writer", type: "address", indexed: true },
        { name: "user", type: "address", indexed: true },
        { name: "asset", type: "address", indexed: true },
        { name: "amount", type: "uint256", indexed: false },
        { name: "newAvailable", type: "uint256", indexed: false },
    ],
} as const;

const COLLATERAL_FLAG_SET_EVENT = {
    type: "event",
    name: "CollateralFlagSet",
    inputs: [
        { name: "writer", type: "address", indexed: true },
        { name: "user", type: "address", indexed: true },
        { name: "asset", type: "address", indexed: true },
        { name: "used", type: "bool", indexed: false },
        { name: "flaggedAt", type: "uint64", indexed: false },
    ],
} as const;

describe("balance-ledger processor", () => {
    test("Credited stamps + writes a positive delta into available", async () => {
        const fake = new FakePoolClient();
        stageNotYetStamped(fake);

        await credited.handle({
            client: asPoolClient(fake),
            chain: makeHubChain(),
            log: makeLog({
                event: CREDITED_EVENT,
                args: {
                    writer: WRITER,
                    user: USER,
                    asset: ASSET,
                    amount: 1000n,
                    newAvailable: 1000n,
                },
                transactionHash: TX,
                blockHash: BLOCK,
                blockNumber: 555n,
                logIndex: 3,
            }),
        });

        const insert = fake.findBySqlContains("INSERT INTO user_balance");
        expect(insert).toBeDefined();
        // Param order matches handler: user, asset, delta, txHash, logIndex,
        //                              blockHash, blockNumber.
        expect(insert!.params[0]).toEqual(hexToBytea(USER));
        expect(insert!.params[1]).toEqual(hexToBytea(ASSET));
        expect(insert!.params[2]).toBe("1000");
        expect(insert!.params[3]).toEqual(hexToBytea(TX));
        expect(insert!.params[4]).toBe(3);
        expect(insert!.params[5]).toEqual(hexToBytea(BLOCK));
        expect(insert!.params[6]).toBe("555");
    });

    test("Debited writes the negative delta", async () => {
        const fake = new FakePoolClient();
        stageNotYetStamped(fake);

        await debited.handle({
            client: asPoolClient(fake),
            chain: makeHubChain(),
            log: makeLog({
                event: DEBITED_EVENT,
                args: {
                    writer: WRITER,
                    user: USER,
                    asset: ASSET,
                    amount: 250n,
                    newAvailable: 750n,
                },
            }),
        });

        const insert = fake.findBySqlContains("INSERT INTO user_balance");
        expect(insert).toBeDefined();
        expect(insert!.params[2]).toBe("-250");
    });

    test("Credited skips entirely when (tx_hash, log_index) is already stamped", async () => {
        const fake = new FakePoolClient();
        stageAlreadyStamped(fake);

        await credited.handle({
            client: asPoolClient(fake),
            chain: makeHubChain(),
            log: makeLog({
                event: CREDITED_EVENT,
                args: {
                    writer: WRITER,
                    user: USER,
                    asset: ASSET,
                    amount: 1000n,
                    newAvailable: 1000n,
                },
            }),
        });

        // Only the idempotency SELECT should run. No INSERT.
        expect(fake.filterBySqlContains("INSERT INTO user_balance")).toHaveLength(
            0,
        );
        expect(fake.filterBySqlContains("SELECT count")).toHaveLength(1);
    });

    test("Credited bails silently when log lacks tx_hash / block_hash / block_number / logIndex", async () => {
        const fake = new FakePoolClient();
        const log = makeLog({
            event: CREDITED_EVENT,
            args: {
                writer: WRITER,
                user: USER,
                asset: ASSET,
                amount: 1000n,
                newAvailable: 1000n,
            },
        });
        // viem allows null for pending logs — simulate that.
        // biome-ignore lint/suspicious/noExplicitAny: simulating pending-log shape
        (log as any).transactionHash = null;

        await credited.handle({
            client: asPoolClient(fake),
            chain: makeHubChain(),
            log,
        });

        expect(fake.recorded).toHaveLength(0);
    });

    test("CollateralFlagSet writes used=true + flaggedAt verbatim", async () => {
        const fake = new FakePoolClient();
        stageNotYetStamped(fake);

        await collateralFlagSet.handle({
            client: asPoolClient(fake),
            chain: makeHubChain(),
            log: makeLog({
                event: COLLATERAL_FLAG_SET_EVENT,
                args: {
                    writer: WRITER,
                    user: USER,
                    asset: ASSET,
                    used: true,
                    flaggedAt: 1_700_000_000n,
                },
            }),
        });

        const insert = fake.findBySqlContains("INSERT INTO user_balance");
        expect(insert).toBeDefined();
        // Handler param order: user, asset, used, flaggedAt, tx, logIdx, blockHash, blockNum
        expect(insert!.params[2]).toBe(true);
        expect(insert!.params[3]).toBe("1700000000");
    });

    test("CollateralFlagSet with used=false carries flaggedAt=0 sentinel", async () => {
        const fake = new FakePoolClient();
        stageNotYetStamped(fake);

        await collateralFlagSet.handle({
            client: asPoolClient(fake),
            chain: makeHubChain(),
            log: makeLog({
                event: COLLATERAL_FLAG_SET_EVENT,
                args: {
                    writer: WRITER,
                    user: USER,
                    asset: ASSET,
                    used: false,
                    flaggedAt: 0n,
                },
            }),
        });

        const insert = fake.findBySqlContains("INSERT INTO user_balance");
        expect(insert).toBeDefined();
        expect(insert!.params[2]).toBe(false);
        expect(insert!.params[3]).toBe("0");
    });

    test("CollateralFlagSet skips when already stamped", async () => {
        const fake = new FakePoolClient();
        stageAlreadyStamped(fake);

        await collateralFlagSet.handle({
            client: asPoolClient(fake),
            chain: makeHubChain(),
            log: makeLog({
                event: COLLATERAL_FLAG_SET_EVENT,
                args: {
                    writer: WRITER,
                    user: USER,
                    asset: ASSET,
                    used: true,
                    flaggedAt: 1n,
                },
            }),
        });

        expect(
            fake.filterBySqlContains("INSERT INTO user_balance"),
        ).toHaveLength(0);
    });
});
