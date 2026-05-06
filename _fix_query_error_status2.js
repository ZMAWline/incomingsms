const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// ── 1. Wing IoT — add else after active/activated block ───────────────────────
const WING_OLD = `          db_skip_reason = 'SIM is on plan "' + wingPlan + '" (not dialable). Failed to flag for retry: ' + String(e);
        }
      }
    }
    return new Response(JSON.stringify({
      ok: res.ok,
      status: res.status,
      iccid,
      response: json || text,
      db_update: db_update_wing,
      db_skip_reason: db_skip_reason,
    }, null, 2), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });`;

const WING_NEW = `          db_skip_reason = 'SIM is on plan "' + wingPlan + '" (not dialable). Failed to flag for retry: ' + String(e);
        }
      }
    } else {
      const errMsg = !res.ok
        ? 'Wing query HTTP ' + res.status
        : (!json
            ? 'Wing query: invalid JSON response'
            : 'Wing query: unexpected carrier status "' + wingStatus + '"');
      try {
        await sbPatch(env, 'sims?iccid=eq.' + encodeURIComponent(iccid), {
          status: 'error',
          last_rotation_error: errMsg + ' at ' + new Date().toISOString(),
        });
        db_skip_reason = errMsg;
      } catch (_) {}
    }
    return new Response(JSON.stringify({
      ok: res.ok,
      status: res.status,
      iccid,
      response: json || text,
      db_update: db_update_wing,
      db_skip_reason: db_skip_reason,
    }, null, 2), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });`;

if (!content.includes(WING_OLD)) { console.error('PATCH FAILED: Wing old string not found.'); process.exit(1); }
content = content.replace(WING_OLD, () => WING_NEW);
console.log('Wing patch applied.');

// ── 2. Helix — JSON parse failure ─────────────────────────────────────────────
const HELIX_JSON_OLD = `    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON from Helix', raw: detailsText.slice(0, 500) }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }`;

const HELIX_JSON_NEW = `    } catch {
      await sbPatch(env, 'sims?mobility_subscription_id=eq.' + encodeURIComponent(subId), {
        status: 'error',
        last_rotation_error: 'Helix query: invalid JSON response at ' + new Date().toISOString(),
      }).catch(() => {});
      return new Response(JSON.stringify({ error: 'Invalid JSON from Helix', raw: detailsText.slice(0, 500) }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }`;

if (!content.includes(HELIX_JSON_OLD)) { console.error('PATCH FAILED: Helix JSON old string not found.'); process.exit(1); }
content = content.replace(HELIX_JSON_OLD, () => HELIX_JSON_NEW);
console.log('Helix JSON parse patch applied.');

// ── 3. Helix — non-200 API response ──────────────────────────────────────────
const HELIX_HTTP_OLD = `    if (!detailsRes.ok) {
      return new Response(JSON.stringify({ error: 'Helix API error', status: detailsRes.status, details: detailsData }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }`;

const HELIX_HTTP_NEW = `    if (!detailsRes.ok) {
      await sbPatch(env, 'sims?mobility_subscription_id=eq.' + encodeURIComponent(subId), {
        status: 'error',
        last_rotation_error: 'Helix query HTTP ' + detailsRes.status + ' at ' + new Date().toISOString(),
      }).catch(() => {});
      return new Response(JSON.stringify({ error: 'Helix API error', status: detailsRes.status, details: detailsData }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }`;

if (!content.includes(HELIX_HTTP_OLD)) { console.error('PATCH FAILED: Helix HTTP old string not found.'); process.exit(1); }
content = content.replace(HELIX_HTTP_OLD, () => HELIX_HTTP_NEW);
console.log('Helix HTTP error patch applied.');

// ── 4. Teltik ─────────────────────────────────────────────────────────────────
const TELTIK_OLD = `    let db_update = null;
    if (res.ok && json) {
      const rawMdn = json.msisdn || json.mdn || json.phone_number || '';
      if (rawMdn) {
        db_update = await syncActiveSim(env, iccid, { mdn: rawMdn, activatedAt: null });
      }
    }

    return new Response(JSON.stringify({
      ok: res.ok,
      status: res.status,
      iccid,
      response: json || text,
      db_update,
    }, null, 2), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });`;

const TELTIK_NEW = `    let db_update = null;
    if (res.ok && json) {
      const rawMdn = json.msisdn || json.mdn || json.phone_number || '';
      if (rawMdn) {
        db_update = await syncActiveSim(env, iccid, { mdn: rawMdn, activatedAt: null });
      } else {
        await sbPatch(env, 'sims?iccid=eq.' + encodeURIComponent(iccid), {
          status: 'error',
          last_rotation_error: 'Teltik query: no MDN in response at ' + new Date().toISOString(),
        }).catch(() => {});
      }
    } else {
      const errMsg = !res.ok
        ? 'Teltik query HTTP ' + res.status
        : 'Teltik query: invalid JSON response';
      await sbPatch(env, 'sims?iccid=eq.' + encodeURIComponent(iccid), {
        status: 'error',
        last_rotation_error: errMsg + ' at ' + new Date().toISOString(),
      }).catch(() => {});
    }

    return new Response(JSON.stringify({
      ok: res.ok,
      status: res.status,
      iccid,
      response: json || text,
      db_update,
    }, null, 2), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });`;

if (!content.includes(TELTIK_OLD)) { console.error('PATCH FAILED: Teltik old string not found.'); process.exit(1); }
content = content.replace(TELTIK_OLD, () => TELTIK_NEW);
console.log('Teltik patch applied.');

// ── 5. ATOMIC ─────────────────────────────────────────────────────────────────
const ATOMIC_OLD = `    if (res.ok && wr2 && wr2.statusCode === '00' && wr2.Result && wr2.Result.attStatus === 'Active') {
      if (isIccid) {
        db_update = await syncActiveSim(env, identifier, {
          mdn: wr2.Result.MSISDN || wr2.Result.msisdn || null,
          activatedAt: wr2.Result.activationDate || null,
          zipCode: (wr2.Result.address && wr2.Result.address.zipCode) || null,
        });
      }
    }
    return new Response(JSON.stringify({ ok: true, response: data, db_update }), {`;

const ATOMIC_NEW = `    if (res.ok && wr2 && wr2.statusCode === '00' && wr2.Result && wr2.Result.attStatus === 'Active') {
      if (isIccid) {
        db_update = await syncActiveSim(env, identifier, {
          mdn: wr2.Result.MSISDN || wr2.Result.msisdn || null,
          activatedAt: wr2.Result.activationDate || null,
          zipCode: (wr2.Result.address && wr2.Result.address.zipCode) || null,
        });
      }
    } else if (isIccid) {
      const errMsg = !res.ok
        ? 'ATOMIC query HTTP ' + res.status
        : (wr2 && wr2.statusCode !== '00'
            ? 'ATOMIC statusCode ' + wr2.statusCode + ': ' + (wr2.description || '')
            : 'ATOMIC query: status not Active (got "' + (wr2 && wr2.Result && wr2.Result.attStatus) + '")');
      await sbPatch(env, 'sims?iccid=eq.' + encodeURIComponent(identifier), {
        status: 'error',
        last_rotation_error: errMsg.trim() + ' at ' + new Date().toISOString(),
      }).catch(() => {});
    }
    return new Response(JSON.stringify({ ok: true, response: data, db_update }), {`;

if (!content.includes(ATOMIC_OLD)) { console.error('PATCH FAILED: ATOMIC old string not found.'); process.exit(1); }
content = content.replace(ATOMIC_OLD, () => ATOMIC_NEW);
console.log('ATOMIC patch applied.');

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('All patches written.');
