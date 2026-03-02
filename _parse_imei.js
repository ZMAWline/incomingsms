const fs = require('fs');
const raw = fs.readFileSync('C:/Users/zalme/.claude/projects/C--Users-zalme-OneDrive-Documents-incomingsms-incomingsms/e3d3e793-8fde-4fa1-b313-7fdaef86173c/tool-results/mcp-supabase-execute_sql-1772118112973.txt', 'utf8');
const outer = JSON.parse(raw);
const text = outer[0].text;

// Find JSON array in text
const start = text.indexOf('[{');
const end = text.lastIndexOf('}]') + 2;
const rows = JSON.parse(text.slice(start, end));
console.log('Row count:', rows.length);
console.log('Sample:', JSON.stringify(rows[0]));

const headers = ['pool_id','imei','gateway_id','gateway_name','port','slot','sim_id','iccid','phone_number','sim_status','assigned_at'];
const lines = [headers.join(',')];
for (const r of rows) {
  lines.push(headers.map(h => {
    const v = r[h];
    if (v === null || v === undefined) return '';
    const s = String(v);
    return s.includes(',') ? '"' + s + '"' : s;
  }).join(','));
}
fs.writeFileSync('C:/Users/zalme/OneDrive/Documents/incomingsms/incomingsms/imei_in_use.csv', lines.join('\n'));
console.log('CSV written with', rows.length, 'rows');
