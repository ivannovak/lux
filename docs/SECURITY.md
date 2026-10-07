# Security and secret hygiene

## Never commit credentials or generated build output

- Keep credentials in a secret manager or local environment only.
- Never track `.env` or `.env.*` files. Sanitized `.env.example`, `.env.sample`, and `.env.template` files are the only allowed exceptions.
- Never track Next.js `.next/` output. It can contain generated Server Function encryption keys and preview-mode signing/encryption material.

The repository enforces these rules with:

- `npm run verify:repository-hygiene` for deterministic tracked-path checks.
- `npm run scan:secrets` for a redacted Gitleaks scan of every ref available in the local clone.
- `npm run test:security-gates` for synthetic mutation tests covering path rejection, scanner suppression resistance, and output redaction.
- The CI `secret-scan` job, which fetches complete branch/tag history before running the checks.

GitHub-managed `refs/pull/*` are not reliably fetched by ordinary Actions checkout. After a sensitive-history rewrite, deleting and recreating the repository or obtaining a GitHub Support purge is still required; passing CI alone does not prove old pull-request refs are absent.

## Local pre-push protection

Install the repository's pre-push hook without replacing any existing hook:

```sh
ln -s ../../bin/pre-push-secret-scan.sh .git/hooks/pre-push
```

If `.git/hooks/pre-push` already exists, integrate these two commands into it instead:

```sh
npm run verify:repository-hygiene
npm run scan:secrets
```

The scan is intentionally fail-closed. Do not add allowlist entries merely to make CI green. Confirm that a finding is non-secret, document the rationale in review, and narrowly suppress only the exact false positive.

## Credential files are never indexed

Lux indexes the files git tracks, never ignored or untracked ones, and a built-in deny list keeps
credential files out even when they are tracked: `auth.json`, `.env`, `.env.*` (except
`.env.example`), `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `.npmrc` and `.netrc`. A run that
skips one names it in one warning. `lux.yaml` `scan.deny_patterns` adds patterns; nothing removes a
built-in one. The list lives in `src/scanner/file-universe.ts`; see docs/USAGE.md, "Which files are
indexed".

## If a credential is committed

1. Stop using and revoke or rotate it immediately.
2. Make the repository private while exposure is assessed.
3. Review provider usage and billing logs for abuse.
4. Rewrite every affected ref; deleting the file in a later commit is insufficient.
5. Account for GitHub-managed pull-request refs, releases, caches, packages, forks, clones, mirrors, bundles, and deployment checkouts.
6. Validate the rewritten history with at least two independent scanners before restoring public visibility.
