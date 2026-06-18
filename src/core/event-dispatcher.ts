import type { PoolClient } from "pg";
import type { Log } from "viem";
import type { ChainConfig } from "../config/chains.js";
import { eventsProcessedTotal } from "../observability/metrics.js";

export interface ProcessorContext {
    client: PoolClient;
    chain: ChainConfig;
    log: Log;
}

/**
 * A processor subscribes to a single event topic on a single contract and
 * writes the resulting row(s) inside the caller-provided pg transaction.
 */
export interface EventProcessor {
    contract: string;
    event: string;
    topic0: `0x${string}`;
    handle: (ctx: ProcessorContext) => Promise<void>;
}

export class EventDispatcher {
    private readonly byTopic = new Map<string, EventProcessor>();

    register(proc: EventProcessor): void {
        const key = topicKey(proc.contract, proc.topic0);
        if (this.byTopic.has(key)) {
            throw new Error(
                `duplicate processor for contract=${proc.contract} topic=${proc.topic0}`,
            );
        }
        this.byTopic.set(key, proc);
    }

    async dispatch(
        client: PoolClient,
        chain: ChainConfig,
        log: Log,
        contractName: string,
    ): Promise<void> {
        const topic0 = log.topics[0];
        if (!topic0) return;
        const proc = this.byTopic.get(topicKey(contractName, topic0));
        if (!proc) return;
        await proc.handle({ client, chain, log });
        eventsProcessedTotal
            .labels(String(chain.id), proc.contract, proc.event)
            .inc();
    }
}

function topicKey(contract: string, topic0: `0x${string}`): string {
    return `${contract}::${topic0.toLowerCase()}`;
}
