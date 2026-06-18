import {
    depositConfirmed,
    depositMarkedNoFill,
    solverFillRegistered,
} from "../../src/processors/hub-intent-settler.processor.js";
import { hexToBytea } from "../../src/db/bytea.js";
import { makeHubChain } from "../helpers/chain.js";
import {
    FakePoolClient,
    asPoolClient,
    stageAlreadyStamped,
    stageNotYetStamped,
} from "../helpers/fake-client.js";
import { makeLog } from "../helpers/log.js";

const DEPOSIT_ID = ("0x" + "ab".repeat(32)) as `0x${string}`;
const USER = "0x1111111111111111111111111111111111111111" as const;
const ASSET = "0x2222222222222222222222222222222222222222" as const;
const SOLVER = "0x3333333333333333333333333333333333333333" as const;

const DEPOSIT_CONFIRMED_EVENT = {
    type: "event",
    name: "DepositConfirmed",
    inputs: [
        { name: "depositId", type: "bytes32", indexed: true },
        { name: "user", type: "address", indexed: true },
        { name: "asset", type: "address", indexed: false },
        { name: "amount", type: "uint256", indexed: false },
        { name: "sourceChainId", type: "uint256", indexed: false },
        { name: "classification", type: "uint8", indexed: false },
    ],
} as const;

const SOLVER_FILL_EVENT = {
    type: "event",
    name: "SolverFillRegistered",
    inputs: [
        { name: "depositId", type: "bytes32", indexed: true },
        { name: "solver", type: "address", indexed: true },
        { name: "user", type: "address", indexed: true },
        { name: "asset", type: "address", indexed: false },
        { name: "amount", type: "uint256", indexed: false },
        { name: "sourceChainId", type: "uint256", indexed: false },
    ],
} as const;

const NO_FILL_EVENT = {
    type: "event",
    name: "DepositMarkedNoFill",
    inputs: [{ name: "depositId", type: "bytes32", indexed: true }],
} as const;

describe("hub-intent-settler processor", () => {
    test("DepositConfirmed transitions row to CREDITED via UPDATE", async () => {
        const fake = new FakePoolClient();
        stageNotYetStamped(fake);

        await depositConfirmed.handle({
            client: asPoolClient(fake),
            chain: makeHubChain(),
            log: makeLog({
                event: DEPOSIT_CONFIRMED_EVENT,
                args: {
                    depositId: DEPOSIT_ID,
                    user: USER,
                    asset: ASSET,
                    amount: 1000n,
                    sourceChainId: 84532n,
                    classification: 0,
                },
            }),
        });
        const upd = fake.findBySqlContains("UPDATE cross_chain_deposit");
        expect(upd).toBeDefined();
        expect(upd!.sql).toContain("state = 'CREDITED'");
        expect(upd!.sql).toContain("credited_at = now()");
        expect(upd!.sql).toContain("state IN ('INITIATED', 'BRIDGED')");
        expect(upd!.params[0]).toEqual(hexToBytea(DEPOSIT_ID));
    });

    test("DepositConfirmed skips when already stamped", async () => {
        const fake = new FakePoolClient();
        stageAlreadyStamped(fake);
        await depositConfirmed.handle({
            client: asPoolClient(fake),
            chain: makeHubChain(),
            log: makeLog({
                event: DEPOSIT_CONFIRMED_EVENT,
                args: {
                    depositId: DEPOSIT_ID,
                    user: USER,
                    asset: ASSET,
                    amount: 1n,
                    sourceChainId: 1n,
                    classification: 0,
                },
            }),
        });
        expect(
            fake.filterBySqlContains("UPDATE cross_chain_deposit"),
        ).toHaveLength(0);
    });

    test("SolverFillRegistered is decode-only — no DB writes (Phase 1 dormant)", async () => {
        const fake = new FakePoolClient();
        await solverFillRegistered.handle({
            client: asPoolClient(fake),
            chain: makeHubChain(),
            log: makeLog({
                event: SOLVER_FILL_EVENT,
                args: {
                    depositId: DEPOSIT_ID,
                    solver: SOLVER,
                    user: USER,
                    asset: ASSET,
                    amount: 1n,
                    sourceChainId: 1n,
                },
            }),
        });
        expect(fake.recorded).toHaveLength(0);
    });

    test("DepositMarkedNoFill is decode-only — no DB writes", async () => {
        const fake = new FakePoolClient();
        await depositMarkedNoFill.handle({
            client: asPoolClient(fake),
            chain: makeHubChain(),
            log: makeLog({
                event: NO_FILL_EVENT,
                args: { depositId: DEPOSIT_ID },
            }),
        });
        expect(fake.recorded).toHaveLength(0);
    });
});
