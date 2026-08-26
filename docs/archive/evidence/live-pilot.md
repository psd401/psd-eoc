# Historical live-pilot evidence

This archived file retains only the dated operational observations that still
matter. The abandoned repository-hosted deployment design and its unfilled
approval fields were removed. Deployment has one supported path: direct
`cdk deploy` from a locally authenticated, short-lived AWS session.

## Append-only truth ledger

Never rewrite an observation to make later evidence look older. Add a
superseding row when a boundary changes.

| Recorded at (UTC) | Run/change reference                    | AWS platform            | Google OIDC             | Groups/roster           | Messaging providers     | DNS/custom domain | Evidence summary |
| ----------------- | --------------------------------------- | ----------------------- | ----------------------- | ----------------------- | ----------------------- | ----------------- | ---------------- |
| 2026-08-15        | Issue #163 source only                  | `configured-unverified` | `configured-unverified` | `mocked`                | `mocked`                | `blocked`         | Source configuration was under review. No AWS, Google, DNS, provider, or recipient write occurred. |
| 2026-08-15        | Issue #178 source only                  | `configured-unverified` | `configured-unverified` | `mocked`                | `mocked`                | `blocked`         | Private native PostgreSQL, bounded egress, and an exact-digest bootstrap gate were source-defined but not deployed or read back. |
| 2026-08-16        | Issue #204 source only                  | `configured-unverified` | `configured-unverified` | `configured-unverified` | `configured-unverified` | `blocked`         | Staff-minimized resource definitions and dark SES resources were source-defined. Read-only SES inventory found production access and the verified domain; no provider call or notification send occurred. |
| 2026-08-21        | Deployed stack, access-sync task rev 27 | `live-verified`         | `configured-unverified` | `live-verified`         | `configured-unverified` | `live-verified`   | The deployed stack and access sync were read back. Snapshot version 176 contained one active access group and five evaluated memberships; evidence retained counts and digests only. The sign-in redirect and custom domain worked, but no completed district sign-in or messaging-provider delivery was observed. |

## Remaining boundary

Deployment and provider activation are separate. Email, push, and SMS remain
subject to their current readiness records and human-only send enforcement.
The first controlled provider action must be selected and confirmed by an
authenticated human in the application. No recipient identity belongs in
source, issue text, shell output, or repository artifacts.
