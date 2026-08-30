# Agent Reference: pi-ship

Pi-ship is the Pi coding agent's approval-gated deployment and database operations extension. It supports four deployment providers (Vercel, Cloudflare, Railway, Neon) and multi-dialect database management (PostgreSQL, MySQL, SQLite, PGlite).

## Sister Repos

### `/Users/rhinesharar/Pi-Workspace-Protocol`
- **Package:** `@rhinos0608/pi-workspace-protocol` (pinned as `github:rhinos0608/Pi-Workspace-Protocol#v0.3.0`).
- `src/boundary/capability.ts` imports typebox schemas and validation from the protocol package for signed capability minting and plan-digest hashing.

## Operational Contracts and Invariants

### ❌ NEVER write to the old shared journal paths
**This is the most important operational rule in this codebase.**

Before this review cycle, providers shared journal files:
- Vercel and Cloudflare both wrote to `.pi-ship/operation-journal.jsonl`
- Railway and Neon both wrote to `.pi-ship/journal.jsonl`

These schemas were mutually incompatible (Vercel requires `provider: "vercel"` + `domain: "app"`; Cloudflare requires `provider: "cloudflare"` with no domain; Railway uses `additionalProperties: false` while Neon includes `planDigest`). Cross-provider use caused **irrecoverable journal corruption** with `E_STATE_CONFLICT`.

**Each provider now writes to its own namespaced path:**

| Provider   | Journal path                                 |
|------------|----------------------------------------------|
| Vercel     | `.pi-ship/vercel-operation-journal.jsonl`    |
| Cloudflare | `.pi-ship/cloudflare-operation-journal.jsonl` |
| Railway    | `.pi-ship/railway-journal.jsonl`             |
| Neon       | `.pi-ship/neon-journal.jsonl`                |

All four providers implement **dual-path reading** (new path first, fallback to legacy path with schema-based filtering for Vercel/Cloudflare; fail-closed on ambiguous/mixed legacy entries for Railway/Neon). Legacy files are never auto-deleted — the user owns the clean-up schedule.

**When adding a new provider:**
- Create a provider-specific journal path from day one.
- Implement the dual-path read pattern if installing into repos that may have old entries.
- Fail closed: if legacy entries from another provider can't be schema-filtered, reject with `E_STATE_CONFLICT` (do not silently skip or adopt unknown entries).

### Cloudflare engine MUST use withFileMutationQueue
`src/providers/cloudflare/engine.ts:48` wraps `load → authorize → mutate → save` inside `withFileMutationQueue(statePath(ctx.cwd), ...)`. All four provider engines use this pattern. If a new provider is added or the Cloudflare engine is refactored, the mutation queue guard must not be removed — concurrent deployments without it will corrupt `state.json`.

### Railway state type guard MUST NOT mutate input
`src/providers/railway/state.ts` has a `isRailwayState` predicate that was previously mutating the caller's original object (a type guard that modifies its input). This is fixed — `isRailwayState` returns `true`/`false` without mutation; V1→V2 migration is performed in `loadRailwayState` which returns a new object via spread. New providers or refactors must follow the same pattern: predicates are pure, state migration is explicit.

### Neon DATABASE_URL env mutation is guarded
`src/providers/neon/engine.ts:189-192` uses a module-level `neonMigrationInProgress` boolean to prevent concurrent `process.env.DATABASE_URL` mutation during migrations. New migration code paths must check this guard or use `child_process.execFile` with explicit `env` override instead of mutating `process.env`.

### Boundary enforcement recursion depth
`src/boundary/enforcement.ts:224-243` — `collectStringValues` and `deepSort`/`canonicalize` have depth limits (default 20 for enforcement, 100 for hashing). If adding new recursive walkers in the boundary layer, include a depth guard to prevent stack overflow from crafted adversarial input.

### Signed capability verification EXISTS and IS TESTED
`test/boundary/enforcement.test.ts` has ~305 lines of coverage for Ed25519 signed capability verification including wrong audience, wrong resource, wrong projectBinding, expired, wrong signing key, and no trusted keys. If signing key management or capability minting changes, these tests must be updated.

### Credential loading semantics
Vercel and Railway have `load*` (returns partial) and `require*` (throws if missing) — proper separation. Cloudflare and Neon have only `load*` which throws. If adding deferred credential validation to those providers, match the Vercel/Railway load/require pattern.

## Architecture Notes
- Two-tier provider model: Vercel/Cloudflare use the generic `runOperationPlan` engine with reconciliation; Railway/Neon use imperative step-based engines.
- `createOperationJournal` shared utility is only used by Vercel/Cloudflare — if Railway/Neon ever migrate to it, the dual-path read pattern must be replicated.
- All boundary resource descriptors are always registered regardless of active provider — correct for defense-in-depth.

## Residual Risks
- **Journal migration fallback paths have limited test coverage for concurrent/mixed scenarios.** Fail-closed behavior is correct but the migration code paths rely on reasoning, not exhaustive test execution, for interleaved mixed-provider entries and ownership verification edge cases.
- **No persistence of journal path differentiation for existing users.** Journals at the old shared paths are readable via legacy fallback but never migrated to new paths automatically — users must clean up manually.
