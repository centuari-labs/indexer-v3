import {
    bridgedDeposited,
    bridgedRecalled,
    spokeNativeDeposited,
    spokeNativeReleased,
} from "../../src/processors/spoke-vault.processor.js";
import { makeSpokeChain } from "../helpers/chain.js";
import { FakePoolClient, asPoolClient } from "../helpers/fake-client.js";
import { makeLog } from "../helpers/log.js";

const ASSET = "0x2222222222222222222222222222222222222222" as const;
const COUNTERPARTY = "0x3333333333333333333333333333333333333333" as const;

function inputs(directionField: "from" | "to") {
    return [
        { name: "asset", type: "address", indexed: true },
        { name: directionField, type: "address", indexed: true },
        { name: "amount", type: "uint256", indexed: false },
    ] as const;
}

const BRIDGED_DEPOSITED_EVENT = {
    type: "event",
    name: "BridgedDeposited",
    inputs: inputs("from"),
} as const;
const BRIDGED_RECALLED_EVENT = {
    type: "event",
    name: "BridgedRecalled",
    inputs: inputs("to"),
} as const;
const SPOKE_NATIVE_DEPOSITED_EVENT = {
    type: "event",
    name: "SpokeNativeDeposited",
    inputs: inputs("from"),
} as const;
const SPOKE_NATIVE_RELEASED_EVENT = {
    type: "event",
    name: "SpokeNativeReleased",
    inputs: inputs("to"),
} as const;

describe("spoke-vault processor (audit-only, no DB writes)", () => {
    test.each([
        ["BridgedDeposited", bridgedDeposited, BRIDGED_DEPOSITED_EVENT, "from"],
        ["BridgedRecalled", bridgedRecalled, BRIDGED_RECALLED_EVENT, "to"],
        [
            "SpokeNativeDeposited",
            spokeNativeDeposited,
            SPOKE_NATIVE_DEPOSITED_EVENT,
            "from",
        ],
        [
            "SpokeNativeReleased",
            spokeNativeReleased,
            SPOKE_NATIVE_RELEASED_EVENT,
            "to",
        ],
    ] as const)(
        "%s decodes successfully and writes nothing to the DB",
        async (_name, processor, event, dirField) => {
            const fake = new FakePoolClient();
            await processor.handle({
                client: asPoolClient(fake),
                chain: makeSpokeChain(),
                log: makeLog({
                    event,
                    args: { asset: ASSET, [dirField]: COUNTERPARTY, amount: 1n },
                }),
            });
            expect(fake.recorded).toHaveLength(0);
        },
    );
});
