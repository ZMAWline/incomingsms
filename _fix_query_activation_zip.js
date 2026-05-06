// _fix_query_activation_zip.js
// When ATOMIC subscriberInquiry succeeds, also update sims.activation_zip
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// 1) Update syncActiveSim signature + body to accept and store zipCode
const OLD1 = `async function syncActiveSim(env, iccid, { mdn, activatedAt }) {
  try {
    const sims = await sbGet(env, 'sims?iccid=eq.' + encodeURIComponent(iccid) + '&select=id,iccid,status,activated_at&limit=1');`;

const NEW1 = `async function syncActiveSim(env, iccid, { mdn, activatedAt, zipCode }) {
  try {
    const sims = await sbGet(env, 'sims?iccid=eq.' + encodeURIComponent(iccid) + '&select=id,iccid,status,activated_at,activation_zip&limit=1');`;

if (!content.includes(OLD1)) { console.error('PATCH 1 FAILED: old string not found'); process.exit(1); }
content = content.replace(OLD1, NEW1);

// 2) In syncActiveSim, after the activatedAt block, add zipCode handling before the patch write
const OLD2 = `    if (Object.keys(patch).length > 0) {
      await sbPatch(env, 'sims?id=eq.' + sim.id, patch);
    }

    if (mdn) {`;

const NEW2 = `    if (zipCode && !sim.activation_zip) {
      patch.activation_zip = zipCode;
      result.activation_zip_set = zipCode;
    }

    if (Object.keys(patch).length > 0) {
      await sbPatch(env, 'sims?id=eq.' + sim.id, patch);
    }

    if (mdn) {`;

if (!content.includes(OLD2)) { console.error('PATCH 2 FAILED: old string not found'); process.exit(1); }
content = content.replace(OLD2, NEW2);

// 3) Pass zipCode from ATOMIC query handler into syncActiveSim
const OLD3 = `        db_update = await syncActiveSim(env, identifier, {
          mdn: wr2.Result.MSISDN || wr2.Result.msisdn || null,
          activatedAt: wr2.Result.activationDate || null,
        });`;

const NEW3 = `        db_update = await syncActiveSim(env, identifier, {
          mdn: wr2.Result.MSISDN || wr2.Result.msisdn || null,
          activatedAt: wr2.Result.activationDate || null,
          zipCode: (wr2.Result.address && wr2.Result.address.zipCode) || null,
        });`;

if (!content.includes(OLD3)) { console.error('PATCH 3 FAILED: old string not found'); process.exit(1); }
content = content.replace(OLD3, NEW3);

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied successfully.');
