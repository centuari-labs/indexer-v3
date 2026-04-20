import { Counter, Gauge, Registry, collectDefaultMetrics } from "prom-client";

export const registry = new Registry();

collectDefaultMetrics({ register: registry });

export const blockLagSeconds = new Gauge({
    name: "indexer_block_lag_seconds",
    help: "Lag (seconds) between current chain head and last indexed block.",
    labelNames: ["chain_id"],
    registers: [registry],
});

export const eventsProcessedTotal = new Counter({
    name: "indexer_events_processed_total",
    help: "Total decoded events routed to a processor.",
    labelNames: ["chain_id", "contract", "event"],
    registers: [registry],
});

export const reorgDepth = new Gauge({
    name: "indexer_reorg_depth",
    help: "Depth (in blocks) of the most recent reorg handled, per chain.",
    labelNames: ["chain_id"],
    registers: [registry],
});

export const chainHeadBlock = new Gauge({
    name: "indexer_chain_head_block",
    help: "Latest RPC head block number observed.",
    labelNames: ["chain_id"],
    registers: [registry],
});

export const cursorBlock = new Gauge({
    name: "indexer_cursor_block",
    help: "Last block persisted to block_cursor.",
    labelNames: ["chain_id"],
    registers: [registry],
});
