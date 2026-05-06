'use strict';
const fs = require('fs');
const path = require('path');
const filePath = path.join(__dirname, 'src', 'mdn-rotator', 'index.js');

let content = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');

const oldBlock =
  '        // Use cached BAN + MDN from DB if available; fall back to subscriber_details\n' +
  '        const dbMdn = sim.sim_numbers?.[0]?.e164;\n' +
  '        let mdn, attBan, d = null;\n' +
  '        if (dbMdn && (action !== "ota_refresh" || sim.att_ban)) {\n' +
  '          mdn = String(dbMdn).replace(/\\D/g, "").replace(/^1/, "");\n' +
  '          attBan = sim.att_ban || null;\n' +
  '          console.log(`[SimAction] SIM ${iccid}: using cached BAN=${attBan} MDN=${mdn}`);\n' +
  '        } else {\n' +
  '          // Fall back to subscriber_details\n' +
  '          const details = await hxSubscriberDetails(env, token, subId, runId, iccid);\n' +
  '          d = Array.isArray(details) ? details[0] : null;\n' +
  '          const rawPhone = d?.phoneNumber;\n' +
  '          attBan = d?.attBan || d?.ban || null;\n' +
  '          // Sync DB with Helix details (stores att_ban, activated_at backfill, etc.)\n' +
  '          syncSimFromHelixDetails(env, sim, d).catch(e => console.warn(`[SyncDetails] sim_id=${sim.id}: ${e}`));\n' +
  '          if (!rawPhone) {\n' +
  '            return new Response(JSON.stringify({ ok: false, error: `No phoneNumber from Helix for SIM ${iccid}` }), {\n' +
  '              status: 500,\n' +
  '              headers: { "Content-Type": "application/json" }\n' +
  '            });\n' +
  '          }\n' +
  '          mdn = String(rawPhone).replace(/\\D/g, "").replace(/^1/, "");\n' +
  '        }';

const newBlock =
  '        // Use cached BAN + MDN from DB if available; fall back to subscriber_details\n' +
  '        // DB MDN is always preferred over Helix MDN (DB reflects post-rotation state)\n' +
  '        const dbMdn = sim.sim_numbers?.[0]?.e164;\n' +
  '        let mdn, attBan, d = null;\n' +
  '        if (dbMdn && sim.att_ban) {\n' +
  '          // Full cache hit — skip subscriber_details entirely\n' +
  '          mdn = String(dbMdn).replace(/\\D/g, "").replace(/^1/, "");\n' +
  '          attBan = sim.att_ban;\n' +
  '          console.log(`[SimAction] SIM ${iccid}: full cache hit BAN=${attBan} MDN=${mdn}`);\n' +
  '        } else {\n' +
  '          // Need subscriber_details (att_ban not cached yet)\n' +
  '          const details = await hxSubscriberDetails(env, token, subId, runId, iccid);\n' +
  '          d = Array.isArray(details) ? details[0] : null;\n' +
  '          attBan = d?.attBan || d?.ban || null;\n' +
  '          // Sync DB with Helix details (stores att_ban, activated_at backfill, etc.)\n' +
  '          syncSimFromHelixDetails(env, sim, d).catch(e => console.warn(`[SyncDetails] sim_id=${sim.id}: ${e}`));\n' +
  '          // Prefer DB MDN (post-rotation) over Helix MDN (may be stale after rotation)\n' +
  '          const mdnSource = dbMdn || d?.phoneNumber;\n' +
  '          if (!mdnSource) {\n' +
  '            return new Response(JSON.stringify({ ok: false, error: `No phoneNumber for SIM ${iccid}` }), {\n' +
  '              status: 500,\n' +
  '              headers: { "Content-Type": "application/json" }\n' +
  '            });\n' +
  '          }\n' +
  '          mdn = String(mdnSource).replace(/\\D/g, "").replace(/^1/, "");\n' +
  '          console.log(`[SimAction] SIM ${iccid}: using ${dbMdn ? "DB" : "Helix"} MDN=${mdn}`);\n' +
  '        }';

if (!content.includes(oldBlock)) throw new Error('Block not found');
content = content.replace(oldBlock, newBlock);

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Fixed.');
