import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { ADDRESS_POOL } = require('../src/shared/address-pool.js');

const REQUIRED_FIELDS = ['id', 'streetNumber', 'streetName', 'city', 'state', 'zipCode'];
const MIN_ZIPS_PER_STATE = 20;
const REQUIRED_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC'
];

const errors = [];
const idsSeen = new Set();
const stateZips = new Map();

for (const [i, e] of ADDRESS_POOL.entries()) {
  for (const f of REQUIRED_FIELDS) {
    if (!e[f] || typeof e[f] !== 'string') {
      errors.push(`entry[${i}] missing/non-string field "${f}": ${JSON.stringify(e)}`);
    }
  }
  if (idsSeen.has(e.id)) errors.push(`duplicate id: ${e.id}`);
  idsSeen.add(e.id);
  if (!/^[A-Z]{2}$/.test(e.state)) errors.push(`bad state for id=${e.id}: ${e.state}`);
  if (!/^\d{5}$/.test(e.zipCode)) errors.push(`bad zip for id=${e.id}: ${e.zipCode}`);

  const key = e.state;
  if (!stateZips.has(key)) stateZips.set(key, new Set());
  if (stateZips.get(key).has(e.zipCode)) {
    errors.push(`duplicate zip ${e.zipCode} within state ${e.state} (id=${e.id})`);
  }
  stateZips.get(key).add(e.zipCode);
}

for (const st of REQUIRED_STATES) {
  const count = stateZips.get(st)?.size ?? 0;
  if (count < MIN_ZIPS_PER_STATE) {
    errors.push(`state ${st} has only ${count} unique zips (need ${MIN_ZIPS_PER_STATE})`);
  }
}

if (errors.length > 0) {
  console.error(`FAIL: ${errors.length} issue(s):`);
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log(`OK: ${ADDRESS_POOL.length} entries, ${stateZips.size} states, all checks passed.`);
