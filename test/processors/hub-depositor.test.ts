import {
    deposited,
    payoutReleased,
} from "../../src/processors/hub-depositor.processor.js";
import { hexToBytea } from "../../src/db/bytea.js";
import { makeHubChain } from "../helpers/chain.js";
import { FakePoolClient, asPoolClient } from "../helpers/fake-client.js";
import { makeLog } from "../helpers/log.js";

const USER = "0x1111111111111111111111111111111111111111" as const;
const ASSET = "0x2222222222222222222222222222222222222222" as const;

const DEPOSITED_EVENT = {
    type: "event",
    name: "Deposited",
    inputs: [
        { name: "user", type: "address", indexed: true },
        { name: "asset", type: "address", indexed: true },
        { name: "amount", type: "uint256", indexed: false },
    ],
} as const;

const PAYOUT_RELEASED_EVENT = {
    type: "event",
    name: "PayoutReleased",
    inputs: [
        { name: "user", type: "address", indexed: true },
        { name: "asset", type: "address", indexed: true },
        { name: "amount", type: "uint256", indexed: false },
    ],
} as const;

describe("hub-depositor processor", () => {
    test("Deposited inserts a deposit_event with kind=DEPOSIT", async () => {
        const fake = new FakePoolClient();
        await deposited.handle({
            client: asPoolClient(fake),
            chain: makeHubChain(),
            log: makeLog({
                event: DEPOSITED_EVENT,
                args: { user: USER, asset: ASSET, amount: 1000n },
            }),
        });
        const ins = fake.findBySqlContains("INSERT INTO deposit_event");
        expect(ins).toBeDefined();
        expect(ins!.sql).toContain("ON CONFLICT (tx_hash, log_index) DO NOTHING");
        // params: chain_id, user, asset, amount, tx, blockNumber, blockHash, logIndex, kind
        expect(ins!.params[1]).toEqual(hexToBytea(USER));
        expect(ins!.params[2]).toEqual(hexToBytea(ASSET));
        expect(ins!.params[3]).toBe("1000");
        expect(ins!.params[8]).toBe("DEPOSIT");
    });

    test("PayoutReleased inserts a deposit_event with kind=PAYOUT", async () => {
        const fake = new FakePoolClient();
        await payoutReleased.handle({
            client: asPoolClient(fake),
            chain: makeHubChain(),
            log: makeLog({
                event: PAYOUT_RELEASED_EVENT,
                args: { user: USER, asset: ASSET, amount: 500n },
            }),
        });
        const ins = fake.findBySqlContains("INSERT INTO deposit_event");
        expect(ins).toBeDefined();
        expect(ins!.params[8]).toBe("PAYOUT");
        expect(ins!.params[3]).toBe("500");
    });

    test("uses chain.id from context for both chain_id and source_chain", async () => {
        const fake = new FakePoolClient();
        const chain = makeHubChain({ id: 421614 });
        await deposited.handle({
            client: asPoolClient(fake),
            chain,
            log: makeLog({
                event: DEPOSITED_EVENT,
                args: { user: USER, asset: ASSET, amount: 1n },
            }),
        });
        const ins = fake.findBySqlContains("INSERT INTO deposit_event");
        expect(ins).toBeDefined();
        // SQL passes $1 twice (chain_id + source_chain)
        expect(ins!.sql).toContain("VALUES ($1, $2, $3, $4::numeric, $1");
        expect(ins!.params[0]).toBe(421614);
    });
});
