# INC-8 — operator deploy needed

Status: **code merged, awaiting prod deploy**

## What's done
- Fix merged to `main` as commit `3811147` (PR #6, squashed).
- Change: 3-line addition to `src/dashboard/index.js` registering `bad-rentals` in `TAB_ROUTES`, `PAGE_TITLES`, and `PAGE_HEADERS`. Root cause was that direct navigation to `/bad-rentals` mapped to `undefined` in `ROUTE_TO_TAB` and fell back to the dashboard tab.
- Both syntax checks (outer Worker + frontend JS via vm) passed pre-merge.

## What an operator still needs to do
```
cd src/dashboard && npx wrangler deploy --env=""
```
Run from a host with `CLOUDFLARE_API_TOKEN` set. This heartbeat host has no CF auth (per [inc-env-no-deploy-creds](.claude/../memory/inc-env-no-deploy-creds.md)).

## Verify after deploy
- Visit `https://dashboard.zalmen-531.workers.dev/bad-rentals` directly → should land on Bad Rentals tab (not dashboard).
- Sidebar "Bad Rentals" link → URL becomes `/bad-rentals`, tab active.
- Browser back/forward correctly restores previous tab.
