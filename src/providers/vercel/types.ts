import { Type, type Static, type TLiteral } from "typebox";

// ── Config ─────────────────────────────────────────────────────────────────────
export interface VercelClientConfig {
  /** Vercel API bearer token (required, nonempty) */
  token: string;
  /** Optional team ID for team-scoped requests (nonempty if provided) */
  teamId?: string;
  /** Base URL (default https://api.vercel.com) */
  baseUrl?: string;
  /** Injectable backoff fn for tests. Returns ms to wait. */
  backoff?: BackoffFn;
  /** Max retries for safe idempotent ops (default 3, must be >= 0) */
  maxRetries?: number;
}

export type BackoffFn = (attempt: number, retryAfter?: number | null) => number;

// ── Auth / User ────────────────────────────────────────────────────────────────
export const UserSchema = Type.Object({
  id: Type.String(),
  email: Type.String(),
  name: Type.Union([Type.String(), Type.Null()]),
  username: Type.String(),
  avatar: Type.Union([Type.String(), Type.Null()]),
  defaultTeamId: Type.Union([Type.String(), Type.Null()]),
  limited: Type.Optional(Type.Boolean()),
  createdAt: Type.Optional(Type.Number()),
  stagingPrefix: Type.Optional(Type.String()),
  hasTrialAvailable: Type.Optional(Type.Boolean()),
  isEnterpriseManaged: Type.Optional(Type.Boolean()),
  shouldShowEnterpriseManagedWelcome: Type.Optional(Type.Boolean()),
  isAccountUpdateRequired: Type.Optional(Type.Boolean()),
});

export const UserResponseSchema = Type.Object({
  user: UserSchema,
});

export type UserResponse = Static<typeof UserResponseSchema>;
export type User = Static<typeof UserSchema>;

// ── Projects ───────────────────────────────────────────────────────────────────
export const PaginationSchema = Type.Object({
  count: Type.Optional(Type.Number()),
  next: Type.Optional(Type.Number()),
  prev: Type.Optional(Type.Number()),
});

export const ProjectSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  accountId: Type.Optional(Type.String()),
  framework: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  nodeVersion: Type.Optional(Type.String()),
  createdAt: Type.Optional(Type.Number()),
  updatedAt: Type.Optional(Type.Number()),
});

/** Wrapper form: { projects: [...], pagination?: {...} } */
export const ListProjectsResponseSchema = Type.Object({
  projects: Type.Array(ProjectSchema),
  pagination: Type.Optional(PaginationSchema),
});

export type ListProjectsResponse = Static<typeof ListProjectsResponseSchema>;
export type Project = Static<typeof ProjectSchema>;
export type Pagination = Static<typeof PaginationSchema>;

export interface CreateProjectRequest {
  name: string;
  framework?: string | null;
  buildCommand?: string | null;
  devCommand?: string | null;
  installCommand?: string | null;
  outputDirectory?: string | null;
  rootDirectory?: string | null;
  serverlessFunctionRegion?: string | null;
  gitRepository?: {
    repo: string;
    type: "github" | "github-limited" | "gitlab" | "bitbucket" | "vercel";
  };
  environmentVariables?: Array<{
    key: string;
    value: string;
    target: ("production" | "preview" | "development")[];
    type: "system" | "encrypted" | "plain" | "sensitive";
    gitBranch?: string | null;
  }>;
}

// ── Environment Variables ──────────────────────────────────────────────────────
export interface EnvVarInput {
  key: string;
  value: string;
  type: "sensitive";
  target: ["production"] | ["preview"] | ["production", "preview"];
  gitBranch?: string | null;
}

export const CreateEnvResponseSchema = Type.Object({
  created: Type.Union([
    Type.Record(Type.String(), Type.Unknown()),
    Type.Array(Type.Record(Type.String(), Type.Unknown())),
  ]),
  failed: Type.Optional(
    Type.Array(
      Type.Object({
        error: Type.Object({
          code: Type.String(),
          message: Type.String(),
        }),
      })
    )
  ),
});

export type CreateEnvResponse = Static<typeof CreateEnvResponseSchema>;

// ── Files Upload ───────────────────────────────────────────────────────────────
export const UploadFileResponseSchema = Type.Object({
  urls: Type.Optional(Type.Array(Type.String())),
});

export type UploadFileResponse = Static<typeof UploadFileResponseSchema>;

// ── Deployments ────────────────────────────────────────────────────────────────
export const DeploymentSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  url: Type.String(),
  readyState: Type.Union([
    Type.Literal("QUEUED"),
    Type.Literal("INITIALIZING"),
    Type.Literal("BUILDING"),
    Type.Literal("READY"),
    Type.Literal("ERROR"),
    Type.Literal("CANCELED"),
    Type.Literal("BLOCKED"),
  ]),
  createdAt: Type.Number(),
  projectId: Type.String(),
  creator: Type.Optional(
    Type.Object({
      uid: Type.String(),
      username: Type.String(),
      avatar: Type.String(),
    })
  ),
  target: Type.Optional(Type.Union([Type.Literal("production"), Type.Literal("staging"), Type.Null()])),
  ownerId: Type.Optional(Type.String()),
  plan: Type.Optional(Type.String()),
  type: Type.Optional(Type.String()),
  createdIn: Type.Optional(Type.String()),
  aliasAssigned: Type.Optional(Type.Boolean()),
  buildingAt: Type.Optional(Type.Number()),
  bootedAt: Type.Optional(Type.Number()),
  ready: Type.Optional(Type.Number()),
  buildSkipped: Type.Optional(Type.Boolean()),
  alias: Type.Optional(Type.Array(Type.String())),
  status: Type.Optional(Type.String()),
  meta: Type.Optional(Type.Record(Type.String(), Type.String())),
});

export type Deployment = Static<typeof DeploymentSchema>;

export interface DeploymentFile {
  file: string;
  data?: string;
  encoding?: "base64";
  sha?: string;
  size?: number;
}

export interface CreateDeploymentRequest {
  name: string;
  project?: string;
  target?: "production" | "staging" | null;
  files?: DeploymentFile[];
  gitSource?: {
    type: "github" | "gitlab" | "bitbucket" | "vercel";
    ref?: string;
    sha?: string;
    repoId?: string | number;
    org?: string;
    repo?: string;
  };
  deploymentId?: string;
  withLatestCommit?: boolean;
  projectSettings?: {
    buildCommand?: string | null;
    devCommand?: string | null;
    installCommand?: string | null;
    framework?: string | null;
    nodeVersion?: string;
    outputDirectory?: string | null;
    rootDirectory?: string | null;
  };
  meta?: Record<string, string>;
}

// ── Build Events ───────────────────────────────────────────────────────────────
export const BuildEventTypeEnum = [
  "command", "delimiter", "deployment-state", "edge-function-invocation",
  "exit", "fatal", "metric", "middleware", "middleware-invocation",
  "report", "stderr", "stdout",
] as const;

export type BuildEventType = (typeof BuildEventTypeEnum)[number];

export const BuildEventPayloadSchema = Type.Object(
  {
    deploymentId: Type.Optional(Type.String()),
    id: Type.Optional(Type.String()),
    date: Type.Optional(Type.Number()),
    serial: Type.Optional(Type.String()),
    text: Type.Optional(Type.String()),
    statusCode: Type.Optional(Type.Number()),
  },
  { additionalProperties: true }
);

export const BuildEventSchema = Type.Object({
  type: Type.Union(BuildEventTypeEnum.map((value) => Type.Literal(value)) as unknown as [TLiteral<BuildEventType>, ...TLiteral<BuildEventType>[]]),
  created: Type.Number(),
  payload: BuildEventPayloadSchema,
});

export type BuildEvent = Static<typeof BuildEventSchema>;

// ── Runtime Logs ───────────────────────────────────────────────────────────────
export const RuntimeLogLevelEnum = [
  "debug", "error", "fatal", "info", "trace", "warning",
] as const;

export type RuntimeLogLevel = (typeof RuntimeLogLevelEnum)[number];

export const RuntimeLogSourceEnum = [
  "delimiter", "edge-function", "edge-middleware", "request", "serverless",
] as const;

export type RuntimeLogSource = (typeof RuntimeLogSourceEnum)[number];

export const RuntimeLogEntrySchema = Type.Object({
  level: Type.Union(RuntimeLogLevelEnum.map((value) => Type.Literal(value)) as unknown as [TLiteral<RuntimeLogLevel>, ...TLiteral<RuntimeLogLevel>[]]),
  message: Type.String(),
  rowId: Type.String(),
  source: Type.Union(RuntimeLogSourceEnum.map((value) => Type.Literal(value)) as unknown as [TLiteral<RuntimeLogSource>, ...TLiteral<RuntimeLogSource>[]]),
  timestampInMs: Type.Number(),
  domain: Type.Optional(Type.String()),
  messageTruncated: Type.Optional(Type.Boolean()),
  requestMethod: Type.Optional(Type.String()),
  requestPath: Type.Optional(Type.String()),
  responseStatusCode: Type.Optional(Type.Number()),
});

export type RuntimeLogEntry = Static<typeof RuntimeLogEntrySchema>;
