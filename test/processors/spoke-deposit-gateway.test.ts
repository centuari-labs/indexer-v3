import {
    depositInitiated,
    depositRefunded,
    spokeNativeDeposit,
} from "../../src/processors/spoke-deposit-gateway.processor.js";
import { hexToBytea } from "../../src/db/bytea.js";
import { makeSpokeChain } from "../helpers/chain.js";
import {
    FakePoolClient,
    asPoolClient,
    stageAlreadyStamped,
    stageNotYetStamped,
} from "../helpers/fake-client.js";
import { makeLog } from "../helpers/log.js";

const DEPOSIT_ID = ("0x" + "cd".repeat(32)) as `0x${string}`;
const USER = "0x1111111111111111111111111111111111111111" as const;
const ASSET = "0x2222222222222222222222222222222222222222" as const;

const INITIATE_INPUTS = [
    { name: "depositId", type: "bytes32", indexed: true },
    { name: "user", type: "address", indexed: true },
    { name: "asset", type: "address", indexed: true },
    { name: "amount", type: "uint256", indexed: false },
    { name: "hubEid", type: "uint32", indexed: false },
    { name: "lzGuid", type: "bytes32", indexed: false },
] as const;

const DEPOSIT_INITIATED_EVENT = {
    type: "event",
    name: "DepositInitiated",
    inputs: INITIATE_INPUTS,
} as const;

const SPOKE_NATIVE_DEPOSIT_EVENT = {
    type: "event",
    name: "SpokeNativeDeposit",
    inputs: INITIATE_INPUTS,
} as const;

const DEPOSIT_REFUNDED_EVENT = {
    type: "event",
    name: "DepositRefunded",
    inputs: [
        { name: "depositId", type: "bytes32", indexed: true },
        { name: "user", type: "address", indexed: true },
        { name: "asset", type: "address", indexed: true },
        { name: "amount", type: "uint256", indexed: false },
    ],
} as const;

describe("spoke-deposit-gateway processor", () => {
    test("DepositInitiated seeds row with custody_type=BRIDGED + state=INITIATED", async () => {
        const fake = new FakePoolClient();
        stageNotYetStamped(fake);
        await depositInitiated.handle({
            client: asPoolClient(fake),
            chain: makeSpokeChain({ id: 84532 }),
            log: makeLog({
                event: DEPOSIT_INITIATED_EVENT,
                args: {
                    depositId: DEPOSIT_ID,
                    user: USER,
                    asset: ASSET,
                    amount: 1000n,
                    hubEid: 30110,
                    lzGuid: ("0x" + "ee".repeat(32)) as `0x${string}`,
                },
            }),
        });
        const ins = fake.findBySqlContains("INSERT INTO cross_chain_deposit");
        expect(ins).toBeDefined();
        expect(ins!.sql).toContain("'INITIATED'");
        // params: depositId, user, source_chain (chain.id), asset, amount,
        //         custody_type, tx, logIdx, blockHash, blockNum
        expect(ins!.params[0]).toEqual(hexToBytea(DEPOSIT_ID));
        expect(ins!.params[2]).toBe(84532);
        expect(ins!.params[5]).toBe("BRIDGED");
    });

    test("SpokeNativeDeposit seeds row with custody_type=SPOKE_NATIVE", async () => {
        const fake = new FakePoolClient();
        stageNotYetStamped(fake);
        await spokeNativeDeposit.handle({
            client: asPoolClient(fake),
            chain: makeSpokeChain({ id: 84532 }),
            log: makeLog({
                event: SPOKE_NATIVE_DEPOSIT_EVENT,
                args: {
                    depositId: DEPOSIT_ID,
                    user: USER,
                    asset: ASSET,
                    amount: 1n,
                    hubEid: 30110,
                    lzGuid: ("0x" + "ee".repeat(32)) as `0x${string}`,
                },
            }),
        });
        const ins = fake.findBySqlContains("INSERT INTO cross_chain_deposit");
        expect(ins).toBeDefined();
        expect(ins!.params[5]).toBe("SPOKE_NATIVE");
    });

    test("DepositInitiated skips entirely when already stamped", async () => {
        const fake = new FakePoolClient();
        stageAlreadyStamped(fake);
        await depositInitiated.handle({
            client: asPoolClient(fake),
            chain: makeSpokeChain(),
            log: makeLog({
                event: DEPOSIT_INITIATED_EVENT,
                args: {
                    depositId: DEPOSIT_ID,
                    user: USER,
                    asset: ASSET,
                    amount: 1n,
                    hubEid: 1,
                    lzGuid: ("0x" + "ee".repeat(32)) as `0x${string}`,
                },
            }),
        });
        expect(
            fake.filterBySqlContains("INSERT INTO cross_chain_deposit"),
        ).toHaveLength(0);
    });

    test("DepositRefunded transitions any non-REFUNDED row to REFUNDED", async () => {
        const fake = new FakePoolClient();
        await depositRefunded.handle({
            client: asPoolClient(fake),
            chain: makeSpokeChain(),
            log: makeLog({
                event: DEPOSIT_REFUNDED_EVENT,
                args: {
                    depositId: DEPOSIT_ID,
                    user: USER,
                    asset: ASSET,
                    amount: 1000n,
                },
            }),
        });
        const upd = fake.findBySqlContains("UPDATE cross_chain_deposit");
        expect(upd).toBeDefined();
        expect(upd!.sql).toContain("state = 'REFUNDED'");
        expect(upd!.sql).toContain("state <> 'REFUNDED'");
    });
});
