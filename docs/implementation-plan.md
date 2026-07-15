# pi-ship MVP Implementation Plan

Grounding evidence:
- `/tmp/pi-ship-oracle-design.md` (product decisions)
- `/tmp/pi-ship-railway-official.md` (Railway CLI/API contracts)
- `/tmp/pi-ship-oracle-decision-patch.md` (final contract superseding this plan where conflicting)
- `/Users/rhinesharar/.pi/agent/git/github.com/jonjonrankin/pi-caveman/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- `/Users/rhinesharar/.pi/agent/git/github.com/jonjonrankin/pi-caveman/node_modules/@earendil-works/pi-coding-agent/package.json`

Scope: implement production-grade MVP. Plan updated to reflect final contract.

## Decisions preserved (final contract)

- Package/name: `pi-ship`.
- Manifest: JSON file `pi-ship.json` in repo root; validated strictly; unknown keys rejected.
- Provider: Railway only in MVP; other providers are Phase 2.
- Tools exposed to the model: `ship_ops` and `db_ops` only.
- Railway hybrid lifecycle: GraphQL for project/service/variable/status/rollback; CLI only `up --ci --json` and bounded `logs --json`.
- Full lifecycle requires `RAILWAY_API_TOKEN`. `RAILWAY_TOKEN`-only mode requires linked IDs in `.pi-ship/state.json` and never creates.
- `db_ops.plan_migration` reads command from `pi-ship.json` (`db.migrate.command`); no model-supplied command/SQL parameter exists.
- No arbitrary SQL, drop, automatic DB rollback, credential read-back, or service deletion via tools.
- Manifest commands are non-empty argv arrays; executed with `pi.exec(argv[0], argv.slice(1))`; never shell.
- Production apply/rollback requires interactive approval; `ctx.hasUI === false` fails closed with `E_APPROVAL_REQUIRED`.
- Approval authority is closure-private in-memory registry keyed by `planId+digest`, shared by `tool_call` gate and handlers. Restart/reload requires reapproval. Approval sidecar may exist for audit but MUST NOT authorize anything.
- Rollback is a rollback plan + same apply protocol; no direct rollback tool action. DB untouched message mandatory.
- Real `Type.Union` of `Type.Object` variants with `Type.Literal` discriminators, `additionalProperties: false`, plus handler runtime revalidation.
- `db_ops.provision` returns `E_PHASE_UNSUPPORTED` for all environments. Railway Postgres auto-provision stays spike-gated; MVP uses existing `DATABASE_URL`. Destruction unsupported.
- Serialize all apply operations per cwd/state path to prevent parallel duplicate creates; use Pi `withFileMutationQueue` on the state file path.
- Secrets never in argv, stdout/details, state, plan, journal, session entries, error text, or request logging. GraphQL variable values stay only in request body and process memory. Never invoke `railway variable list` or `variable set`.
- Unverified live cloud behavior stays clearly marked manual spike; code fails explicitly rather than fake support.

## Dependency/version rationale

| Package | Role | Version | Why |
|---|---|---|---|
| `typescript` | type checking, dev only | `~5.9.3` | Matches host toolchain (`package.json` line 77). |
| `vitest` | unit/contract tests, dev only | `~3.2.4` | Matches host toolchain (`package.json` line 78). |
| `@types/node` | Node built-in types, dev only | `^24.12.4` | Matches host toolchain (`package.json` line 74). |
| `@earendil-works/pi-coding-agent` | extension types only, dev only | `0.77.x` | Host provides runtime; use for `ExtensionAPI`, `isToolCallEventType`, `Static`, `withFileMutationQueue` (docs lines 60-62, 691-735, 1235-1269, 1685). |
| `typebox` | tool/manifest schemas | provided by host (`package.json` line 56) | Runtime `dependencies` intentionally empty; host supplies `Type`, `Static`. |
| `@earendil-works/pi-ai` | `StringEnum` | provided by host | Google-compatible enums (docs lines 1236-1247). |
| `@earendil-works/pi-tui` | command autocomplete types | provided by host | Only needed for `AutocompleteItem` type. |

Node engine: `>=22.19.0` (`package.json` line 96). Runtime `dependencies` stay empty because the host supplies all extension APIs (docs lines 138-151).

## Planned `.gitignore` contents

```gitignore
node_modules/
dist/
.pi-ship/
.pi-subagents/
.pi-smartread.tags.cache/
.env
*.log
```

## Slices

Each slice independently verifiable. Write failing test first, make pass, refactor. Use Fake provider for unit/contract tests; Railway CLI/GQL adapters validate arg construction, request bodies, and parsing with fake `exec`/`fetch`; live cloud behavior captured only in manual `docs/railway-spike.md`.

---

### Slice 1 — Errors, manifest schema, and loader

**Goal:** typed errors and a strict JSON manifest loader that reject invalid/unknown config before any remote call.

- [ ] Create `src/core/errors.ts` exporting:
  - `ShipErrorCode` union: `"E_CONFIG_INVALID" | "E_AUTH_MISSING" | "E_PRECONDITION" | "E_PLAN_NOT_FOUND" | "E_PLAN_STALE" | "E_DIGEST_MISMATCH" | "E_APPROVAL_REQUIRED" | "E_APPROVAL_DENIED" | "E_PROVIDER" | "E_CANCELLED" | "E_PHASE_UNSUPPORTED" | "E_STATE_CONFLICT"`.
  - `ShipError` interface: `{ code; message; retryable; details?: object }`.
  - Helper `err(code, message, retryable?, details?)`.
- [ ] Create `src/core/types.ts` (shared small types): `type Environment = "development" | "preview" | "production"`; `type Provider = "railway"`; `type ToolResult = { content: Array<{type:"text";text:string}>; details: object }`.
- [ ] Create `src/core/manifest.ts` exporting:
  - Typebox schema `ManifestSchema` matching `pi-ship.json` shape: `name`, `provider` literal railway, `project` string, `run.command` argv array, optional `build.command` argv array, optional `checks` array of argv arrays, optional `secrets` string array, optional `db.migrate.command` argv array, optional `db.migrate.allowProductionMigrations` boolean, optional `db.provision` literal `"railway-postgres" | "external"` (default external).
  - Type alias `Manifest = Static<typeof ManifestSchema>`.
  - Function `loadManifest(cwd: string): Promise<Manifest>` that reads `./pi-ship.json`, parses JSON, validates with `ManifestSchema`, rejects unknown keys with `E_CONFIG_INVALID`.
- [ ] Create `test/core/manifest.test.ts` with tests:
  - [ ] minimal valid manifest loads.
  - [ ] full valid manifest with `build`, `run`, `checks`, `secrets`, `db.migrate`, `db.migrate.allowProductionMigrations`, `db.provision` loads.
  - [ ] unknown top-level key → `E_CONFIG_INVALID` naming the key.
  - [ ] unknown key inside `db` → `E_CONFIG_INVALID`.
  - [ ] missing required `project` → `E_CONFIG_INVALID`.
  - [ ] missing required `run.command` → `E_CONFIG_INVALID`.
  - [ ] `run.command` empty array → `E_CONFIG_INVALID`.
  - [ ] `run.command` contains non-string → `E_CONFIG_INVALID`.
  - [ ] provider other than `"railway"` → `E_CONFIG_INVALID`.
  - [ ] malformed JSON → `E_CONFIG_INVALID`.
- [ ] Run `npx vitest --run test/core/manifest.test.ts` green before Slice 2.

---

### Slice 2 — Redaction choke point

**Goal:** no secret value ever leaves the extension in stdout, stderr, logs, or error messages.

- [ ] Create `src/core/redact.ts` exporting `redact(text: string, envNames: string[]): string` that:
  - Collects values from `process.env` for the supplied names (length >= 6).
  - Scrubs exact-match values, `postgres://...` DSN passwords, bearer token patterns, and 32+ char hex/base64 runs.
  - Returns text unchanged if no secrets match.
- [ ] Create `test/core/redact.test.ts` with tests:
  - [ ] exact env value redacted.
  - [ ] short env values (<6) ignored to avoid noisy replacements.
  - [ ] `postgres://user:secret@host/db` redacted.
  - [ ] `Authorization: Bearer <token>` redacted.
  - [ ] 32-char hex/base64 string redacted.
  - [ ] multiple env names redacted independently.
  - [ ] non-secret text unchanged.
- [ ] Add `test/fixtures/secrets.log` (sample CLI output with fake secrets) and a test that greps the redacted output confirming no raw secret remains.
- [ ] Run `npx vitest --run test/core/redact.test.ts` green.

---

### Slice 3 — Atomic state and append-only journal

**Goal:** local state survives process restarts; journal supports interrupt/resume.

- [ ] Create `src/core/state.ts` exporting:
  - `interface LocalState { version: 1; provider: "railway"; projectId?: string; serviceIds: { app?: string; postgres?: string }; lastRelease?: { id: string; digest: string; url?: string; at: string }; history: Array<{ planId: string; digest: string; at: string; status: string }> }`.
  - `loadState(cwd): Promise<LocalState>`.
  - `saveState(cwd, state): Promise<void>` using tmp-file + atomic rename.
- [ ] Create `src/core/journal.ts` exporting:
  - `interface JournalEntry { ts: string; planId: string; step: string; status: "start" | "ok" | "fail"; resourceRef?: string; error?: ShipError }`.
  - `appendJournal(cwd, entry): Promise<void>`.
  - `readJournal(cwd, planId): Promise<JournalEntry[]>`.
- [ ] Create `test/core/state.test.ts` with tests:
  - [ ] missing state returns default empty state.
  - [ ] round-trip save/load preserves values.
  - [ ] concurrent writes do not corrupt file (atomic rename).
  - [ ] malformed JSON returns `E_CONFIG_INVALID`.
- [ ] Create `test/core/journal.test.ts` with tests:
  - [ ] append creates file and preserves entries.
  - [ ] read by planId filters correctly.
  - [ ] journal entries are newline-delimited JSON.
- [ ] Run `npx vitest --run test/core/state.test.ts test/core/journal.test.ts` green.

---

### Slice 4 — Plan builder, canonical digest, approval gate, and sidecar

**Goal:** immutable, deterministic, digest-bound plans; interactive approval with fail-closed headless behavior.

- [ ] Create `src/core/plan.ts` exporting:
  - `interface Plan { planId: string; manifest: Manifest; gitCommit: string; gitDirty: boolean; worktreeHash: string; provider: "railway"; environment: Environment; resourceActions: Array<{ action: "create" | "update" | "rollback"; resource: string; name: string }>; secretNames: string[]; migrationCommand?: string; estimatedImpact: string; planDigest: string; createdAt: string; intent: "deploy" | "rollback"; targetReleaseId?: string }`.
  - `buildPlan(cwd, manifest, environment, intent?): Promise<Plan>`: computes git commit (`git rev-parse HEAD`), dirty flag (`git status --porcelain`), worktree hash (hash of `git diff` + untracked file list), derives resource action list from manifest/state, reads migration command from manifest, supports `intent=rollback` with `targetReleaseId`.
  - `canonicalize(plan): string`: sorted keys, no floats, UTF-8 JSON.
  - `computeDigest(plan): string`: `sha256(canonicalize(plan))` hex.
  - `isPlanStale(plan, cwd): Promise<boolean>`: true if `createdAt` older than 30 minutes or if HEAD/worktree hash changed.
- [ ] Create `src/core/approval.ts` exporting:
  - In-memory approval registry: `approve(planId, digest)`, `isApproved(planId, digest)`, `revoke(planId, digest)`.
  - `requestApproval(ctx, plan): Promise<{ approved: boolean; approvedAt?: string }>`: renders summary with digest prefix, environment, resource actions, secret names; calls `ctx.ui.confirm(title, renderedSummary)`. Returns `approved: false` when `ctx.hasUI === false`.
- [ ] Create `src/core/approval-store.ts` exporting:
  - `writeApprovalSidecar(cwd, planId, planDigest, approvedAt, environment): Promise<void>` writes `.pi-ship/plans/<planId>.approval.json` for audit only.
  - Sidecar read/verify APIs are intentionally absent; sidecar remains write-only audit output.
  - 
- [ ] Create `src/core/plan-store.ts` exporting:
  - `persistPlan(cwd, plan): Promise<void>` writes `.pi-ship/plans/<planId>.json` with digest embedded; plan file never mutated after persist.
  - `loadPlan(cwd, planId): Promise<Plan>` and `verifyDigest(plan, suppliedDigest): boolean`.
- [ ] Create `test/core/plan.test.ts` with tests:
  - [ ] digest is deterministic across two builds with identical inputs.
  - [ ] changing manifest changes digest.
  - [ ] dirty worktree sets `gitDirty` and includes worktree hash.
  - [ ] plan older than 30 minutes is stale.
  - [ ] plan is stale when worktree hash changes.
  - [ ] embedded digest matches recomputed digest.
  - [ ] rollback plan includes `intent=rollback` and target release action.
- [ ] Create `test/core/approval.test.ts` with tests:
  - [ ] approval registry confirms after `approve`.
  - [ ] approval returns `approvedAt` timestamp when user confirms.
  - [ ] headless context (`hasUI: false`) returns `approved: false`.
  - [ ] denial returns `approved: false`.
  - [ ] plan file byte-identical before/after writing audit sidecar.
  - [ ] forged sidecar with wrong digest cannot authorize apply.
- [ ] Run `npx vitest --run test/core/plan.test.ts test/core/approval.test.ts` green.

---

### Slice 5 — Provider adapter contract and Fake provider

**Goal:** an interface that hides CLI/API details and an in-memory fake for deterministic tests.

- [ ] Create `src/providers/types.ts` exporting:
  - `interface ProviderAdapter { id: "railway"; checkAuth(signal?): Promise<{ ok: boolean; missing?: string[] }>; ensureProject(name, signal?): Promise<{ projectId: string; created: boolean }>; ensureService(projectId, name, signal?): Promise<{ serviceId: string; created: boolean }>; setVariables(serviceId, names: string[], source: () => Record<string, string | undefined>, signal?): Promise<void>; deploy(serviceId, dir, signal?, onUpdate?): Promise<{ releaseId: string; url?: string }>; status(serviceId, signal?): Promise<{ status: "SUCCESS" | "FAILED" | "BUILDING" | "CRASHED"; url?: string }>; logs(serviceId, lines, signal?): Promise<string>; rollback(serviceId, releaseId, signal?): Promise<{ ok: boolean; releaseId?: string; unsupported?: boolean }>; provisionPostgres(projectId, signal?): Promise<{ serviceId: string; urlEnvName: "DATABASE_URL" }>; }`.
- [ ] Create `src/providers/fake.ts` implementing `ProviderAdapter` in memory with:
  - find-by-name idempotency,
  - conflict detection (`E_STATE_CONFLICT`),
  - recorded calls for assertions,
  - optional failure injection.
- [ ] Create `test/providers/fake.test.ts` with tests:
  - [ ] `ensureProject` creates on first call, finds existing on second call.
  - [ ] `ensureService` under a project is idempotent.
  - [ ] `setVariables` reads values from source callback and records names only.
  - [ ] `deploy` returns release ID and URL.
  - [ ] `status` and `logs` return recorded values.
  - [ ] `rollback` marks release as rolled back.
  - [ ] duplicate found with mismatched state returns conflict.
- [ ] Run `npx vitest --run test/providers/fake.test.ts` green.

---

### Slice 6 — Railway CLI adapter (arg construction and parsing only)

**Goal:** translate adapter methods into safe `pi.exec` arg arrays and parse JSON output; no live cloud calls in tests.

- [ ] Create `src/providers/railway/cli.ts` exporting:
  - `createRailwayExec(piExec): RailwayCliClient` where `piExec` matches `pi.exec` signature.
  - Functions that build arg arrays for:
    - `railway --version`
    - `railway up --json --yes --ci --service <id> --environment <id> --project <id>` via `pi.exec`
    - `railway logs --json --lines <N> --service <id> --environment <id>` via `pi.exec`
  - JSON parsers for each command's documented output shape.
  - No `railway variable list`, no `railway variable set`, no `railway redeploy`, no `railway add --database postgres`.
- [ ] Create `test/providers/railway-cli.test.ts` with tests:
  - [ ] `up` arg array contains `--json`, `--yes`, `--ci`, `--service`, `--environment`, `--project` and no shell interpolation.
  - [ ] `logs` caps `lines` at 500 and includes `--json`.
  - [ ] parser extracts `deploymentId`, `url`, `status` from `up --json` final JSON object.
  - [ ] cancellation propagates to `pi.exec` through `signal`.
  - [ ] auth failure output maps to `E_AUTH_MISSING`.
- [ ] Run `npx vitest --run test/providers/railway-cli.test.ts` green.

---

### Slice 7 — Railway GraphQL adapter

**Goal:** native fetch GraphQL for lifecycle/variables/status/rollback.

- [ ] Create `src/providers/railway/gql.ts` exporting:
  - `createRailwayGql({apiToken?, projectToken?}): RailwayGqlClient`.
  - `checkAuth()`, `ensureProject(name)`, `ensureService(projectId, name)`, `setVariables(projectId, environmentId, serviceId, variables, {replace, skipDeploys})`, `status(serviceId)`, `rollback(serviceId, deploymentId)`.
  - Native `fetch` to `https://backboard.railway.com/graphql/v2`.
  - `Authorization: Bearer <apiToken>` for `RAILWAY_API_TOKEN`; `Project-Access-Token: <projectToken>` for `RAILWAY_TOKEN`.
  - Linked-existing mode: `ensureProject`/`ensureService` never create; require IDs from state, else `E_PRECONDITION` naming missing token/link.
  - Map HTTP 429 + `Retry-After` to retryable `E_PROVIDER`.
- [ ] Create `test/providers/railway-gql.test.ts` with a fake `fetch` asserting:
  - [ ] request bodies contain `replace:false` and `skipDeploys:true` for variable upserts.
  - [ ] linked-existing mode never issues `projectCreate`/`serviceCreate`.
  - [ ] 429 maps to retryable `E_PROVIDER`.
  - [ ] rollback mutation only sent when `canRollback:true`.
- [ ] Run `npx vitest --run test/providers/railway-gql.test.ts` green.

---

### Slice 8 — Railway composite adapter

**Goal:** combine GQL lifecycle + CLI deploy/logs into `ProviderAdapter`.

- [ ] Create `src/providers/railway/index.ts` implementing `ProviderAdapter`:
  - `checkAuth` → gql.
  - `ensureProject`/`ensureService`/`setVariables`/`status`/`rollback` → gql.
  - `deploy`/`logs` → cli.
  - `provisionPostgres` → spike-gated; returns `E_PHASE_UNSUPPORTED`.
  - Translate Railway-specific failures into `ShipError` (`E_AUTH_MISSING`, `E_PROVIDER`, `E_CANCELLED`).
- [ ] Create `test/providers/railway.test.ts` verifying composite wiring.
- [ ] Run `npx vitest --run test/providers/railway.test.ts` green.

---

### Slice 9 — Apply engine with idempotency and interrupt/resume

**Goal:** one core function that applies a plan, skips already-completed steps, resumes after interruption, and never duplicates resources.

- [ ] Create `src/core/engine.ts` exporting:
  - `interface ApplyContext { adapter: ProviderAdapter; manifest: Manifest; plan: Plan; cwd: string; envReader: (names: string[]) => Record<string, string | undefined>; }`
  - `applyPlan(ctx): Promise<ToolResult>` executing steps in order inside `withFileMutationQueue` on the state file path:
    1. validate (checks via `pi.exec(argv[0], argv.slice(1))`, auth, missing secrets) — zero remote mutations on failure.
    2. ensure project.
    3. ensure app service.
    4. provision Postgres if `db.provision === "railway-postgres"` and state lacks postgres serviceId (spike-gated → `E_PHASE_UNSUPPORTED`).
    5. set variables.
    6. run migration if configured and environment allows.
    7. deploy.
    8. update state and append `ok` journal entry.
  - Before each mutating step, replay journal for the plan: skip if a prior `ok` entry exists and provider find-by-name confirms resource; resume first incomplete step.
  - Rollback intent routes to `adapter.rollback`; result text states DB is untouched; `canRollback:false` ⇒ `E_PRECONDITION` with guidance.
- [ ] Create `test/core/engine.test.ts` with tests:
  - [ ] failed preflight performs zero adapter mutations.
  - [ ] missing secrets returns `E_PRECONDITION` listing names only.
  - [ ] `applyPlan` with mismatched digest returns `E_DIGEST_MISMATCH` before any remote call.
  - [ ] unapproved plan returns `E_APPROVAL_REQUIRED`.
  - [ ] interrupt after step 3 + re-apply creates no duplicate project/service.
  - [ ] state rediscovery after wiping in-memory state loads from disk.
  - [ ] secrets values never appear in returned content/details (use Fake adapter + redaction).
  - [ ] dirty worktree is flagged in plan summary but does not block apply.
  - [ ] cancellation mid-deploy appends `fail(cancelled)` and returns `E_CANCELLED`.
  - [ ] rollback plan result text says database state untouched.
- [ ] Run `npx vitest --run test/core/engine.test.ts` green.

---

### Slice 10 — Tool handlers and policy gate

**Goal:** wire `ship_ops` and `db_ops` tools and a defense-in-depth `tool_call` gate.

- [ ] Create `src/tools/ship-ops.ts` exporting the `ship_ops` tool registration:
  - parameters via `Type.Union` of `Type.Object` variants with `Type.Literal` action discriminators and `additionalProperties: false`.
  - actions:
    - `validate` → load manifest, run preflight, return summary.
    - `plan` (environment: production only in MVP) → build plan, persist, request approval, write audit sidecar if approved, return planId + digest + summary.
    - `apply_plan` → load plan, verify digest, ensure approval (registry + sidecar audit), call engine.
    - `status` → read state, call adapter.status.
    - `logs` → call adapter.logs with `lines` bounded [1,500], default 100.
  - handler revalidates raw input against the union schema before dispatch.
- [ ] Create `src/tools/db-ops.ts` exporting the `db_ops` tool registration:
  - parameters via `Type.Union` of per-action `Type.Object` variants with `Type.Literal` discriminators.
  - `preview` environment returns `E_PHASE_UNSUPPORTED` for all mutating actions.
  - `provision` returns `E_PHASE_UNSUPPORTED` for all environments.
  - `plan_migration`/`apply_migration` require `db.migrate.command` from manifest; missing returns `E_CONFIG_INVALID`.
  - production migration requires `db.migrate.allowProductionMigrations: true` and plan-level approval.
- [ ] Create `src/gate.ts` exporting a `tool_call` handler that:
  - Uses `isToolCallEventType<"ship_ops" | "db_ops", ShipOpsInput | DbOpsInput>` narrowing.
  - Blocks any `ship_ops.apply_plan` lacking a digest-matching approval in the in-memory registry.
  - Blocks any `db_ops` input containing a `command` field (defense in depth; schema should already forbid it).
  - Returns `{ block: true, reason: string }` only; does not mutate tool inputs.
- [ ] Create `test/tools/ship-ops.test.ts` with tests:
  - [ ] `validate` returns summary for valid manifest.
  - [ ] `plan` returns planId and digest.
  - [ ] `apply_plan` with wrong digest returns `E_DIGEST_MISMATCH`.
  - [ ] `apply_plan` on unapproved plan returns `E_APPROVAL_REQUIRED`.
  - [ ] `logs` default lines = 100, max = 500.
  - [ ] unknown action rejected at validation.
  - [ ] cross-variant fields rejected (`additionalProperties: false`).
- [ ] Create `test/tools/db-ops.test.ts` with tests:
  - [ ] `provision <any env>` returns `E_PHASE_UNSUPPORTED`.
  - [ ] `preview` environment returns `E_PHASE_UNSUPPORTED` for mutating actions.
  - [ ] `plan_migration` without manifest migrate key returns `E_CONFIG_INVALID`.
  - [ ] production migration with `allowProductionMigrations: false` returns `E_APPROVAL_REQUIRED`.
  - [ ] `apply_plan` for migration verifies digest and uses engine.
- [ ] Create `test/gate.test.ts` with tests:
  - [ ] gate blocks unapproved `ship_ops.apply_plan`.
  - [ ] gate allows approved plan apply.
  - [ ] gate blocks `db_ops` input containing `command`.
  - [ ] forged sidecar with wrong digest cannot authorize apply.
- [ ] Run `npx vitest --run test/tools/ship-ops.test.ts test/tools/db-ops.test.ts test/gate.test.ts` green.

---

### Slice 11 — Extension entry and slash commands

**Goal:** package the tools/commands as a Pi extension; slash commands are thin wrappers.

- [ ] Create `src/index.ts` (default factory) exporting:
  - `export default function (pi: ExtensionAPI)` registering `ship_ops`, `db_ops`, `tool_call` gate, and slash commands `/ship-init`, `/ship-plan`, `/ship-apply`, `/ship-status`, `/ship-logs`, `/ship-rollback`, `/ship-db-destroy`.
  - `export type ShipOpsInput = Static<typeof shipOpsSchema>` and `export type DbOpsInput = Static<typeof dbOpsSchema>` for the gate.
- [ ] Create `src/commands/ship.ts` exporting command handlers:
  - `/ship-init` → write a starter `pi-ship.json` if absent.
  - `/ship-plan` → call `ship_ops` `plan`.
  - `/ship-apply <planId> <digest>` → call `ship_ops` `apply_plan`.
  - `/ship-status` → call `ship_ops` `status`.
  - `/ship-logs [lines]` → call `ship_ops` `logs`.
  - `/ship-rollback <releaseId>` → build rollback plan → approval → apply; result states DB untouched.
  - `/ship-db-destroy` → human-only confirmation, returns guidance; never a tool.
  - `getArgumentCompletions` for plan IDs and release IDs from local state.
- [ ] Create `test/index.test.ts` with tests:
  - [ ] factory registers expected tools and commands.
  - [ ] `/ship-init` creates `pi-ship.json` only when missing.
- [ ] Run `npx vitest --run test/index.test.ts` green.

---

### Slice 12 — Acceptance script, schema doc, ADR, and manual spike checklist

**Goal:** automatable acceptance gates and a documented manual cloud spike.

- [ ] Create `scripts/acceptance.mjs` (Node ESM, no test framework) that:
  - Sets up a temp repo with `pi-ship.json`.
  - Runs Fake provider scenarios:
    - failed preflight ⇒ zero mutations,
    - missing creds ⇒ names-only error,
    - apply requires exact digest,
    - interrupt + resume ⇒ no duplicate resources,
    - state rediscovery,
    - secrets absent from outputs (grep fixtures).
  - Prints `PASS`/`FAIL` and exits non-zero on failure.
- [x] Create `pi-ship.schema.json` with `oneOf` covering Railway V1, Vercel V2, Cloudflare V1, and Neon V1 manifest formats (superseded by shipped schema at repo root; validate with `npx vitest --run test/boundary/`).
- [ ] Create `docs/adr/0001-single-provider-railway.md` recording the Railway-only MVP decision.
- [ ] Create `docs/railway-spike.md` manual checklist:
  - [ ] `railway --version` >= expected.
  - [ ] `RAILWAY_API_TOKEN` auth with GraphQL `projectToken` query.
  - [ ] `projectCreate`/`serviceCreate`/`variableCollectionUpsert` against real workspace token.
  - [ ] `RAILWAY_TOKEN` linked-existing mode with `projectId`/`serviceId` from state.
  - [ ] `railway up --ci --json --service <id> --environment <id> --project <id>` final-object shape.
  - [ ] `railway logs --json --lines 100` returns parseable NDJSON.
  - [ ] GraphQL `deployments` query status and `deploymentRollback` (only `canRollback:true`).
  - [ ] Postgres provisioning spike-gated; note BYO `DATABASE_URL`.
  - [ ] Mark unverified CLI `deployment list --json` / `status --json` as deferred to GraphQL.
- [ ] Run `node scripts/acceptance.mjs` green.

---

## Security negative tests (must all exist and pass)

- [ ] `db_ops` schema rejects any `command` field.
- [ ] `db_ops.plan_migration` ignores model-supplied SQL; command is read from manifest only.
- [ ] No tool exposes variable values in `content`/`details`.
- [ ] No adapter invokes `railway variable list` or `railway variable set`.
- [ ] No adapter runs `DROP`, `DELETE`, or schema rollback automatically.
- [ ] `apply_plan` requires exact digest and approved plan.
- [ ] Headless context fails approval closed (`E_APPROVAL_REQUIRED`), not auto-approve.
- [ ] Gate blocks unapproved `apply_plan` even if tool code regresses.
- [ ] Rollback result text explicitly says database state is untouched.
- [ ] Preview environment returns `E_PHASE_UNSUPPORTED` for mutating actions.
- [ ] Forged approval sidecar cannot authorize apply.

## Final verification commands

Run in order after all slices:

```bash
# gate 1: static types
npx tsc --noEmit

# gate 2: full unit/contract suite
npx vitest --run

# gate 3: scripted acceptance scenarios (Fake provider, no cloud)
node scripts/acceptance.mjs

# gate 4: no trailing whitespace/conflict markers
git diff --check

# gate 5: plan placeholder scan
grep -RinE '\b(TODO|FIXME|XXX|PLACEHOLDER|HACK|NOTE:.*implement|undefined|...)' docs/implementation-plan.md || true
```

Expected: `tsc` exits 0, `vitest` exits 0, `acceptance.mjs` exits 0, `git diff --check` exits 0, placeholder scan finds only this intentional line.

## Non-goals (MVP)

- Multi-provider abstraction, OpenTofu/IaC, daemon, webhooks, schedulers.
- Browser IDE, multiplayer, billing, custom domains/DNS, preview environments, object storage.
- Arbitrary SQL, model-supplied migration commands, automatic DB rollback, unattended production deploys.
- GraphQL Railway API is used only where CLI lacks functionality; live verification stays in `docs/railway-spike.md`.
