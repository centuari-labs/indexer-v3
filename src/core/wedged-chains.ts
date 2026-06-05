import { chainWedged } from "../observability/metrics.js";

/**
 * In-process registry of "wedged" chains (H1).
 *
 * A chain is wedged when `findForkPoint` detects a reorg deeper than the
 * configured finality depth: the watcher cannot self-heal and the chain must
 * stop advancing until an operator intervenes. The `ChainWatcher` swallows the
 * per-tick error to keep the other chains running (per-chain isolation), so
 * without this registry a wedged chain would silently churn every 4s and still
 * look healthy on `/health`.
 *
 * Both the Prometheus gauge `indexer_chain_wedged{chain_id}` and the `/health`
 * route read this shared state, so a wedged chain is visible to both Prometheus
 * alerting and the docker/ops healthcheck.
 */
const wedged = new Set<number>();

export function markChainWedged(chainId: number): void {
    wedged.add(chainId);
    chainWedged.labels(String(chainId)).set(1);
}

export function clearChainWedged(chainId: number): void {
    if (wedged.delete(chainId)) {
        chainWedged.labels(String(chainId)).set(0);
    } else {
        // Keep the gauge defined at 0 even if it was never wedged, so the
        // series exists for alerting.
        chainWedged.labels(String(chainId)).set(0);
    }
}

export function isChainWedged(chainId: number): boolean {
    return wedged.has(chainId);
}

export function wedgedChainIds(): number[] {
    return [...wedged];
}
