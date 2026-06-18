import { jest } from "@jest/globals";
import {
    EventDispatcher,
    type EventProcessor,
} from "../../src/core/event-dispatcher.js";
import { makeHubChain } from "../helpers/chain.js";
import { FakePoolClient, asPoolClient } from "../helpers/fake-client.js";

const TOPIC_A = `0x${"a".repeat(64)}` as `0x${string}`;
const TOPIC_B = `0x${"b".repeat(64)}` as `0x${string}`;

function makeProc(
    contract: string,
    event: string,
    topic0: `0x${string}`,
    spy?: jest.Mock,
): EventProcessor {
    return {
        contract,
        event,
        topic0,
        handle: spy ?? jest.fn(async () => {}),
    };
}

describe("EventDispatcher", () => {
    test("dispatch routes a log to the matching (contract, topic0) processor", async () => {
        const handle = jest.fn(async () => {});
        const proc = makeProc("Foo", "EventA", TOPIC_A, handle);
        const dispatcher = new EventDispatcher();
        dispatcher.register(proc);

        await dispatcher.dispatch(
            asPoolClient(new FakePoolClient()),
            makeHubChain(),
            { topics: [TOPIC_A], data: "0x" } as never,
            "Foo",
        );
        expect(handle).toHaveBeenCalledTimes(1);
    });

    test("dispatch is a no-op when contract name does not match", async () => {
        const handle = jest.fn(async () => {});
        const dispatcher = new EventDispatcher();
        dispatcher.register(makeProc("Foo", "EventA", TOPIC_A, handle));

        await dispatcher.dispatch(
            asPoolClient(new FakePoolClient()),
            makeHubChain(),
            { topics: [TOPIC_A], data: "0x" } as never,
            "Bar", // different contract name
        );
        expect(handle).not.toHaveBeenCalled();
    });

    test("dispatch is a no-op when topic0 is not registered", async () => {
        const handle = jest.fn(async () => {});
        const dispatcher = new EventDispatcher();
        dispatcher.register(makeProc("Foo", "EventA", TOPIC_A, handle));

        await dispatcher.dispatch(
            asPoolClient(new FakePoolClient()),
            makeHubChain(),
            { topics: [TOPIC_B], data: "0x" } as never,
            "Foo",
        );
        expect(handle).not.toHaveBeenCalled();
    });

    test("dispatch is a no-op when log has no topics", async () => {
        const handle = jest.fn(async () => {});
        const dispatcher = new EventDispatcher();
        dispatcher.register(makeProc("Foo", "EventA", TOPIC_A, handle));

        await dispatcher.dispatch(
            asPoolClient(new FakePoolClient()),
            makeHubChain(),
            { topics: [], data: "0x" } as never,
            "Foo",
        );
        expect(handle).not.toHaveBeenCalled();
    });

    test("register throws on duplicate (contract, topic0)", () => {
        const dispatcher = new EventDispatcher();
        dispatcher.register(makeProc("Foo", "EventA", TOPIC_A));
        expect(() =>
            dispatcher.register(makeProc("Foo", "EventA-dup", TOPIC_A)),
        ).toThrow(/duplicate processor/);
    });

    test("topic0 lookup is case-insensitive on the topic hex", async () => {
        const handle = jest.fn(async () => {});
        const dispatcher = new EventDispatcher();
        // Register lowercase, dispatch with mixed-case — must match.
        dispatcher.register(makeProc("Foo", "EventA", TOPIC_A, handle));

        const upperTopic = TOPIC_A.toUpperCase().replace(
            "0X",
            "0x",
        ) as `0x${string}`;
        await dispatcher.dispatch(
            asPoolClient(new FakePoolClient()),
            makeHubChain(),
            { topics: [upperTopic], data: "0x" } as never,
            "Foo",
        );
        expect(handle).toHaveBeenCalledTimes(1);
    });
});
