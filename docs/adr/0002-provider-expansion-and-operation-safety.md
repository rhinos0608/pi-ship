# ADR 0002: Provider expansion and operation safety

## Status
Accepted

## Context
ADR 0001 limited pi-ship to Railway during MVP. Phase 0/1 adds Vercel app deployment while Railway persisted manifests, plans, state, journals, digest, commands, and tool output must remain compatible. Provider APIs can acknowledge writes ambiguously; local source can change after approval; provider tokens and application secrets have distinct trust boundaries.

## Decision
pi-ship supports Railway and Vercel through separate provider contracts. Railway retains its existing manifest and `version: 1` state/plan behavior. Vercel uses its existing strict `version: 2` manifest, plan, state, and operation-journal contracts. Both providers keep `.pi-ship/state.json`; incompatible stored provider contracts fail closed rather than migrate.

Vercel uses injectable native fetch, strict projected response validation, provider-isolated `VERCEL_TOKEN`, separately allowlisted app-secret values, local source enumeration with containment/symlink/secret exclusions, SHA-1 file uploads, SHA-256 source fingerprints, and no live test-cloud mutation.

Vercel mutations are never retried from an uncertain response. Retry occurs at most once only after reconciliation verifies `not_applied`; conflict, unverified state, mismatched resource identity, partial secret write, or fingerprint mismatch blocks apply. The operation journal is hash chained and fully validated before filtering. Journal/history never authorizes an apply.

## Alternatives considered
1. Keep Railway-only scope — rejected because approved Phase 1 requires Vercel deployment.
2. Reuse Railway `ProviderAdapter` for Vercel — rejected because Railway CLI/GraphQL lifecycle and Vercel operation reconciliation have incompatible interfaces and certainty semantics.
3. Retry all transient Vercel mutations — rejected because a server may apply a timed-out/5xx request.

## Consequences
- Vercel deploys require in-memory approval, a fresh bound plan, verified account/project/source identity, and explicit token/app-secret allowlists.
- Vercel environment writes and rollback are intentionally unreconcilable when provider reads cannot prove their effect; apply fails closed.
- Tests use injected fake fetch; documented endpoints are validated, but no live Vercel mutation is performed.
- Future providers must preserve their own persisted contracts and failure semantics rather than inherit Railway assumptions.
- Provider-package structure and deployment kernel detailed in [ADR 0003](0003-hybrid-provider-packages-and-deployment-kernel.md).

## Verification
`npm test`, `npm run typecheck`, `npm run acceptance`, and `git diff --check` pass. Cloud-free Vercel acceptance covers preview, production, status, redacted logs, rollback, token isolation, source drift, ambiguous mutation blocking, and journal integrity.
