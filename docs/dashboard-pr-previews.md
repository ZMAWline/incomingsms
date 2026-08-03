# Dashboard PR previews

IncomingSMS dashboard review is Vercel-like enough for Zalmen's workflow: a dashboard change is not `ready to review` until a working, login-testable preview URL is included in the review message.

If code is complete but no preview URL is live, use `needs-preview` / blocked status instead of `ready to review`.

## Current implementation: shared Cloudflare dashboard-test preview

`.github/workflows/dashboard-pr-preview.yml` deploys dashboard-relevant pull requests to the existing Cloudflare Worker test environment:

```text
https://dashboard-test.zalmen-531.workers.dev
```

The workflow runs on PR open/synchronize/reopen and manual `workflow_dispatch`:

1. Check out the PR code.
2. Install dependencies and the esbuild test bundler.
3. Run `npm test`.
4. Dry-run `npx wrangler deploy --config src/dashboard/wrangler.toml --env test --dry-run`.
5. Deploy `npx wrangler deploy --config src/dashboard/wrangler.toml --env test`.
6. Smoke-test that the preview responds with the Basic Auth challenge.
7. Comment the preview URL on the PR.

This intentionally uses the existing `dashboard-test` Worker instead of creating a new Worker per PR. That keeps the framework usable immediately because Cloudflare secrets already attached to `dashboard-test` remain in place; Cloudflare Worker secrets are write-only and cannot be copied out to per-PR Workers.

Trade-off: previews are serialized through one shared review URL, so the newest dashboard PR deploy owns the shared preview. The workflow concurrency group is `dashboard-shared-preview` to prevent overlapping deploys.

## Safety

The shared preview deploys with `src/dashboard/wrangler.toml` `[env.test]`:

- Worker name: `dashboard-test`
- Service bindings target `*-test` workers, not production workers.
- Existing Cloudflare Worker secrets stay attached to `dashboard-test`; they are not exposed to GitHub logs or copied through chat.

Never put production Supabase, production carrier, or production customer-impacting credentials into preview/test resources.

## Required GitHub permissions and secrets

Pushing or updating `.github/workflows/*.yml` requires a GitHub token with `workflow` scope:

```bash
gh auth refresh -h github.com -s workflow
```

Required repository secrets:

- `CLOUDFLARE_API_TOKEN` - token that can deploy the dashboard Worker test environment.
- `CLOUDFLARE_ACCOUNT_ID` - Cloudflare account id.

No dashboard auth/Supabase secrets are required in GitHub Actions for the shared-preview implementation, because those are already Cloudflare Worker secrets on `dashboard-test`.

## Review-message rule for Kanban/Hermes workers

Use this format only after the preview URL is live and login-testable:

```text
Ready to review: <branch or PR>
Preview: https://dashboard-test.zalmen-531.workers.dev
Commit: <sha>
Tests: <targeted tests>
Notes: preview uses dashboard test bindings; destructive/carrier paths are disabled/mocked or backed by test-safe resources.
```

If any of these are missing, do not say `ready to review`. Say `needs-preview` or block with the exact missing permission/deploy failure.

## Future upgrade: unique per-PR URLs

A unique URL per PR is possible, but requires securely provisioning preview secrets for each generated Worker because Cloudflare does not expose existing Worker secret values for copying. Until that secret-management step exists, the shared `dashboard-test` preview is the safe working framework.
