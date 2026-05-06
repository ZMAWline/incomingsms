// _fix_query_db_sync.js
// Add DB sync (status, MDN, activated_at) to ATOMIC and Wing IoT query handlers
// when they return an active SIM. Also surface the update in bulk query output
// and the single-SIM carrier query modal.

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// ─────────────────────────────────────────────────────────────
// 1. Add toE164 + syncActiveSim after syncCancelledSim
// ─────────────────────────────────────────────────────────────
const OLD1 = `    return result;
  } catch (e) {
    return { error: String(e) };
  }
}

async function handleHelixQueryBulk(request, env, corsHeaders) {`;

const NEW1 = `    return result;
  } catch (e) {
    return { error: String(e) };
  }
}

function toE164(mdn) {
  if (!mdn) return null;
  const digits = String(mdn).replace(/\\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return null;
}

async function syncActiveSim(env, iccid, { mdn, activatedAt }) {
  try {
    const sims = await sbGet(env, 'sims?iccid=eq.' + encodeURIComponent(iccid) + '&select=id,iccid,status,activated_at&limit=1');
    const sim = Array.isArray(sims) ? sims[0] : null;
    if (!sim) return { found: false };

    const result = { found: true, iccid: sim.iccid, sim_id: sim.id };
    const patch = {};

    if (sim.status !== 'active') {
      patch.status = 'active';
      result.status_updated = true;
      result.previous_status = sim.status;
    }

    if (activatedAt && !sim.activated_at) {
      const parsed = new Date(activatedAt);
      if (!isNaN(parsed.getTime())) {
        patch.activated_at = parsed.toISOString();
        result.activated_at_set = patch.activated_at;
      }
    } else if (sim.activated_at) {
      result.activated_at = sim.activated_at;
    }

    if (Object.keys(patch).length > 0) {
      await sbPatch(env, 'sims?id=eq.' + sim.id, patch);
    }

    if (mdn) {
      const e164 = toE164(mdn);
      if (e164) {
        const existing = await sbGet(env, 'sim_numbers?sim_id=eq.' + sim.id + '&valid_to=is.null&select=e164&limit=1');
        const currentMdn = Array.isArray(existing) && existing[0] ? existing[0].e164 : null;
        if (currentMdn !== e164) {
          const now = new Date().toISOString();
          if (currentMdn) {
            await sbPatch(env, 'sim_numbers?sim_id=eq.' + sim.id + '&valid_to=is.null', { valid_to: now });
          }
          await sbPost(env, 'sim_numbers', { sim_id: sim.id, e164, valid_from: now, valid_to: null });
          result.mdn_updated = true;
          result.mdn_old = currentMdn;
          result.mdn_new = e164;
        } else {
          result.mdn_already_set = true;
          result.mdn = currentMdn;
        }
      }
    }

    return result;
  } catch (e) {
    return { error: String(e) };
  }
}

async function handleHelixQueryBulk(request, env, corsHeaders) {`;

if (!content.includes(OLD1)) { console.error('PATCH FAILED: OLD1 (syncActiveSim insert) not found'); process.exit(1); }
content = content.replace(OLD1, NEW1);
console.log('1. syncActiveSim + toE164 added');

// ─────────────────────────────────────────────────────────────
// 2. handleAtomicQuery — add db_update before return
// ─────────────────────────────────────────────────────────────
const OLD2 = `    return new Response(JSON.stringify({ ok: true, response: data }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}`;

const NEW2 = `    let db_update = null;
    const wr2 = data && data.wholeSaleApi && data.wholeSaleApi.wholeSaleResponse;
    if (res.ok && wr2 && wr2.statusCode === '00' && wr2.Result && wr2.Result.attStatus === 'Active') {
      if (isIccid) {
        db_update = await syncActiveSim(env, identifier, {
          mdn: wr2.Result.MSISDN || null,
          activatedAt: wr2.Result.activationDate || null,
        });
      }
    }
    return new Response(JSON.stringify({ ok: true, response: data, db_update }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}`;

if (!content.includes(OLD2)) { console.error('PATCH FAILED: OLD2 (handleAtomicQuery return) not found'); process.exit(1); }
content = content.replace(OLD2, NEW2);
console.log('2. handleAtomicQuery db_update added');

// ─────────────────────────────────────────────────────────────
// 3. handleWingCheck — add db_update before return
// ─────────────────────────────────────────────────────────────
const OLD3 = `    return new Response(JSON.stringify({
      ok: res.ok,
      status: res.status,
      iccid,
      response: json || text
    }, null, 2), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleHelixQuery(request, env, corsHeaders) {`;

const NEW3 = `    let db_update_wing = null;
    if (res.ok && json && json.status && json.status.toLowerCase() === 'active') {
      db_update_wing = await syncActiveSim(env, iccid, { mdn: json.mdn || null, activatedAt: null });
    }
    return new Response(JSON.stringify({
      ok: res.ok,
      status: res.status,
      iccid,
      response: json || text,
      db_update: db_update_wing,
    }, null, 2), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleHelixQuery(request, env, corsHeaders) {`;

if (!content.includes(OLD3)) { console.error('PATCH FAILED: OLD3 (handleWingCheck return) not found'); process.exit(1); }
content = content.replace(OLD3, NEW3);
console.log('3. handleWingCheck db_update added');

// ─────────────────────────────────────────────────────────────
// 4. Banner HTML — add id to title <p> for dynamic updates
// ─────────────────────────────────────────────────────────────
const OLD4 = `<p class="text-xs font-semibold text-yellow-400 mb-1">&#x26A0; DB Auto-Synced — Line marked Cancelled</p>`;
const NEW4 = `<p id="helix-db-update-title" class="text-xs font-semibold text-yellow-400 mb-1">&#x26A0; DB Auto-Synced</p>`;

if (!content.includes(OLD4)) { console.error('PATCH FAILED: OLD4 (banner title) not found'); process.exit(1); }
content = content.replace(OLD4, NEW4);
console.log('4. Banner title made dynamic');

// ─────────────────────────────────────────────────────────────
// 5. bulkQuery — Wing IoT ok branch: show db_update note
// ─────────────────────────────────────────────────────────────
const OLD5 =
`                        if (r.ok) {
                            okCount++;
                            lines.push(label + ' [wing_iot]: ' + (r.response && r.response.status ? r.response.status : 'OK'));
                        } else {`;
const NEW5 =
`                        if (r.ok) {
                            okCount++;
                            const wStatus = r.response && r.response.status ? r.response.status : 'OK';
                            const wNote = r.db_update && r.db_update.found ? (r.db_update.status_updated ? ' [status\u2192active]' : '') + (r.db_update.mdn_updated ? ' [MDN\u2192' + r.db_update.mdn_new + ']' : '') : '';
                            lines.push(label + ' [wing_iot]: ' + wStatus + wNote);
                        } else {`;

if (!content.includes(OLD5)) { console.error('PATCH FAILED: OLD5 (bulkQuery wing ok branch) not found'); process.exit(1); }
content = content.replace(OLD5, NEW5);
console.log('5. bulkQuery wing_iot ok branch updated');

// ─────────────────────────────────────────────────────────────
// 6. bulkQuery — ATOMIC ok branch: show db_update note
// ─────────────────────────────────────────────────────────────
const OLD6 =
`                            const attStatus = (wr && wr.Result && wr.Result.attStatus) ? wr.Result.attStatus : (wr && wr.statusCode ? wr.statusCode : 'OK');
                            okCount++;
                            lines.push(label + ' [atomic]: ' + attStatus);`;
const NEW6 =
`                            const attStatus = (wr && wr.Result && wr.Result.attStatus) ? wr.Result.attStatus : (wr && wr.statusCode ? wr.statusCode : 'OK');
                            okCount++;
                            const aNote = r.db_update && r.db_update.found ? (r.db_update.status_updated ? ' [status\u2192active]' : '') + (r.db_update.mdn_updated ? ' [MDN\u2192' + r.db_update.mdn_new + ']' : '') : '';
                            lines.push(label + ' [atomic]: ' + attStatus + aNote);`;

if (!content.includes(OLD6)) { console.error('PATCH FAILED: OLD6 (bulkQuery atomic ok branch) not found'); process.exit(1); }
content = content.replace(OLD6, NEW6);
console.log('6. bulkQuery atomic ok branch updated');

// ─────────────────────────────────────────────────────────────
// 7. queryHelix Wing IoT — show db_update banner after result
// Use unique 'Error querying Wing IoT' marker to avoid \\n matching issues
// ─────────────────────────────────────────────────────────────
const OLD7 =
`                    resultDiv.classList.remove('hidden');
                } catch (error) {
                    showToast('Error querying Wing IoT', 'error');`;

const NEW7 =
`                    const wdu = result.db_update;
                    if (wdu && wdu.found) {
                        const wdLines = [];
                        if (wdu.status_updated) wdLines.push('Status: ' + wdu.previous_status + ' \u2192 active');
                        if (wdu.mdn_updated) wdLines.push('MDN: ' + (wdu.mdn_old || '(none)') + ' \u2192 ' + wdu.mdn_new);
                        if (wdLines.length > 0) {
                            document.getElementById('helix-db-update-title').textContent = '\\u26A0 DB Auto-Synced';
                            document.getElementById('helix-db-update-output').textContent = wdLines.join('\\\\n');
                            document.getElementById('helix-db-update-banner').classList.remove('hidden');
                        }
                    }
                    resultDiv.classList.remove('hidden');
                } catch (error) {
                    showToast('Error querying Wing IoT', 'error');`;

if (!content.includes(OLD7)) { console.error('PATCH FAILED: OLD7 (queryHelix wing result) not found'); process.exit(1); }
content = content.replace(OLD7, NEW7);
console.log('7. queryHelix Wing IoT db_update banner added');

// ─────────────────────────────────────────────────────────────
// 8. queryHelix ATOMIC — show db_update banner after result
// Use unique 'Error querying ATOMIC' marker
// ─────────────────────────────────────────────────────────────
const OLD8 =
`                    resultDiv.classList.remove('hidden');
                } catch (err) {
                    showToast('Error querying ATOMIC', 'error');`;

const NEW8 =
`                    const adu = result.db_update;
                    if (adu && adu.found) {
                        const adLines = [];
                        if (adu.status_updated) adLines.push('Status: ' + adu.previous_status + ' \u2192 active');
                        if (adu.mdn_updated) adLines.push('MDN: ' + (adu.mdn_old || '(none)') + ' \u2192 ' + adu.mdn_new);
                        if (adu.activated_at_set) adLines.push('Activated at: ' + adu.activated_at_set);
                        if (adLines.length > 0) {
                            document.getElementById('helix-db-update-title').textContent = '\\u26A0 DB Auto-Synced';
                            document.getElementById('helix-db-update-output').textContent = adLines.join('\\\\n');
                            document.getElementById('helix-db-update-banner').classList.remove('hidden');
                        }
                    }
                    resultDiv.classList.remove('hidden');
                } catch (err) {
                    showToast('Error querying ATOMIC', 'error');`;

if (!content.includes(OLD8)) { console.error('PATCH FAILED: OLD8 (queryHelix atomic result) not found'); process.exit(1); }
content = content.replace(OLD8, NEW8);
console.log('8. queryHelix ATOMIC db_update banner added');

// ─────────────────────────────────────────────────────────────
// Write out
// ─────────────────────────────────────────────────────────────
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('\nAll patches applied successfully.');
