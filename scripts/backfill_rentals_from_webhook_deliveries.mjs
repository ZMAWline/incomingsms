#!/usr/bin/env node
// =========================================================
// backfill_rentals_from_webhook_deliveries.mjs
//
// One-off backfill for the gap between 2026-05-29 (last batch backfill that
// populated `rentals`) and the deploy of the in-worker persist-rental hook
// added 2026-06-10. For every delivered `number.online` webhook whose
// response_body echoes a rentalId, idempotently upsert a matching `rentals`
// row keyed on the live unique constraint (reseller_id, sim_number_id).
//
// Usage:
//   node scripts/backfill_rentals_from_webhook_deliveries.mjs           # dry-run
//   node scripts/backfill_rentals_from_webhook_deliveries.mjs --apply   # commit
//
// Requires SUPABASE_ACCESS_TOKEN (Management API) and a project ref. Both load
// from .dev.vars at repo root.
// =========================================================

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const SINCE = '2026-05-29 00:00:00+00';

function loadEnv() {
  const envPath = resolve(process.cwd(), '.dev.vars');
  let text;
  try {
    text = readFileSync(envPath, 'utf8');
  } catch {
    throw new Error(`Cannot read ${envPath}`);
  }
  const map = {};
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) map[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  if (!map.SUPABASE_URL || !map.SUPABASE_ACCESS_TOKEN) {
    throw new Error('SUPABASE_URL and SUPABASE_ACCESS_TOKEN required in .dev.vars');
  }
  return map;
}

const env = loadEnv();
const PROJECT_REF = new URL(env.SUPABASE_URL).hostname.split('.')[0];

async function runSql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.SUPABASE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`SQL failed (${res.status}): ${text.slice(0, 500)}`);
  }
  try { return JSON.parse(text); } catch { return text; }
}

// Selection CTE shared by dry-run and apply. Picks the EARLIEST delivered
// row per (reseller_id, sim_number_id) so the rentalId we commit is the one
// from the "Rental created" response, not a later "End date updated" echo.
const CTE = `
WITH cand AS (
  SELECT
    wd.id            AS delivery_id,
    wd.reseller_id   AS reseller_id,
    wd.delivered_at  AS delivered_at,
    (wd.payload->'data'->>'sim_id')::bigint AS p_sim_id,
    (wd.payload->'data'->>'number')         AS p_number,
    (regexp_match(wd.response_body, '"rental[_]?[Ii]d"\\s*:\\s*([0-9]+)'))[1] AS r_rental_id
  FROM webhook_deliveries wd
  WHERE wd.event_type = 'number.online'
    AND wd.status = 'delivered'
    AND wd.response_body ~ '"rental[_]?[Ii]d"\\s*:\\s*[0-9]+'
    AND wd.created_at > '${SINCE}'
),
mapped AS (
  SELECT
    c.*,
    sn.id     AS sim_number_id,
    s.carrier AS carrier
  FROM cand c
  LEFT JOIN LATERAL (
    SELECT sn.id
    FROM sim_numbers sn
    WHERE sn.sim_id = c.p_sim_id
      AND sn.e164   = c.p_number
      AND sn.valid_from <= c.delivered_at
      AND (sn.valid_to IS NULL OR sn.valid_to >= c.delivered_at)
    ORDER BY sn.valid_from DESC
    LIMIT 1
  ) sn ON TRUE
  LEFT JOIN sims s ON s.id = c.p_sim_id
),
ranked AS (
  SELECT
    m.*,
    ROW_NUMBER() OVER (PARTITION BY m.reseller_id, m.sim_number_id ORDER BY m.delivered_at ASC) AS rn
  FROM mapped m
  WHERE m.sim_number_id IS NOT NULL
    AND m.carrier IN ('att','tmobile')
    AND m.r_rental_id IS NOT NULL
)
`;

async function dryRunCounts() {
  const sql = `${CTE}
SELECT
  (SELECT COUNT(*) FROM cand)                                                                                            AS total_candidates,
  (SELECT COUNT(*) FROM cand WHERE p_sim_id IS NULL OR p_number IS NULL)                                                  AS missing_sim_or_number,
  (SELECT COUNT(*) FROM mapped WHERE sim_number_id IS NULL)                                                               AS no_sim_number_match,
  (SELECT COUNT(*) FROM mapped WHERE carrier IS NULL OR carrier NOT IN ('att','tmobile'))                                 AS bad_carrier,
  (SELECT COUNT(*) FROM ranked WHERE rn=1)                                                                                AS unique_pairs,
  (SELECT COUNT(*) FROM ranked r WHERE r.rn=1 AND EXISTS (
     SELECT 1 FROM rentals x WHERE x.reseller_id = r.reseller_id AND x.sim_number_id = r.sim_number_id
  ))                                                                                                                       AS already_exists,
  (SELECT COUNT(*) FROM ranked r WHERE r.rn=1 AND NOT EXISTS (
     SELECT 1 FROM rentals x WHERE x.reseller_id = r.reseller_id AND x.sim_number_id = r.sim_number_id
  ))                                                                                                                       AS insertable;`;
  return runSql(sql);
}

async function applyInsert() {
  const sql = `${CTE}
INSERT INTO rentals (reseller_id, sim_id, sim_number_id, carrier, e164, reseller_rental_id, rental_date, minted_at, updated_at)
SELECT
  r.reseller_id,
  r.p_sim_id,
  r.sim_number_id,
  r.carrier,
  r.p_number,
  r.r_rental_id,
  (r.delivered_at AT TIME ZONE 'UTC')::date,
  r.delivered_at,
  r.delivered_at
FROM ranked r
WHERE r.rn = 1
ON CONFLICT (reseller_id, sim_number_id) DO NOTHING
RETURNING id;`;
  return runSql(sql);
}

async function postApplyAudit() {
  return runSql(`
    SELECT
      (SELECT MAX(minted_at) FROM rentals) AS latest_minted_at,
      (SELECT COUNT(*) FROM rentals WHERE minted_at > '${SINCE}') AS rentals_minted_after_since;
  `);
}

(async () => {
  console.log(`[backfill] project=${PROJECT_REF} since=${SINCE} mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  const counts = await dryRunCounts();
  console.log('[backfill] selection counts:');
  console.log(JSON.stringify(counts[0], null, 2));

  if (!APPLY) {
    console.log('\n[backfill] dry-run complete. Re-run with --apply to commit inserts.');
    return;
  }

  console.log('\n[backfill] applying INSERT … ON CONFLICT DO NOTHING …');
  const inserted = await applyInsert();
  const insertedCount = Array.isArray(inserted) ? inserted.length : 0;
  console.log(`[backfill] inserted rows: ${insertedCount}`);

  const audit = await postApplyAudit();
  console.log('[backfill] post-apply audit:');
  console.log(JSON.stringify(audit[0], null, 2));
})().catch((err) => {
  console.error('[backfill] FAILED:', err.message);
  process.exit(1);
});
