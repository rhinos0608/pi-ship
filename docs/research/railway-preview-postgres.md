# Research: Railway GraphQL API — Preview Environments & Postgres Auto-Provisioning

## Summary

Railway's GraphQL API (`https://backboard.railway.com/graphql/v2`) represents preview environments as **ephemeral environments** (`environmentCreate` with `ephemeral: true`). There is no dedicated "preview" resource type. Postgres is no longer provisioned via `pluginCreate` (deprecated); the modern path uses `templateDeployV2` targeting the `postgres` template code, creating a full service whose connection variables are consumed via `${{Postgres.DATABASE_URL}}` reference syntax. Both preview lifecycle and Postgres provisioning require explicit workspace context and are subject to rate limits.

---

## Findings

### 1. Preview environment = ephemeral environment

Railway has no native "preview" concept in the API. The `environmentCreate` mutation with `ephemeral: true` creates a PR/preview environment. The `isEphemeral` boolean on the `Environment` type distinguishes it from permanent envs.

**Mutation — create preview environment:**
```graphql
mutation environmentCreate($input: EnvironmentCreateInput!) {
  environmentCreate(input: $input) {
    id
    name
    isEphemeral
  }
}
```

**Variables:**
```json
{
  "input": {
    "projectId": "proj_abc123",
    "name": "pr-42",
    "ephemeral": true,
    "sourceEnvironmentId": "env_prod_id",
    "skipInitialDeploys": true,
    "applyChangesInBackground": false
  }
}
```

- `sourceEnvironmentId` clones service instances, variables, and config from an existing environment (default: production).
- `name` must be unique within the project.
- `skipInitialDeploys: true` prevents auto-deployment after creation.
- Returns the full `Environment` object with `id`, `name`, `isEphemeral`.

**Query — list environments and check for existing:**
```graphql
query environments($projectId: String!) {
  project(id: $projectId) {
    environments {
      edges {
        node {
          id
          name
          isEphemeral
          meta { branch prNumber prTitle }
        }
      }
    }
  }
}
```

**Mutation — delete preview (cleanup):**
```graphql
mutation environmentDelete($id: String!) {
  environmentDelete(id: $id)
}
```
Deletes the environment and all its deployments. Irreversible.

### 2. Environment isolation: per-environment service instances and variables

Environments are fully isolated:

- **Services** are shared at the project level but each environment has its own **service instances** (per-environment service config).
- **Variables** are scoped to `(projectId, environmentId, serviceId)`. Setting a variable on a service in one environment does not affect other environments.
- **Reference variables** resolve within the same environment only — `${{Postgres.DATABASE_URL}}` refers to the Postgres service instance in the same environment.
- Shared variables (no `serviceId`) are available to all services in that environment.

This means preview environments get their own Postgres instance when the Postgres template is deployed into them.

### 3. Postgres provisioning: `templateDeployV2` (not `pluginCreate`)

**`pluginCreate` is deprecated** (`@deprecated(reason: "Plugins are deprecated on Railway. Use database templates instead.")` in the schema). The modern approach deploys a Postgres template service.

**Mutation — provision Postgres via template:**
```graphql
mutation templateDeployV2($input: TemplateDeployV2Input!) {
  templateDeployV2(input: $input) {
    projectId
    workflowId
  }
}
```

**Variables:**
```json
{
  "input": {
    "templateId": "template_postgres_id",
    "serializedConfig": { ... },
    "projectId": "proj_abc123",
    "environmentId": "env_preview_id",
    "workspaceId": "ws_xyz789"
  }
}
```

**Two-step process:**
1. **Query template** to get `id` and `serializedConfig`:
   ```graphql
   query template($code: String!) {
     template(code: "postgres") {
       id
       serializedConfig
     }
   }
   ```
2. **Deploy** using `templateDeployV2` with the returned `templateId` and `serializedConfig`.

The template creates a service running the Postgres SSL image (`ghcr.io/railwayapp-templates/postgres-ssl`), which auto-generates:
- `DATABASE_URL`, `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`
- A TCP proxy for external connections
- A volume for persistent storage

**Alternative — CLI approach (internal API):** `railway add --database postgres` uses the same GraphQL mutations under the hood.

### 4. Reference variables: `${{ServiceName.VARIABLE_NAME}}`

Never fetch plaintext database credentials. Use Railway's reference variable syntax:

```
${{Postgres.DATABASE_URL}}
${{Postgres.PGHOST}}
${{Postgres.PGPORT}}
${{Redis.REDIS_URL}}
${{MongoDB.MONGO_URL}}
```

**Setting a reference variable via API:**
```graphql
mutation variableUpsert($input: VariableUpsertInput!) {
  variableUpsert(input: $input)
}
```

```json
{
  "input": {
    "projectId": "proj_abc123",
    "environmentId": "env_preview_id",
    "serviceId": "svc_app_id",
    "name": "DATABASE_URL",
    "value": "${{Postgres.DATABASE_URL}}",
    "skipDeploys": true
  }
}
```

The value `${{Postgres.DATABASE_URL}}` is stored as-is (unrendered). Resolution happens at deploy time.

**Bulk set with `replace: true` (clears all previous vars):**
```graphql
mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) {
  variableCollectionUpsert(input: $input)
}
```

Existing GQL client (`src/providers/railway/gql.ts`, line 131) already implements `variableCollectionUpsert` with `replace` and `skipDeploys` options.

### 5. Deploy to preview: `serviceInstanceDeployV2`

**Mutation:**
```graphql
mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!) {
  serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
}
```

Returns the deployment ID as a string. Crucially, both `serviceId` and `environmentId` are required — you cannot deploy "the app" generically; you must target a specific environment.

**Redeploy (same commit):**
```graphql
mutation serviceInstanceRedeploy($serviceId: String!, $environmentId: String!) {
  serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId)
}
```

**Warning from community:** `serviceInstanceRedeploy` redeploys the *current deployment object*, not the updated source config. After changing service settings (e.g., image tag), always use `serviceInstanceDeployV2` to create a fresh deployment. [Source](https://station.railway.com/questions/deploy-docker-tag-from-ci-cf2cd5dc)

### 6. Multi-preview identity: explicit `previewId` mapping required

Railway assigns environment IDs like `env_xxxxx` — not human-readable preview identifiers. The system must maintain its own map:

```
state.previews[previewId] = {
  environmentId: "env_xxx",
  serviceId: "svc_xxx",
  projectId: "proj_xxx"
}
```

**Idempotence check pattern:**
1. Query project environments for matching name (e.g., `"pr-42"`).
2. If found, use existing `environmentId`.
3. If not found, create with `environmentCreate({ name: "pr-42", ephemeral: true, ... })`.
4. Check if Postgres service instance exists in that environment (query `environment(id) { serviceInstances { edges { node { id service { name } } } } }`).
5. If missing, deploy Postgres template into that environment.
6. Deploy app service with `serviceInstanceDeployV2`.

**State schema addition** (`src/providers/railway/state.ts`):
```
previews?: Record<string, {
  environmentId: string;
  serviceId: string;
  projectId: string;
  postgresServiceId?: string;
  createdAt: string;
}>;
```

**Plan schema addition** (`src/providers/railway/plan.ts`):
```
previewId?: string;
```

Add to `RailwayPlanSchema` and `RailwayPlan` interface.

### 7. Required GQL client additions

New methods needed in `src/providers/railway/gql.ts`:

| Method | Mutation/Query | Purpose |
|--------|---------------|---------|
| `createEnvironment(projectId, name, ephemeral, sourceEnvironmentId?)` | `environmentCreate` | Create preview env |
| `deleteEnvironment(envId)` | `environmentDelete` | Tear down preview |
| `findEnvironment(projectId, name)` | `project(id) { environments { edges { node { id } } } }` | Idempotence check |
| `deployTemplate(templateId, config, projectId, envId, workspaceId)` | `templateDeployV2` | Provision Postgres |
| `deployServiceInstance(serviceId, envId)` | `serviceInstanceDeployV2` | Deploy to preview |
| `getServiceInstances(envId)` | `environment(id) { serviceInstances { ... } }` | Check existing services |

### 8. Current code gates blocking preview

Two locations throw `E_PHASE_UNSUPPORTED` for preview:

- **`src/providers/railway/ship-ops.ts`** line 205-207:
  ```typescript
  if (params.action === "plan" && params.environment === "preview") {
    throw err("E_PHASE_UNSUPPORTED", "preview environment is not supported in MVP");
  }
  ```
- **`src/providers/railway/db-ops.ts`** line 41-43:
  ```typescript
  if (environment === "preview") {
    throw err("E_PHASE_UNSUPPORTED", "preview environment is not supported in MVP");
  }
  ```
- **`src/providers/railway/adapter.ts`** line 184-186: Postgres provisioning disabled:
  ```typescript
  async provisionPostgres(_projectId, signal) {
    throw err("E_PHASE_UNSUPPORTED", "Railway Postgres auto-provision is disabled in MVP; use existing DATABASE_URL");
  }
  ```

### 9. Idempotence patterns

| Operation | Idempotence Strategy |
|-----------|---------------------|
| `environmentCreate` | Query `project(id).environments` by name first; skip if exists |
| `templateDeployV2` | Query `environment(id).serviceInstances` for Postgres service; skip if exists |
| `variableCollectionUpsert` | Already idempotent — `replace: true` overwrites, `replace: false` merges |
| `serviceInstanceDeployV2` | Not idempotent — each call creates a new deployment. Track via `lastRelease` in state |
| `environmentDelete` | Idempotent — second call returns error; guard by checking existence first |

### 10. API endpoint and auth

- **Endpoint:** `https://backboard.railway.com/graphql/v2`
- **Token types:**
  - `Account token`: `Authorization: Bearer <token>` — full access across all workspaces
  - `Workspace token`: `Authorization: Bearer <token>` — single workspace
  - `Project token`: `Project-Access-Token: <token>` — single environment (insufficient for environmentCreate which requires project-level scope)
- **Rate limits:** 100 RPH (Free), 1000 RPH (Hobby), 10000 RPH (Pro); 10 RPS (Hobby), 50 RPS (Pro)
- **Headers:** `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `Retry-After`

---

## Sources

### Kept:
- **Manage Environments with the Public API | Railway Docs** ([docs.railway.com](https://docs.railway.com/integrations/api/manage-environments)) — Official env create/list/delete docs with `ephemeral` parameter
- **API Cookbook | Railway Docs** ([docs.railway.com](https://docs.railway.com/integrations/api/api-cookbook)) — Copy-paste examples for deploy, variable upsert, environment create
- **Preview Deployments with PR Environments | Railway Docs** ([docs.railway.com](https://docs.railway.com/guides/preview-deployments-with-pr-environments)) — Explains ephemeral env behavior, Focused PR envs, Bot PR envs
- **schema.graphql (terraform-community-providers)** ([github.com](https://github.com/terraform-community-providers/terraform-provider-railway/blob/master/schema.graphql)) — Full GraphQL schema including `environmentCreate`, `templateDeployV2`, `variableCollectionUpsert`, `pluginCreate` (deprecated), `serviceInstanceDeployV2`
- **PostgreSQL | Railway Docs** ([docs.railway.com](https://docs.railway.com/databases/postgresql)) — Postgres service connection variables (`DATABASE_URL`, etc.)
- **Variables Reference | Railway Docs** ([docs.railway.com](https://docs.railway.com/variables/reference)) — `${{ServiceName.VAR}}` syntax, Railway-provided vars
- **Manage Variables with the Public API** ([docs.railway.com](https://docs.railway.com/integrations/api/manage-variables)) — variableCollectionUpsert with replace, unrendered variables
- **railway-skills setup.md** ([github.com](https://github.com/railwayapp/railway-skills/blob/main/plugins/railway/skills/use-railway/references/setup.md)) — Template deploy pattern, reference variable syntax, `railway add --database postgres`
- **Railway Central Station — deploy docker tag from CI** ([station.railway.com](https://station.railway.com/questions/deploy-docker-tag-from-ci-cf2cd5dc)) — Community confirmation: `serviceInstanceDeployV2` required after config change, not `serviceInstanceRedeploy`

### Dropped:
- **api-evangelist/railway-app** — Derivative copy of official docs; no new information
- **PostGraphile blog post** — Irrelevant to preview/Postgres provisioning API
- **Self-host Strapi guide** — Only shows manual Postgres provisioning via dashboard, not API
- **LobeHub skills marketplace** — Thin summary, not authoritative

---

## Gaps

1. **Template ID for Postgres** — The exact `templateId` value for the `postgres` template code is unknown without live introspection or a `template(code: "postgres") { id }` query. The template code `"postgres"` is documented but the resolved UUID must be fetched at runtime.
2. **Postgres provisioning latency** — `templateDeployV2` is async (returns `workflowId`). Whether the research document should poll for completion or deploy variables immediately after submission is unresolved. The Postgres service may not have generated `DATABASE_URL` by the time variables are set.
3. **Workspace ID requirement** — `templateDeployV2` requires `workspaceId`. The current codebase does not store or discover the workspace ID. A new query `project(id) { workspaceId }` must be added.
4. **Project token scope limitation** — `environmentCreate` requires at least workspace-level scope; project tokens (scoped to a single environment) cannot create new environments. Account or workspace tokens are required for preview management.
5. **Postgres per-preview cost** — Each preview environment provisions a full Postgres service instance. Railway bills per-service per-hour. No cost control signals in API.
6. **Ephemeral environment cleanup** — Railway auto-cleans PR environments only when the PR is merged/closed (GitHub integration). For API-created previews, cleanup must be managed manually via `environmentDelete`.
7. **State migration** — Existing state files (v1) lack the `previews` field. The `isRailwayState` validator in `state.ts` will reject new fields unless the schema is updated.
8. **Plan digest change** — Adding `previewId` to `RailwayPlan` changes the canonicalization output and thus all plan digests. Need to validate this doesn't break existing persisted plans.

### Suggested next steps
1. Add `template(code: "postgres") { id serializedConfig }` query to GQL client and cache the template ID.
2. Add `project(id) { workspaceId }` query for workspace discovery.
3. Extend `LocalState` with `previews` map and update schema version to v2.
4. Extend `RailwayPlan` with `previewId` field.
5. Remove `E_PHASE_UNSUPPORTED` gates in ship-ops.ts and db-ops.ts.
6. Implement `provisionPostgres` in adapter using `templateDeployV2`.
7. Implement preview lifecycle operations in a new `preview-ops.ts` handler.

---

## Supervisor coordination

No supervisor contact needed. Research complete with concrete findings and source citations.

---