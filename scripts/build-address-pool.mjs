#!/usr/bin/env node
// Build src/shared/address-pool.mjs from OpenStreetMap Overpass API.
//
// Per state, queries Overpass for tagged civic buildings (post_office,
// library, townhall, courthouse, fire_station) that have a complete
// addr:housenumber + addr:street + addr:city + addr:postcode tag set,
// then writes 25+ ZIP-diverse entries per state to address-pool.mjs.
//
// Usage:
//   node scripts/build-address-pool.mjs                        # all 51 states, ~10-15 min
//   node scripts/build-address-pool.mjs --states=AL,AK         # subset, for testing
//   node scripts/build-address-pool.mjs --out=/tmp/pool.mjs    # write elsewhere
//   node scripts/build-address-pool.mjs --raw=/tmp/raw.json    # also dump raw candidates
//
// Free, no API key. Polite usage: 5s between queries, single endpoint.

import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const TARGET_PER_STATE = 30;          // pool target; verifier requires ≥20
const QUERY_DELAY_MS  = 5000;         // polite delay between Overpass calls
const HTTP_TIMEOUT_MS = 180000;       // Overpass can take 1-2 min per state

const ALL_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC',
];

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));
const STATES = args.states ? String(args.states).toUpperCase().split(',') : ALL_STATES;
const OUT_PATH = args.out || 'src/shared/address-pool.mjs';
const RAW_PATH = args.raw || null;

function buildQuery(stateAbbrev) {
  return `[out:json][timeout:120];
area["ISO3166-2"="US-${stateAbbrev}"]->.searchArea;
(
  nwr["amenity"="post_office"](area.searchArea);
  nwr["amenity"="library"](area.searchArea);
  nwr["amenity"="townhall"](area.searchArea);
  nwr["amenity"="courthouse"](area.searchArea);
  nwr["amenity"="fire_station"](area.searchArea);
);
out tags center;`;
}

async function fetchStateOnce(stateAbbrev) {
  const body = `data=${encodeURIComponent(buildQuery(stateAbbrev))}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // Overpass returns 406 without a contactable User-Agent.
        'User-Agent':   'incomingsms address-pool builder (https://github.com/ZMAWline/incomingsms)',
      },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().then(t => t.slice(0, 200)).catch(() => '');
      const err  = new Error(`Overpass HTTP ${res.status}: ${text}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Overpass returns 429 (rate-limited) and 504 (slot exhausted / gateway timeout)
// under load. Both are transient — back off and try again.
async function fetchState(stateAbbrev) {
  const backoffs = [30000, 60000, 120000]; // 30s, 60s, 120s
  let lastErr;
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    try {
      return await fetchStateOnce(stateAbbrev);
    } catch (err) {
      lastErr = err;
      const transient = err.status === 429 || err.status === 504 || err.name === 'AbortError';
      if (!transient || attempt === backoffs.length) throw err;
      process.stderr.write(`(retry in ${backoffs[attempt] / 1000}s: ${err.status || err.name}) `);
      await sleep(backoffs[attempt]);
    }
  }
  throw lastErr;
}

// Trim, collapse internal whitespace.
const norm = s => String(s || '').trim().replace(/\s+/g, ' ');

// Slug for the id field — lowercased ASCII, hyphens for spaces, drop weird chars.
function slug(s) {
  return norm(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Split a street like "632 W 6th Ave" into number + name. The number is
// always the leading numeric token. Everything after is the name.
// OSM gives us housenumber separately, so we just trim the name.
function buildEntry(tags, stateAbbrev) {
  const housenumber = norm(tags['addr:housenumber']);
  const street      = norm(tags['addr:street']);
  const city        = norm(tags['addr:city']);
  const zip         = norm(tags['addr:postcode']).slice(0, 5); // strip ZIP+4
  if (!housenumber || !street || !city || !zip) return null;
  if (!/^\d+[a-zA-Z]?$/.test(housenumber)) return null;        // skip "13-15", "100A-B" etc.
  if (!/^\d{5}$/.test(zip)) return null;                       // skip non-5-digit (PR-style)
  // PO Box postcodes — common across all states; AT&T would reject them anyway.
  // USPS reserves specific ZIPs for PO Box use only; skip obvious markers in the street.
  if (/^p\.?o\.?\s*box\b/i.test(street)) return null;
  return {
    id:              `${stateAbbrev.toLowerCase()}-${zip}-${slug(housenumber + ' ' + street)}`,
    streetNumber:    housenumber,
    streetName:      street,
    streetDirection: '',
    city,
    state:           stateAbbrev,
    zipCode:         zip,
  };
}

// Given many candidates for one state, pick up to TARGET_PER_STATE entries,
// each from a distinct ZIP. The verifier requires unique ZIPs per state,
// and the picker excludes by ZIP at pick time, so duplicates have no value.
// If the state has fewer than TARGET unique ZIPs with valid addresses, we
// return whatever's available (verifier will still pass as long as ≥20).
function pickDiverse(candidates) {
  const byZip = new Map();
  for (const c of candidates) {
    if (!byZip.has(c.zipCode)) byZip.set(c.zipCode, c);
  }
  return [...byZip.values()].slice(0, TARGET_PER_STATE);
}

const allEntries = [];
const allRaw     = {};
const stateStats = [];

for (const [i, state] of STATES.entries()) {
  process.stderr.write(`[${i + 1}/${STATES.length}] ${state}: `);
  let data;
  try {
    data = await fetchState(state);
  } catch (err) {
    process.stderr.write(`FAILED (${err.message})\n`);
    stateStats.push({ state, raw: 0, complete: 0, picked: 0, error: err.message });
    if (i < STATES.length - 1) await sleep(QUERY_DELAY_MS);
    continue;
  }
  const raw = Array.isArray(data?.elements) ? data.elements : [];
  const candidates = raw.map(el => buildEntry(el.tags || {}, state)).filter(Boolean);
  // dedupe by id (multiple OSM elements occasionally share an address tag set)
  const seen = new Set();
  const dedup = candidates.filter(c => seen.has(c.id) ? false : (seen.add(c.id), true));
  const picked = pickDiverse(dedup);
  process.stderr.write(`raw=${raw.length} complete=${dedup.length} picked=${picked.length} zips=${new Set(picked.map(p => p.zipCode)).size}\n`);
  stateStats.push({ state, raw: raw.length, complete: dedup.length, picked: picked.length });
  if (RAW_PATH) allRaw[state] = { picked, all: dedup };
  allEntries.push(...picked);
  if (i < STATES.length - 1) await sleep(QUERY_DELAY_MS);
}

if (RAW_PATH) {
  writeFileSync(RAW_PATH, JSON.stringify(allRaw, null, 2));
  process.stderr.write(`\nRaw candidates written to ${RAW_PATH}\n`);
}

// Sort: by state asc, then by zipCode asc, then by id asc — deterministic output.
allEntries.sort((a, b) => a.state.localeCompare(b.state) || a.zipCode.localeCompare(b.zipCode) || a.id.localeCompare(b.id));

const fileBody = `// Address pool used for ATOMIC/Helix PPU updates and activations.
// Auto-generated by scripts/build-address-pool.mjs from OpenStreetMap
// Overpass API. Each entry is a tagged civic building (post_office,
// library, townhall, courthouse, or fire_station) with a complete
// addr:housenumber + addr:street + addr:city + addr:postcode tag set.
//
// Regenerate: node scripts/build-address-pool.mjs
// Verifier:   node scripts/verify-address-pool.mjs
//
// Bad addresses are self-quarantined at runtime — see
// markAddressVerifyFailure in address-picker.mjs.

export const ADDRESS_POOL = ${formatPool(allEntries)};

// Kept for backward compatibility — random pick from the same set.
// Do NOT use for new code. Use pickNextPpuAddress() from address-picker.mjs.
export function pickRandomAddress() {
  return ADDRESS_POOL[Math.floor(Math.random() * ADDRESS_POOL.length)];
}
`;

function formatPool(entries) {
  const lines = ['['];
  let lastState = null;
  for (const e of entries) {
    if (e.state !== lastState) {
      if (lastState !== null) lines.push('');
      lines.push(`  // ----- ${e.state} -----`);
      lastState = e.state;
    }
    lines.push(`  ${JSON.stringify(e)},`);
  }
  lines.push(']');
  return lines.join('\n');
}

writeFileSync(OUT_PATH, fileBody);
process.stderr.write(`\nWrote ${allEntries.length} entries (${stateStats.filter(s => s.picked >= 20).length}/${STATES.length} states ≥20) to ${OUT_PATH}\n`);
const short = stateStats.filter(s => s.picked < 20);
if (short.length > 0) {
  process.stderr.write(`\nStates with <20 picked entries (verifier will FAIL):\n`);
  for (const s of short) process.stderr.write(`  ${s.state}: ${s.picked} (raw=${s.raw}, complete=${s.complete})${s.error ? ' ERROR: ' + s.error : ''}\n`);
  process.exit(1);
}
