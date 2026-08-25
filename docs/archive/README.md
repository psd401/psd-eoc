# Historical archive

Documents under this directory preserve planning context, completed work
ledgers, superseded procedures, and one-off evidence. They are intentionally
unchanged historical records. Their commands, status labels, paths, and design
claims are not current instructions.

Use the current sources instead:

- [Architecture and contributing](../ARCHITECTURE.md)
- [Configuration and deployment](../CONFIGURATION.md)
- [Operational readiness](../INTEGRATIONS.md)
- [Operations runbooks](../runbooks/README.md)

## Preserved records

- [Implementation plan](PLAN.md)
- [Codex wave goals](CODEX_GOALS.md)
- [Discovery decision log](discovery/DECISION_LOG.md)
- [Capability execution boundary note](capability-execution.md)
- [Access-model cutover notes](access-model-cutover.md)
- [Deployment and provider evidence](evidence/)
- [Superseded runbook index and launch/release checklists](runbooks/)
- [Superseded infrastructure README](infrastructure/README-2026-08-25.md)
- [Superseded Google Cloud setup record](infrastructure/gcp-README-2026-08-25.md)
- [Dated App Store setup record](runbooks/appstore-setup-2026-08-25.md)
- [Dated SES setup record](runbooks/email-setup-2026-08-25.md)
- [Dated SMS registration record](runbooks/sms-registration-2026-08-25.md)

Applied SQL migrations remain in `packages/server/drizzle/migrations`, where
their filenames and bytes are protected by the migration-history CI check.
They were not moved or rewritten during this documentation reset.
