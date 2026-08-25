# App Runner custom-domain recovery

Current DNS, certificate, and service-association state lives only in the
[operational readiness register](../INTEGRATIONS.md). Tenant names, origins,
account/region, service ARN, and DNS authority come from the protected
configuration indexed by [CONFIGURATION.md](../CONFIGURATION.md); never copy
another district's values from an old incident record.

## Inspect

1. Record the configured public origin, App Runner service ARN, account,
   region, and authoritative public DNS provider.
2. Read the App Runner custom-domain association without changing it.
3. Resolve CNAME/A/AAAA records through a public resolver and the authoritative
   provider. Keep internal split-horizon DNS observations separate.
4. Inspect the served certificate name, issuer, validity, and chain.
5. Request `/login` and the side-effect-free health endpoint. Do not request a
   human-only action or provider-send path.
6. Record observations with UTC timestamps. A healthy provider URL does not
   prove the custom domain or certificate is healthy.

## Recover

Before a write, confirm whether the fault is the App Runner association, DNS
records/delegation, or certificate validation. Change only the proven failing
boundary through its approved provider surface. Preserve the previous records
and service association as rollback evidence.

- Never let a link preview, GET request, webhook, or schedule perform the
  association.
- Never change OAuth, recipients, notification providers, application data, or
  human-only capability state as part of DNS recovery.
- Disable the `www` association unless the tenant configuration explicitly
  requires it.
- Allow for DNS TTL and certificate validation before declaring failure.

After recovery, repeat every inspection step from two independent public
resolvers and update only the corresponding readiness row with dated evidence.

The prior tenant-specific recovery record is preserved in the
[historical archive](../archive/runbooks/eoc-custom-domain-2026-08-25.md).
