# ADR 0003: Hybrid provider packages and deployment kernel

## Status
Accepted

## Context
Provider expansion and operation safety decisions are documented in [ADR 0002](0002-provider-expansion-and-operation-safety.md).

Phase 0/1 implementation initially used files such as `manifest-v2.ts`, `plan-v2.ts`, and `engine-v2.ts`. Those names encode rollout history instead of ownership. Vercel-specific schemas and lifecycle rules leaked into generic core modules and `ship_ops`, making another provider require scattered edits and making version labels permanent architecture.

## Decision
Provider-specific behavior lives in `src/providers/<provider>/`. Each package owns its manifest, plan, state, authorization policy, credential selection, external adapter/client, execution state projection, and optional tool/command/database handlers. Persisted numeric versions remain provider contract discriminators; they are not module architecture.

`src/deployment/` owns provider-neutral verification contracts, approval primitives, generic operation execution mechanics, generic operation authorization helpers, and generic hash-chain mechanics. Provider-owned strict schemas are injected into generic persistence/journal mechanics so exact persisted validation is retained.

`src/persistence/` owns paths and JSON/atomic I/O. `src/providers/registry.ts` is the sole package composition, manifest/plan/state dispatch, execution construction, and provider handler lookup seam. Adding a provider requires its package plus an explicit registry entry. `tools/ship-ops` only validates common input and delegates to registry; it contains no provider branch.

## Alternatives considered
1. Keep `core/*-v2.ts` beside Railway files — rejected because historical labels conceal provider ownership and make future providers copy a false version split.
2. Move all Vercel files into its package but leave separate engines/factories/tools — rejected because dispatch and persistence coupling remain scattered.
3. Build a universal provider adapter with one operation model — rejected because Railway adapter workflow and Vercel reconciliation differ materially; forced abstraction would reduce safety and locality.
4. Use dynamic package discovery — rejected because explicit registry entries are auditable, typed, and fail closed.

## Consequences
- Internal import paths change; `src/index.ts` public extension exports, persisted data, state paths, tool schemas/output/errors, command names, and Railway digest remain unchanged.
- `deployment/` intentionally has callback-based operation hooks. This is a real seam: generic retry/journal mechanics remain shared while provider state projection stays local.
- Future provider addition is bounded to package plus registry entry and package tests. Common tool schema changes remain explicit product work.
- No compatibility files with `-v2` names remain. Historical ADRs stay discoverable through supersession links.

## Verification
Architecture tests prove registry contains Railway/Vercel, generic tools import only registry, provider packages retain strict schemas, persisted contract fixtures remain readable, Vercel cloud-free acceptance remains injected, and Railway fixture digest is byte-identical.
