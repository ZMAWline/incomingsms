// Convert the saved Supabase MCP result into a CSV.
// Input: full file containing {"result":"...<untrusted-data-XXX>JSON-ARRAY</untrusted-data-XXX>..."}
// Output: wing_iot_rotation_failures_2026-04-27.csv

import { readFileSync, writeFileSync } from 'node:fs';

const SRC = 'C:/Users/zalme/.claude/projects/C--Users-zalme-OneDrive-Documents-incomingsms-incomingsms/bec4750c-17f1-4f65-a3f5-faf19511c5d5/tool-results/mcp-supabase-execute_sql-1777289271542.txt';
const OUT = 'C:/Users/zalme/OneDrive/Documents/incomingsms/incomingsms/wing_iot_rotation_failures_2026-04-27.csv';

const raw = readFileSync(SRC, 'utf8');
// File is the JSON-stringified wrapper, with embedded \n escapes for newlines.
// Skip the outer parse (the body contains characters that cause issues) and
// grab the array between untrusted-data markers directly.
const m = raw.match(/<untrusted-data-[^>]+>\\n([\s\S]*?)\\n<\/untrusted-data-[^>]+>/);
if (!m) throw new Error('untrusted-data block not found');
// The captured text is JSON-string-escaped (\" \n \\). Wrap in quotes and parse to unescape.
const arrayJson = JSON.parse('"' + m[1] + '"');
const rows = JSON.parse(arrayJson);

console.log(`Rows: ${rows.length}`);

const cols = [
  'sim_id',
  'iccid',
  'sim_status',
  'rotation_fail_count',
  'last_mdn_rotated_at',
  'last_rotation_error',
  'failed_step',
  'pre_msisdn',
  'pre_plan',
  'nd_put_url',
  'nd_put_body',
  'nd_put_status',
  'nd_put_response',
  'nd_verify_msisdn',
  'nd_verify_plan',
  'd_put_url',
  'd_put_body',
  'd_put_status',
  'd_put_response',
  'd_verify_msisdn',
  'd_verify_plan',
  'final_verify_url',
  'final_verify_method',
  'final_verify_response_body',
];

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'string' ? v : JSON.stringify(v);
  // Strip CR/LF that might break CSV row boundaries.
  s = s.replace(/\r/g, '').replace(/\n/g, '\\n');
  if (/[",]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

const lines = [cols.join(',')];
for (const r of rows) {
  lines.push(cols.map((c) => csvEscape(r[c])).join(','));
}
writeFileSync(OUT, lines.join('\r\n') + '\r\n', 'utf8');
console.log(`Wrote ${OUT} (${lines.length - 1} data rows)`);
