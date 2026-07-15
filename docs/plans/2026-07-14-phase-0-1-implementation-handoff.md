# Phase 0–1 Production Expansion Handoff

> **For fresh-context orchestrator:** Read approved design and research artifacts first. Produce exact TDD implementation plan, then execute through single-writer workers and fresh reviewers. Do not broaden scope.

## Approved scope

Implement Phase 0 safety/contract foundation and Phase 1 Vercel connector from `docs/plans/2026-07-14-production-expansion-design.md`.

Cloudflare Workers and Neon are approved roadmap items but must begin only after Phase 0–1 passes full verification and review. Do not implement restore, DNS, deletion, raw SQL, local backups, or unattended production applies.

## Mandatory startup reads

1. `docs/plans/2026-07-14-production-expansion-design.md`
2. `README.md`
3. `docs/adr/0001-single-provider-railway.md`
4. `src/core/{types,manifest,plan,plan-store,state,authorization,approval,journal,engine}.ts`
5. `src/providers/types.ts`
6. `src/tools/{ship-ops,db-ops}.ts`
7. `src/gate.ts`
8. Existing tests under `test/core`, `test/providers`, and `test/tools`
9. Research artifacts listed in fresh-context prompt below

Before edits: run `git status --short --branch`, `npm test`, `npm run typecheck`, and `npm run acceptance`. Preserve any user-owned changes.

## Execution sequence

### Stage 1 — Exact plan and contracts

Use `writing-plans`. Define complete V1/V2 Typebox schemas and typed operations before implementation. Keep current Railway interfaces operational. Specify exact runtime validation, error semantics, state migration, journal/reconciliation behavior, and Vercel request/response contracts.

Pass condition: implementation plan names exact files, interfaces, tests, commands, and expected failures; no placeholders.

### Stage 2 — Phase 0 tests first

Add focused failing tests for engine preflight/authorization/ambiguous retry/reconciliation; tool/gate/index contracts; provider-visible approval; malformed persisted V1/V2 plans/state; Railway V1 compatibility; token isolation; journal corruption; unsupported capabilities; and secret non-disclosure.

Pass condition: focused tests fail for intended missing behavior, not setup errors.

### Stage 3 — Phase 0 implementation

One worker owns shared core files. Implement V1/V2 runtime schemas, additive Railway compatibility, provider-scoped credentials/factory, provider-rich approval, typed strict journal, ambiguous reconciliation, response validation, and unchanged Railway legacy execution.

Pass condition: Phase 0 focused tests, existing Railway tests, typecheck, and acceptance pass.

### Stage 4 — Phase 0 adversarial review

Parallel fresh reviewers: compatibility/persisted data; authorization/credentials/secrets/journal; API/type simplicity. Parent verifies findings. One worker applies accepted fixes.

Pass condition: no confirmed blocker; full verification passes after fixes.

### Stage 5 — Vercel provider

One provider worker, native injectable `fetch`. Implement bearer auth using only `VERCEL_TOKEN`; optional strict team ID; project discover/create; sensitive write-only env upsert; preview/production deployment; status; bounded redacted build/runtime logs; rollback; error/rate-limit mapping; cancellation; malformed-response handling.

Never call env decryption/readback endpoints. Never expose raw provider errors before sanitization.

Pass condition: Vercel unit/contract tests pass with fake fetch; no live claims.

### Stage 6 — Integration and review

Integrate Vercel through V2 surfaces. Add cloud-free acceptance for preview, production, status, logs, ambiguous reconciliation, rollback, and token isolation.

Parallel fresh reviewers: Vercel official-contract correctness; security/secrets; cross-provider regressions/tests.

Pass condition:

```bash
npm test
npm run typecheck
npm run acceptance
git diff --check
```

All exit 0. Live Vercel behavior remains manual/unverified until disposable-account spike.

### Stage 7 — Next approved phases

After Phase 0–1 completion, create separate plans for Phase 2 Cloudflare Workers and Phase 3 Neon. Keep separate worker ownership. Do not reopen V2 core contracts without oracle/reviewer consultation.

## Orchestration rules

- First delegation: list agents and models.
- Prefer async subagents and `wait`; do not poll.
- One writer per active worktree/file set.
- Parallelize research, provider code after contracts stabilize, reviews, and validation—not shared-core writes.
- Default child budgets: `turnBudget: { maxTurns: 100 }`, `toolBudget: { hard: 100 }`.
- Workers report changed files, commands/outcomes, unverified behavior, and decisions needing escalation.
- Reviewers report confirmed findings with file/line evidence and smallest safe fix.
- No commit, push, migration, live cloud mutation, or destructive action without explicit request.

## Stop conditions

Stop and ask if work requires breaking V1 compatibility, new dependency/SDK, unapproved public tool action, persisted credentials, headless production approval, restore/delete/DNS, or Cloudflare beta API as foundation.
