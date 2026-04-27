import {
    type AbiEvent,
    type Hex,
    type Log,
    encodeAbiParameters,
    encodeEventTopics,
} from "viem";

/**
 * Build a viem `Log` whose `topics` + `data` round-trip through
 * `decodeEventLog(abi, ...)` to the supplied args. Use for processor
 * unit tests that drive the same code path the real indexer does.
 */
export function makeLog<TArgs extends Record<string, unknown>>(args: {
    event: AbiEvent;
    args: TArgs;
    address?: Hex;
    transactionHash?: Hex;
    blockHash?: Hex;
    blockNumber?: bigint;
    logIndex?: number;
    transactionIndex?: number;
}): Log {
    const topics = encodeEventTopics({
        abi: [args.event],
        eventName: args.event.name,
        args: args.args as never,
    });

    const nonIndexed = args.event.inputs.filter((i) => !i.indexed);
    const data: Hex =
        nonIndexed.length === 0
            ? "0x"
            : encodeAbiParameters(
                  nonIndexed,
                  nonIndexed.map(
                      (i) => (args.args as Record<string, unknown>)[i.name!],
                  ),
              );

    return {
        address:
            (args.address ??
                "0x0000000000000000000000000000000000000001") as Hex,
        topics: topics as [Hex, ...Hex[]],
        data,
        blockNumber: args.blockNumber ?? 100n,
        blockHash: (args.blockHash ??
            "0x" + "bb".repeat(32)) as Hex,
        transactionHash: (args.transactionHash ??
            "0x" + "aa".repeat(32)) as Hex,
        transactionIndex: args.transactionIndex ?? 0,
        logIndex: args.logIndex ?? 0,
        removed: false,
    } as Log;
}
