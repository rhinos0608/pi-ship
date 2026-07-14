# pi-ship

Pi extension for approval-gated Railway deployments.

## MVP

- Railway GraphQL lifecycle and CLI `up`/`logs` only.
- `ship_ops` validates, plans, applies, and inspects deployments.
- `db_ops.provision` is unsupported; provide `DATABASE_URL` externally.
- Plans require interactive approval. Approval authority stays in process memory; sidecar files are audit-only.
- Manifest commands are argv arrays and never run through a shell.

## Local checks

```bash
npm install
npm run typecheck
npm test
npm run acceptance
```

Live Railway behavior is not exercised by tests. See `docs/railway-spike.md`.
