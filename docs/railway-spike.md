# Manual Railway spike (no automated/live calls)

Run only in disposable Railway workspace. Record date, CLI version, and API response shapes without recording tokens or secret values.

- [ ] `railway --version` meets supported CLI version.
- [ ] API token GraphQL `me`/`projectToken` auth succeeds.
- [ ] `projectCreate`, `serviceCreate`, and `variableCollectionUpsert` succeed; confirm `replace:false`, `skipDeploys:true`.
- [ ] Project token linked-existing mode works with project/service/environment IDs and never creates.
- [ ] `railway up --ci --json --yes --service ID --environment ID --project ID` final object contains deployment ID and URL.
- [ ] `railway logs --json --lines 100` output is parseable.
- [ ] GraphQL `deployments` status and `deploymentRollback` work only when `canRollback:true`.
- [ ] Postgres service creation remains spike-gated; MVP uses BYO `DATABASE_URL`.
- [ ] CLI `status --json` and `deployment list --json` remain deferred; status uses GraphQL.

Do not commit tokens, response bodies containing secrets, or live state.
