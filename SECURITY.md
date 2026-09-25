# Security policy

This SDK signs and verifies payment requests with a merchant private key. If you find a vulnerability —
in signature verification, key handling, webhook verification, or anywhere else — please report it privately
rather than opening a public issue.

## Reporting

Use [GitHub Security Advisories](https://github.com/prestoconnect/presto-pay-sdk-js/security/advisories/new)
to report privately. Include:

- the affected version(s) and runtime (Node, Cloudflare Workers, Vercel Edge);
- steps to reproduce, or a minimal example;
- what you'd expect to happen instead.

## Scope

In scope: this package's own code (`src/`). Test fixtures under `spec/keys/` are generated and non-production;
real merchant or Presto staging credentials must never be committed.

## Supported versions

Pre-1.0: only the latest published version is supported. Once 1.0 ships, this section will list which major
versions still receive security fixes.
