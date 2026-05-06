// _fix_billing_shared_module.js
// Refactor handleBillingPreview and the math block of handleBillingDownloadInvoice
// to call the shared computeBillingBreakdown from src/shared/billing.js.
// Local helpers todayEst / estDateFromDate / nextEstDate stay in place (they're
// used elsewhere via local references); the shared module has its own copies.

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// --- 1. Add import at the very top -----------------------------------------
const IMPORT_LINE = "import { computeBillingBreakdown } from '../shared/billing.js';\n";
if (!content.startsWith(IMPORT_LINE)) {
  if (content.includes(IMPORT_LINE.trim())) {
    console.error('PATCH FAILED: import already present in middle of file (unexpected).');
    process.exit(1);
  }
  content = IMPORT_LINE + content;
  console.log('Added import for computeBillingBreakdown.');
} else {
  console.log('Import already present, skipping.');
}

// --- 2. Replace handleBillingPreview body ---------------------------------
const PREVIEW_OLD = [
  "async function handleBillingPreview(url, env, corsHeaders) {",
  "  try {",
  "    const resellerId = url.searchParams.get('reseller_id');",
  "    const start = url.searchParams.get('start');",
  "    const end = url.searchParams.get('end');",
  "    if (!resellerId || !start || !end) {",
  "      return new Response(JSON.stringify({ error: 'reseller_id, start, end required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });",
  "    }",
].join('\n');

if (!content.includes(PREVIEW_OLD)) {
  console.error('PATCH FAILED: handleBillingPreview start signature not found.');
  process.exit(1);
}

// Find function start, then walk to its end (matching closing brace at depth 0)
const fnStart = content.indexOf('async function handleBillingPreview(url, env, corsHeaders) {');
if (fnStart === -1) { console.error('PATCH FAILED: handleBillingPreview not found'); process.exit(1); }
const nextFnMarker = '\nasync function handleBillingCreateInvoice';
const nextFn = content.indexOf(nextFnMarker, fnStart);
if (nextFn === -1) { console.error('PATCH FAILED: handleBillingCreateInvoice marker not found'); process.exit(1); }
// fnEnd points to the newline before the next function, so the body+closing-brace is content[fnStart:nextFn]

const PREVIEW_NEW = [
  "async function handleBillingPreview(url, env, corsHeaders) {",
  "  try {",
  "    const resellerId = url.searchParams.get('reseller_id');",
  "    const start = url.searchParams.get('start');",
  "    const end = url.searchParams.get('end');",
  "    if (!resellerId || !start || !end) {",
  "      return new Response(JSON.stringify({ error: 'reseller_id, start, end required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });",
  "    }",
  "    const result = await computeBillingBreakdown(env, { resellerId, start, end });",
  "    return new Response(JSON.stringify(result), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });",
  "  } catch (error) {",
  "    return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });",
  "  }",
  "}",
].join('\n');

content = content.slice(0, fnStart) + PREVIEW_NEW + content.slice(nextFn);
console.log('Replaced handleBillingPreview body.');

// --- 3. Replace billing-math chunk in handleBillingDownloadInvoice --------
// Before: fetches mapping, builds attDays/teltikSimIds, computes attEntries/teltikEntries,
// produces `days`, `totalSimDays`, `totalAmount`. Followed by `if (totalSimDays === 0)` guard.
// After: single call to computeBillingBreakdown returning all of these.

const DL_OLD_START_NEEDLE = "    const mappingResp = await supabaseGet(env, 'qbo_customer_map?select=id,qbo_display_name,daily_rate&reseller_id=eq.' + encodeURIComponent(resellerId) + '&limit=1');";
const DL_OLD_END_NEEDLE = "    const totalAmount = +(days.reduce((s, d) => s + d.amount, 0)).toFixed(2);";

const dlStart = content.indexOf(DL_OLD_START_NEEDLE);
if (dlStart === -1) { console.error('PATCH FAILED: download-invoice mapping fetch not found'); process.exit(1); }
const dlEnd = content.indexOf(DL_OLD_END_NEEDLE, dlStart);
if (dlEnd === -1) { console.error('PATCH FAILED: download-invoice totalAmount line not found'); process.exit(1); }
const dlEndAfter = dlEnd + DL_OLD_END_NEEDLE.length;

const DL_NEW = [
  "    const breakdown = await computeBillingBreakdown(env, { resellerId, start, end });",
  "    if (!breakdown.mapping) {",
  "      return new Response(JSON.stringify({ error: 'No customer rate configured for this reseller' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });",
  "    }",
  "    const mapping = breakdown.mapping;",
  "    const dailyRate = breakdown.daily_rate;",
  "    const days = breakdown.days;",
  "    const totalSimDays = breakdown.total_sim_days;",
  "    const totalAmount = breakdown.total_amount;",
].join('\n');

content = content.slice(0, dlStart) + DL_NEW + content.slice(dlEndAfter);
console.log('Replaced handleBillingDownloadInvoice billing-math chunk.');

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied successfully.');
