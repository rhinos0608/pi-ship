# ADR 0001: Railway-only provider in MVP

Status: accepted

## Decision

pi-ship supports Railway only. GraphQL handles project/service creation, variable upserts, deployment status, and rollback. CLI handles upload (`railway up --ci --json`) and bounded logs. Other providers and preview environments remain Phase 2.

## Consequences

Users supply existing `DATABASE_URL`; database provisioning and destruction are unsupported. API-token mode can create resources. Project-token mode requires linked IDs in local state and never creates resources. Cloud behavior not verified by unit tests is tracked in manual spike checklist.
