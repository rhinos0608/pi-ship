# Research: Cloudflare Workers Tail API for pi-ship Live Log Streaming

## Summary

Cloudflare Workers offers two real-time log streaming APIs: the **classic Tail API** (`/accounts/{id}/workers/scripts/{name}/tails`) which creates a short-lived tail session returning a WebSocket URL for streaming invocation events, and the newer **Observability Live Tail API** (`/accounts/{id}/workers/observability/telemetry/live-tail`) which supports server-side filtering. Both are live-only, worker-scoped, and require explicit cleanup — tails auto-expire but must be deleted after collection to avoid leaking sessions against the 10-session-per-worker limit.

## Findings

### 1. Classic Tail API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `POST` | `/accounts/{account_id}/workers/scripts/{script_name}/tails` | Create a tail session. Body: `{}` (empty). Returns `{ id, expires_at, url }` |
| `GET` | `/accounts/{account_id}/workers/scripts/{script_name}/tails` | List active tails. Returns array of `{ id, expires_at, url }` |
| `DELETE` | `/accounts/{account_id}/workers/scripts/{script_name}/tails/{id}` | Delete a tail session (cleanup) |

**Create Response Shape** (`TailCreateResponse`):
```json
{
  "success": true,
  "errors": [],
  "messages": [],
  "result": {
    "id": "023e105f4ecef8ad9ca31a8372d0c353",
    "expires_at": "2026-07-01T00:00:00Z",
    "url": "wss://tail.workers.dev/..."
  }
}
```

[Source: Cloudflare API Docs — Start Tail](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/tail/methods/create/)
[Source: Cloudflare API Docs — Tail list/delete](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/tail/)

---

### 2. New Observability Live Tail API (alternative)

**Endpoint**: `POST /accounts/{account_id}/workers/observability/telemetry/live-tail`

**Body** (optional filters):
```json
{
  "filterCombination": "and",
  "filters": [
    { "key": "$metadata.service", "operation": "includes", "type": "string", "value": "my-worker" }
  ],
  "scriptId": "optional-script-id"
}
```

**Response**:
```json
{
  "success": true,
  "result": { "wsUrl": "wss://..." }
}
```

**Permissions**: Requires `Workers Observability Write` (not `Workers Tail Read` / `Workers Scripts Write`).

[Source: Cloudflare API Docs — Prepare Live Tail](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/live_tail/)

---

### 3. WebSocket Connection & Message Format

**Connection**: After creating a tail, connect to the returned `url` (wss://) using standard WebSocket client. No additional auth headers needed on WS connection — auth is bound to the tail session.

**Message format** (JSON per frame — one invocation per message):
```json
{
  "outcome": "ok",
  "scriptName": "my-worker",
  "exceptions": [
    {
      "name": "Error",
      "message": "Something broke",
      "timestamp": 1587058642005
    }
  ],
  "logs": [
    {
      "message": ["hello from console.log"],
      "level": "log",
      "timestamp": 1587058642005
    }
  ],
  "diagnosticsChannelEvents": [
    {
      "channel": "foo",
      "message": "diagnostic message",
      "timestamp": 1587058642005
    }
  ],
  "eventTimestamp": 1590680082349,
  "event": {
    "request": {
      "url": "https://example.com/",
      "method": "GET",
      "headers": { "cf-ray": "57d55f210d7b95f3" },
      "cf": { "colo": "SJC" }
    }
  }
}
```

**`outcome` values**: `unknown`, `ok`, `exception`, `exceededCpu`, `exceededMemory`, `scriptNotFound`, `canceled`, `responseStreamDisconnected`

**`logs[].level` values**: `debug`, `info`, `log`, `warn`, `error`

**TailRequest redaction**: Headers with names containing `auth`, `key`, `secret`, `token`, `jwt` or `cookie`/`set-cookie` are automatically `"REDACTED"`. URLs with hex/base64 IDs are also redacted. Call `getUnredacted()` to bypass.

[Source: Cloudflare Real-time Logs docs](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/)
[Source: Cloudflare Tail Handler docs](https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/)

---

### 4. Tail Lifecycle Management

**Sequence**:
1. **Create** — `POST /tails` → get `{ id, expires_at, url }`
2. **Connect** — WebSocket connect to `url` (wss://)
3. **Consume** — Read JSON messages from WebSocket `onmessage`
4. **Delete** — `DELETE /tails/{id}` after collection complete (or on error/timeout)

**Critical cleanup rule**: Always delete the tail after use. Tails left dangling count against the 10-session limit. Use `finally` block or `AbortSignal` callback to ensure cleanup.

**Expiration**: The `expires_at` field indicates when the tail auto-expires. Sessions auto-terminate after a period (typically minutes). Actively consuming the WebSocket may extend the session.

---

### 5. Limits & Constraints

| Limit | Value |
|-------|-------|
| Max concurrent tail sessions per Worker | **10** (combined dashboard + API sessions) |
| Log delivery | **Live streaming only** — no historical replay |
| Sampling | **Auto-sampling at high traffic** — messages may be dropped with warning |
| Scope | **Worker-scoped** — tied to script name, not deployment/version |
| Tier | Requires **Workers Paid** or **Enterprise** |
| China Network | **Not available** on Cloudflare China Network zones |
| WS message size | Up to **32 MiB** per WebSocket frame (platform limit) |

[Source: Cloudflare Real-time Logs limits](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/#limits)

---

### 6. Authentication & Scopes

**Classic Tail API** requires one of:
- `Workers Tail Read` (recommended for log-only access)
- `Workers Scripts Write` (backwards compatibility)

**Observability Live Tail API** requires:
- `Workers Observability Write`

Use the existing `CloudflareClient` pattern — `Authorization: Bearer <apiToken>` header works for all endpoints.

---

### 7. Comparison: Classic Tail vs Observability Live Tail

| Aspect | Classic Tail | Observability Live Tail |
|--------|-------------|----------------------|
| Endpoint | `/workers/scripts/{name}/tails` | `/workers/observability/telemetry/live-tail` |
| Filters | None (all invocations) | Server-side filter support |
| Script scope | Single script (path param) | Optional `scriptId` filter |
| Permission | `Workers Tail Read` | `Workers Observability Write` |
| Response | `{ id, expires_at, url }` | `{ wsUrl }` |
| Maturity | Older, well-established | Newer, more feature-rich |

For pi-ship, **Classic Tail API** is the safer initial target (simpler, well-documented, matches wrangler tail behavior). Observability Live Tail can be added later for filtered streaming.

---

### 8. Event Schema (Full Type Definitions)

```
TailItem {
  scriptName: string
  outcome: "unknown" | "ok" | "exception" | "exceededCpu" | "exceededMemory" | "scriptNotFound" | "canceled" | "responseStreamDisconnected"
  eventTimestamp: number (epoch ms)
  event: FetchEventInfo | null
  logs: TailLog[]
  exceptions: TailException[]
  diagnosticsChannelEvents: DiagnosticsChannelEvent[]
}

FetchEventInfo {
  request: TailRequest
  response: TailResponse
}

TailRequest {
  cf: CfProperties
  headers: Record<string, string>
  method: string
  url: string
  getUnredacted(): TailRequest  // bypasses redaction
}

TailResponse {
  status: number
}

TailLog {
  timestamp: number (epoch ms)
  level: "debug" | "info" | "log" | "warn" | "error"
  message: any[]  // array of args passed to console function
}

TailException {
  timestamp: number (epoch ms)
  name: string  // e.g. "Error", "TypeError"
  message: string
}
```

[Source: Cloudflare Tail Handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/)

---

### 9. Integration Plan for pi-ship

#### New client methods in `client.ts`

```typescript
interface CloudflareClient {
  // existing methods...
  
  // Tail lifecycle
  createTail(scriptName: string, signal?: AbortSignal): Promise<TailCreateResponse>;
  listTails(scriptName: string, signal?: AbortSignal): Promise<TailGetResponse[]>;
  deleteTail(scriptName: string, tailId: string, signal?: AbortSignal): Promise<void>;
}

interface TailCreateResponse {
  id: string;
  expires_at: string;
  url: string;
}
```

#### New types in `types.ts`

```typescript
export interface TailCreateResponse {
  id: string;
  expires_at: string;
  url: string;
}

export interface TailLog {
  message: unknown[];
  level: "debug" | "info" | "log" | "warn" | "error";
  timestamp: number;
}

export interface TailException {
  name: string;
  message: string;
  timestamp: number;
}

export interface TailEvent {
  outcome: string;
  scriptName: string | null;
  eventTimestamp: number;
  logs: TailLog[];
  exceptions: TailException[];
  diagnosticsChannelEvents?: Array<{ channel: string; message: string; timestamp: number }>;
  event?: {
    request?: { url: string; method: string; headers: Record<string, string>; cf: Record<string, unknown> };
    response?: { status: number };
  };
}
```

#### Runtime changes in `runtime.ts`

Replace the stub `doLogs`:
```typescript
async function doLogs(
  releaseId: string,          // actually scriptName in deployment context
  input: { lines: number; secretValues: readonly string[] },
  signal?: AbortSignal,
): Promise<Verification<string>> {
  // 1. Resolve script name from releaseId mapping
  // 2. Create tail via client.createTail(scriptName, signal)
  // 3. Connect WebSocket to tail.url
  // 4. Collect up to input.lines messages
  // 5. Delete tail in finally block
  // 6. Return formatted log output
}
```

**Important**: The current `doLogs` signature takes `releaseId` but the Tail API needs `scriptName` (worker name). Must resolve mapping from deployment system context, or pass scriptName alongside releaseId.

#### Descriptor capability update

Add `"logs"` to capabilities array in runtime descriptor:
```typescript
capabilities: [
  "discover",
  "write_secrets",
  "deploy",
  "status",
  "rollback",
  "logs",        // ← add
] as const,
```

#### Error handling strategy

| Scenario | Handling |
|----------|----------|
| Tail creation fails (401/403) | Return `unverified("unauthorized"/"forbidden")` |
| Tail creation fails (429) | Return `unverified("rate_limited", retryable=true)` |
| WebSocket connection fails | Return `unverified("transport")` |
| WebSocket drops mid-stream | Return partial logs collected so far + error note |
| Tail delete fails | Log warning; non-fatal (tail will auto-expire) |
| Signal abort | Cleanup: delete tail, close WebSocket, return partial results |

#### Timeout strategy

- **Collection timeout**: Cap tail session at 15 seconds for `doLogs(lines: 100)`; 30 seconds for `lines: 1000`.
- **Per-message timeout**: If no message received within 10 seconds, close and return collected.
- **Use `AbortSignal`** from caller for overall cancellation.

---

### 10. Key Limitations Impacting Design

1. **Live-only, no historical replay**: Cannot fetch past logs. The `lines` parameter in `doLogs` must map to "collect up to N messages and stop", not "fetch N historical lines".

2. **Worker-scoped, not deployment-scoped**: The API addresses workers by `script_name`, not deployment ID. pi-ship must map from the deployment-centric `releaseId` to the worker `scriptName` before calling the Tail API.

3. **10-session limit**: Must ensure proper cleanup (delete tail in `finally`) to avoid exhausting sessions across concurrent pi-ship operations.

4. **Redaction by default**: `headers` and `url` in request objects are redacted. Consumers needing full visibility must call `getUnredacted()` client-side. For pi-ship, accept redacted output to avoid leaking secrets.

5. **Sampling under load**: At high traffic, Cloudflare samples and drops messages. pi-ship should communicate this to users transparently.

---

## Sources

### Kept
- **Cloudflare API Docs — Start Tail** (https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/tail/methods/create/) — Official endpoint spec for creating tail sessions. Request/response shapes, path params, auth requirements.
- **Cloudflare API Docs — Tail (list/delete)** (https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/tail/) — Complete lifecycle documentation for list and delete endpoints.
- **Cloudflare Real-time Logs docs** (https://developers.cloudflare.com/workers/observability/logs/real-time-logs/) — Limits (10 sessions), sampling behavior, wrangler tail output format.
- **Cloudflare Tail Handler docs** (https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/) — Full event schema: TailItem, TailLog, TailException, FetchEventInfo, outcome values, redaction rules.
- **Cloudflare API Docs — Prepare Live Tail** (https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/live_tail/) — Newer observability API with filter support; alternative to classic Tail endpoint.
- **Cloudflare Workers Limits** (https://developers.cloudflare.com/workers/platform/limits/) — Platform limits context for Tail Workers.

### Dropped
- **DeepWiki / cloudflare-rs Workers Tails page** — Useful implementation reference but not authoritative for pi-ship TypeScript design.
- **ControlTheory Gonzo blog** — Community implementation, not authoritative for API contract decisions.
- **Scalable Developer blog** — Tail Worker pattern (different from Tail API); not relevant for the REST+WebSocket streaming use case.

---

## Gaps

- **Exact tail session TTL / auto-expiry duration**: Cloudflare docs do not specify the exact `expires_at` duration after creation. Empirical testing needed. Wrangler source suggests ~60-120 seconds of inactivity timeout.
- **WebSocket reconnection behavior**: Unknown if the tail URL supports reconnection if the WebSocket drops. Likely not — the URL is single-connect.
- **Observability Live Tail `wsUrl` format**: Exact WebSocket message format for the newer endpoint may differ from classic Tail. Not yet verified — the docs only specify `wsUrl` in the response, not the event format on the wire.
- **`scriptId` resolution**: The new Live Tail API references `scriptId` (a UUID) vs `scriptName` (human-readable). The relationship between the two is undocumented.
- **Rate limits for tail creation**: Unknown if there are per-account or per-minute limits on creating tails (beyond the 10 concurrent session limit).

### Suggested next steps
1. Write an integration test that creates a tail, connects WebSocket, invokes the worker, reads one message, then deletes the tail.
2. Measure `expires_at` delta to determine session TTL.
3. Test WebSocket behavior on timeout — does the server close the connection or does it stay open?
4. Evaluate Observability Live Tail API for filtered streaming support (e.g., filter by `outcome: "exception"` only).

---

## Supervisor coordination

No coordination needed. This is a focused research task with clear output path. If implementation decisions require clarification (e.g., whether to use Classic Tail vs Observability Live Tail as primary), will escalate via `contact_supervisor` with `reason: "need_decision"`.

---