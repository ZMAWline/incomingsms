# IncomingSMS — Cloudflare Workers

IncomingSMS rents out phone lines that receive SMS. It activates SIM cards
with the carrier, keeps each line's phone number and IMEI healthy, receives
the text messages that arrive on those lines, and delivers them to resellers
and customers. Operators run everything from one web dashboard.

All SIMs are hosted by Teltik. The SkyLine gateway hardware and Wing IoT
lines are retired; the code that still mentions them is legacy.

## Workers

Each directory under `src/` is one Cloudflare Worker with its own
`wrangler.toml`. `src/shared/` holds code the workers import.

| Worker | What it does |
|---|---|
| `dashboard` | Operator web app and API for every manual operation; calls the other workers over service bindings |
| `sms-ingest` | Receives pushed SMS, stores them, and triggers an IMEI change on AT&T "unsupported device" messages |
| `teltik-worker` | Teltik line management: imports lines, receives SMS webhooks, rotates numbers |
| `bulk-activator` | Activates SIM cards (queue consumer plus HTTP `/activate`) |
| `details-finalizer` | Polls provisioning SIMs and promotes them to active once the carrier returns a number |
| `mdn-rotator` | Daily phone-number rotation, the fix-SIM flow, and manual SIM actions |
| `ota-status-sync` | Syncs over-the-air update status from the carrier |
| `reseller-sync` | Re-sends `number.online` webhooks that failed during rotation |
| `sim-canceller` | Cancels a SIM with the carrier |
| `sim-status-changer` | Suspends or restores a SIM with the carrier |
| `phone-number-sync` | Utility worker that syncs phone numbers |
| `bad-rental-remediator` | Diagnoses and fixes rentals reported as not working |
| `quickbooks` | QuickBooks Online sign-in, customer mapping, and invoices |
| `reseller-portal` | Read-only portal and JSON API for resellers (own SIMs, invoices, usage) |
| `storefront` | Customer-facing shop for day rentals of SMS numbers |
| `otp-portal` | Small login-gated page that hands a trusted user one temporary number |
| `teltik-portal` | Small login-gated page for Teltik support to check and reset lines |
| `skyline-gateway` | Legacy: relay to the retired SkyLine gateway hardware |
| `kasa-control` | Legacy: power control for the retired gateway hardware |

`agent/project-map.md` has triggers, bindings, queues, and data flows.

## Services used

- **Supabase** — the database (PostgREST). Workers use the service-role key.
- **Cloudflare Workers** — runs every worker, plus queues and KV.
- **Teltik** — hosts every SIM; SMS forwarding, port resets, SIM swaps.
- **ATOMIC** — AT&T wholesale API: activation, subscriber changes, port-ins.
- **QuickBooks Online** — reseller invoicing.
- **Resend** — outgoing email.

Helix (the older AT&T SOLO API) code is still present behind the
`HELIX_ENABLED` flag and is legacy.

## Prerequisites

- Node.js 20 or later
- A Cloudflare account with access to the `zalmen-531` workers
- Wrangler (`npx wrangler` works; no global install needed)

## Local setup

1. Copy the example variables and fill them in:
   ```bash
   cp .dev.vars.example .dev.vars
   ```
2. Run one worker locally:
   ```bash
   cd src/<worker-name>
   npx wrangler dev
   ```
   The worker is served at `http://localhost:8787`.

Never commit `.dev.vars` or paste secrets into chat. Set production secrets
with `printf` (not `echo`), because `echo` adds a newline to the value:
```bash
printf '%s' "$VALUE" | npx wrangler secret put NAME
```

## Tests

```bash
npm test
```

Runs every `tests/*.test.mjs` file with Node's built-in test runner. After
any dashboard change, also run both syntax checks:

```bash
node --input-type=module --check < src/dashboard/index.js   # Worker module
node scripts/check-frontend-js.js                            # inline <script> blocks in public/index.html
```

## Deploying

Deploys run only from the main checkout, after the change is merged to
`main`.

- **Normal path:** run `/main-deploy` in Claude Code from the main checkout.
  It pulls, finds which workers changed since the last deploy, runs the
  tests, deploys each changed worker, and moves the deploy marker.
- **One worker by hand:** `scripts/deploy.sh <worker-name>` (production) or
  `scripts/deploy.sh <worker-name> --env test`. The script refuses to ship if
  tests or the DB-constraint check fail, or if the checkout is stale.
- **Never run `wrangler deploy` directly.** It replaces the whole worker with
  your working copy and can silently revert other people's merged work.

Dashboard pull requests get their own preview URL from
`.github/workflows/dashboard-pr-preview.yml`.

## SMS ingest authentication

`sms-ingest` checks a shared secret (`GATEWAY_SECRET`). Send it in a header:

1. `X-Ingest-Secret: <secret>` (preferred)
2. `Authorization: Bearer <secret>`
3. `x-gateway-secret: <secret>` (older header name)

The URL forms `?secret=<secret>` and `/s/<secret>` still work for existing
push configurations, but they log a deprecation warning because the secret
ends up in access logs.

## Legacy vendors

Wing IoT, Helix, the SkyLine gateways and the Kasa power strips are no longer
in use. Their code is still in the repo and still tested, but it is switched
off by default. Nothing calls those vendors unless you turn one back on.

What is off while a vendor is switched off:

| Vendor | Worker | What is skipped |
|---|---|---|
| Helix | mdn-rotator | Helix token fetch on every tick, Helix rotation, fix-sim, OTA/cancel/resume, `/check-imei(s)` |
| Helix | details-finalizer | Helix finalizer |
| Helix | sim-canceller, sim-status-changer, ota-status-sync, bulk-activator | Helix cancel, suspend/restore, OTA sync, activation |
| Wing IoT | mdn-rotator | Wing rotation, stuck-Wing pass, `/remediate-stuck-wing` |
| Wing IoT | details-finalizer | Wing finalizer, Wing cleanup sweep, reconcile bucket A |
| Wing IoT | sim-canceller, sim-status-changer, bulk-activator | Wing cancel, status change, activation |
| SkyLine | mdn-rotator | gateway scan, IMEI write, retry activation, blimei sweep, gateway slot sync |
| SkyLine | bad-rental-remediator | S5 port probe, verify SMS send |
| SkyLine | sms-ingest | gateway slot sync trigger |
| Any | dashboard | 10 legacy routes and `/api/kasa/*` answer 409 |

A blocked call returns `{ ok: false, reason: "legacy_vendor_disabled", vendor }`.
A blocked HTTP route answers 409 with `how_to_enable`. The dashboard shows it
in the error toast.

To turn one back on:

1. In each worker's `wrangler.toml` `[vars]` (and `[env.test.vars]` for TEST),
   replace the commented line with, for example:
   ```toml
   LEGACY_VENDORS = "helix"
   ```
   Use a comma-separated list (`"helix,wing,skyline,kasa"`) or `"all"`.
   Case and spaces do not matter.
2. Merge, then deploy each changed worker with `scripts/deploy.sh <worker>`.

The switch lives in `src/shared/legacy-vendors.mjs`. The skyline-gateway and
kasa-control workers stay deployed behind their admin secrets.

## Agent notes

Notes for Claude Code sessions live in `agent/`:

- `agent/BOOTSTRAP.md` — read first; the working rules.
- `agent/current-state.md` — what shipped, what is pending, open follow-ups.
- `agent/project-map.md` — workers, bindings, tables, data flows.
- `agent/constraints.md` — hard rules that prevent known failures.
- `agent/secrets-inventory.md` — every secret and var name, where it lives, how to rotate it.

### Briefs

Parallel work runs one chat per open item. Each item starts from a committed
brief in `agent/briefs/`, named `YYYY-MM-DD-<letter>-<slug>.md`. A brief
states the task, the rules (work in a task worktree, do not deploy), and when
it is done. The chat updates the brief's `Status:` line when it finishes.
Only the main checkout deploys.

## Project layout

```
src/<worker>/     one Cloudflare Worker per directory
src/shared/       modules shared between workers
tests/            node:test suites (npm test)
scripts/          deploy.sh, checks, one-off maintenance scripts
supabase/         SQL migrations
agent/            notes and briefs for Claude Code sessions
docs/             design specs and plans
```
