# indexer-v3 — Dependency Scan (2026-06-08)

External-audit prep, Phase 0.3. Hub-only launch scope.

- **Tool:** `pnpm audit` (pnpm v10.10.0)
- **Raw output:** [`dependency-scan-2026-06-08.json`](./dependency-scan-2026-06-08.json) (captures the pre-remediation findings)
- **Disposition:** all 3 advisories **patched** via `pnpm.overrides`; re-scan is clean.

## Findings as scanned (pre-remediation)

| Severity | Package | Path (transitive) | Vulnerable | Patched | Advisory |
|---|---|---|---|---|---|
| HIGH | `fast-uri` | `fastify › @fastify/ajv-compiler › fast-uri` | `<=3.1.0` | `>=3.1.1` | [GHSA-q3j6-qgpj-74h6](https://github.com/advisories/GHSA-q3j6-qgpj-74h6) — path traversal via percent-encoded dot segments |
| HIGH | `fast-uri` | `fastify › @fastify/ajv-compiler › fast-uri` | `<=3.1.1` | `>=3.1.2` | [GHSA-v39h-62p7-jpjc](https://github.com/advisories/GHSA-v39h-62p7-jpjc) — host confusion via percent-encoded authority delimiters |
| MODERATE | `ws` | `viem › ws` (also `viem › isows › ws`) | `>=8.0.0 <8.20.1` | `>=8.20.1` | [GHSA-58qx-3vcg-4xpx](https://github.com/advisories/GHSA-58qx-3vcg-4xpx) — uninitialized memory disclosure |

Totals as scanned: **2 high, 1 moderate, 0 critical.** All three are **transitive** dependencies — none are direct.

## Exposure assessment (hub-only)

- **`fast-uri`** is pulled in by Fastify's Ajv schema compiler. indexer-v3's Fastify surface is ops-only — `/health` + `/metrics`, no consumer-facing data API and no user-supplied URI/schema validation on the hot path. Real exposure is low, but both advisories are HIGH and the fix is a patch-level bump, so we patch.
- **`ws`** is used by Viem for the WebSocket RPC transport (the hub `ChainWatcher` `watchEvent` connection). The indexer is the *client*, dialing a trusted RPC provider (Alchemy/Infura/QuickNode), not accepting inbound frames from untrusted peers. Real exposure is low; patched anyway as it is a safe in-major bump.

## Remediation (applied)

Added `pnpm.overrides` to `package.json` — low-risk, in-major patch bumps that keep Fastify and Viem on their existing major lines:

```json
"pnpm": {
  "overrides": {
    "fast-uri@<3.1.2": ">=3.1.2",
    "ws@>=8.0.0 <8.20.1": ">=8.20.1"
  }
}
```

Resolved after `pnpm install`:

- `fast-uri` → **3.1.2**
- `ws` → **8.21.0** (Viem peer + `isows`)

Post-remediation `pnpm audit` → **"No known vulnerabilities found."**

Regression check after the bumps: `TZ=UTC pnpm run test` → 76/76 green; `pnpm run typecheck` → clean.

## Disposition

**All findings remediated.** No advisories accepted/deferred. The committed
`pnpm-lock.yaml` pins the patched versions, so the fix persists for fresh installs and Docker builds.
