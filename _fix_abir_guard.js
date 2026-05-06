// _fix_abir_guard.js
// Adds an ABIR guard to handleSimOnline (backend) so number.online cannot be
// sent for wing_iot SIMs in rotation_status='failed'. Also upgrades the
// bulkSendOnline frontend toast to surface ABIR rejections distinctly.
//
// Backend select must now include rotation_status (was: id,iccid,status,vendor,
// rotation_interval_hours,last_mdn_rotated_at).

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');

// Normalize to LF for reliable search/replace
content = content.replace(/\r\n/g, '\n');

// ── Patch 1: Backend handleSimOnline — add rotation_status to select + guard ──

const OLD1 =
  "    // Step 1: Get the SIM basic info\n" +
  "    const simResponse = await supabaseGet(env, `sims?select=id,iccid,status,vendor,rotation_interval_hours,last_mdn_rotated_at&id=eq.${simId}`);\n" +
  "    const sims = await simResponse.json();\n" +
  "\n" +
  "    if (!sims || sims.length === 0) {\n" +
  "      return new Response(JSON.stringify({ error: 'SIM not found' }), {\n" +
  "        status: 404,\n" +
  "        headers: { ...corsHeaders, 'Content-Type': 'application/json' }\n" +
  "      });\n" +
  "    }\n" +
  "\n" +
  "    const sim = sims[0];\n";

const NEW1 =
  "    // Step 1: Get the SIM basic info\n" +
  "    const simResponse = await supabaseGet(env, `sims?select=id,iccid,status,vendor,rotation_status,rotation_interval_hours,last_mdn_rotated_at&id=eq.${simId}`);\n" +
  "    const sims = await simResponse.json();\n" +
  "\n" +
  "    if (!sims || sims.length === 0) {\n" +
  "      return new Response(JSON.stringify({ error: 'SIM not found' }), {\n" +
  "        status: 404,\n" +
  "        headers: { ...corsHeaders, 'Content-Type': 'application/json' }\n" +
  "      });\n" +
  "    }\n" +
  "\n" +
  "    const sim = sims[0];\n" +
  "\n" +
  "    // ABIR guard: never broadcast number.online for a wing_iot SIM that the\n" +
  "    // rotation system has flagged as stuck on the ABIR (non-dialable) plan.\n" +
  "    // Its msisdn is a 5xxx interim MDN that can't receive normal SMS.\n" +
  "    if (sim.vendor === 'wing_iot' && sim.rotation_status === 'failed') {\n" +
  "      return new Response(JSON.stringify({\n" +
  "        ok: false,\n" +
  "        error: 'SIM is stuck on ABIR (non-dialable plan). Force-rotate it first before notifying online.',\n" +
  "        sim_id: simId,\n" +
  "        abir_skipped: true,\n" +
  "      }), {\n" +
  "        status: 200,\n" +
  "        headers: { ...corsHeaders, 'Content-Type': 'application/json' }\n" +
  "      });\n" +
  "    }\n";

if (!content.includes(OLD1)) {
  console.error('PATCH 1 FAILED: handleSimOnline anchor not found.');
  process.exit(1);
}
content = content.replace(OLD1, NEW1);
console.log('Patch 1 applied: handleSimOnline ABIR guard');

// ── Patch 2: Frontend bulkSendOnline — surface ABIR-skipped count distinctly ──
//
// Frontend lives inside getHTML() so backticks/`${` would close the outer
// template. We use plain single-quoted strings here, which is fine since the
// existing frontend code in this region uses ' and + concatenation already.

const OLD2 =
  "            let ok = 0, fail = 0;\n" +
  "            for (const sim of eligible) {\n" +
  "                try {\n" +
  "                    const resp = await fetch(API_BASE + '/sim-online', {\n" +
  "                        method: 'POST',\n" +
  "                        headers: { 'Content-Type': 'application/json' },\n" +
  "                        body: JSON.stringify({ sim_id: sim.id })\n" +
  "                    });\n" +
  "                    const result = await resp.json();\n" +
  "                    if (resp.ok && result.ok) { ok++; } else { fail++; }\n" +
  "                } catch { fail++; }\n" +
  "            }\n" +
  "            showToast(ok + ' sent' + (fail ? ', ' + fail + ' failed' : ''), fail ? 'error' : 'success');\n" +
  "        }";

const NEW2 =
  "            let ok = 0, fail = 0, abirSkipped = 0;\n" +
  "            for (const sim of eligible) {\n" +
  "                try {\n" +
  "                    const resp = await fetch(API_BASE + '/sim-online', {\n" +
  "                        method: 'POST',\n" +
  "                        headers: { 'Content-Type': 'application/json' },\n" +
  "                        body: JSON.stringify({ sim_id: sim.id })\n" +
  "                    });\n" +
  "                    const result = await resp.json();\n" +
  "                    if (resp.ok && result.ok) {\n" +
  "                        ok++;\n" +
  "                    } else if (result && result.abir_skipped) {\n" +
  "                        abirSkipped++;\n" +
  "                    } else {\n" +
  "                        fail++;\n" +
  "                    }\n" +
  "                } catch { fail++; }\n" +
  "            }\n" +
  "            const parts = [ok + ' sent'];\n" +
  "            if (abirSkipped) parts.push(abirSkipped + ' skipped (stuck on ABIR — force-rotate first)');\n" +
  "            if (fail) parts.push(fail + ' failed');\n" +
  "            const tone = fail ? 'error' : (abirSkipped ? 'warning' : 'success');\n" +
  "            showToast(parts.join(', '), tone);\n" +
  "        }";

if (!content.includes(OLD2)) {
  console.error('PATCH 2 FAILED: bulkSendOnline anchor not found.');
  process.exit(1);
}
content = content.replace(OLD2, NEW2);
console.log('Patch 2 applied: bulkSendOnline ABIR-skipped tracking');

// Convert back to CRLF
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('All patches applied successfully.');
