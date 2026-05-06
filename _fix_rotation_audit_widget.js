// _fix_rotation_audit_widget.js
// Adds Rotation Audit widget to dashboard:
//   - GET /api/rotation-audit          : returns { latest, history }
//   - POST /api/rotation-audit/run     : proxies to details-finalizer reconcile-rotations
//   - HTML widget on SIMs page (compact bar above SIM Status card)
//   - Frontend JS: loadRotationAudit, showRotationAuditBucket, reconcileNow
//   - switchTab hook to load widget when SIMs tab is shown

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// ─────────────────────────────────────────────────────────────────────────────
// 1) Backend routes — insert after the /api/teltik-query handler.
// ─────────────────────────────────────────────────────────────────────────────
const ROUTES_OLD =
  "    if (url.pathname === '/api/teltik-query' && request.method === 'POST') {\n" +
  "      return handleTeltikQuery(request, env, corsHeaders);\n" +
  "    }\n";

const ROUTES_NEW =
  ROUTES_OLD +
  "\n" +
  "    if (url.pathname === '/api/rotation-audit' && request.method === 'GET') {\n" +
  "      return handleRotationAudit(request, env, corsHeaders);\n" +
  "    }\n" +
  "\n" +
  "    if (url.pathname === '/api/rotation-audit/run' && request.method === 'POST') {\n" +
  "      return handleRotationAuditRun(request, env, corsHeaders);\n" +
  "    }\n";

if (!content.includes(ROUTES_OLD)) {
  console.error('PATCH FAILED: ROUTES_OLD not found');
  process.exit(1);
}
if (content.includes("'/api/rotation-audit'")) {
  console.error('SKIP: rotation-audit routes already present — bailing to avoid duplicate insertion');
  process.exit(1);
}
content = content.replace(ROUTES_OLD, ROUTES_NEW);

// ─────────────────────────────────────────────────────────────────────────────
// 2) Backend handlers — insert after supabaseGetAllArray.
// ─────────────────────────────────────────────────────────────────────────────
const HANDLERS_ANCHOR = "async function handleFixSim(request, env, corsHeaders) {";
const HANDLERS_NEW =
  "async function handleRotationAudit(request, env, corsHeaders) {\n" +
  "  try {\n" +
  "    const base = env.SUPABASE_URL + '/rest/v1/';\n" +
  "    const headers = {\n" +
  "      apikey: env.SUPABASE_SERVICE_ROLE_KEY,\n" +
  "      Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,\n" +
  "    };\n" +
  "    const latestRes = await fetch(base + 'rotation_audit?order=run_at.desc&limit=1', { headers });\n" +
  "    const latestArr = latestRes.ok ? await latestRes.json() : [];\n" +
  "    const histRes = await fetch(base + 'rotation_audit?select=id,run_at,ny_date,trigger,bucket_a_count,bucket_b_count,bucket_c_count,duration_ms&order=run_at.desc&limit=7', { headers });\n" +
  "    const history = histRes.ok ? await histRes.json() : [];\n" +
  "    return new Response(JSON.stringify({ latest: latestArr[0] || null, history }), {\n" +
  "      headers: { ...corsHeaders, 'Content-Type': 'application/json' }\n" +
  "    });\n" +
  "  } catch (e) {\n" +
  "    return new Response(JSON.stringify({ error: String(e) }), {\n" +
  "      status: 500,\n" +
  "      headers: { ...corsHeaders, 'Content-Type': 'application/json' }\n" +
  "    });\n" +
  "  }\n" +
  "}\n" +
  "\n" +
  "async function handleRotationAuditRun(request, env, corsHeaders) {\n" +
  "  try {\n" +
  "    if (!env.FINALIZER_RUN_SECRET) {\n" +
  "      return new Response(JSON.stringify({ error: 'FINALIZER_RUN_SECRET not configured on dashboard worker' }), {\n" +
  "        status: 500,\n" +
  "        headers: { ...corsHeaders, 'Content-Type': 'application/json' }\n" +
  "      });\n" +
  "    }\n" +
  "    const url = 'https://details-finalizer.zalmen-531.workers.dev/reconcile-rotations?secret=' + encodeURIComponent(env.FINALIZER_RUN_SECRET) + '&force=1';\n" +
  "    const r = await fetch(url, { method: 'GET' });\n" +
  "    const body = await r.text();\n" +
  "    let parsed = null;\n" +
  "    try { parsed = JSON.parse(body); } catch (_e) {}\n" +
  "    return new Response(JSON.stringify({ ok: r.ok, status: r.status, result: parsed || body }), {\n" +
  "      status: r.ok ? 200 : 500,\n" +
  "      headers: { ...corsHeaders, 'Content-Type': 'application/json' }\n" +
  "    });\n" +
  "  } catch (e) {\n" +
  "    return new Response(JSON.stringify({ error: String(e) }), {\n" +
  "      status: 500,\n" +
  "      headers: { ...corsHeaders, 'Content-Type': 'application/json' }\n" +
  "    });\n" +
  "  }\n" +
  "}\n" +
  "\n" +
  HANDLERS_ANCHOR;

if (!content.includes(HANDLERS_ANCHOR)) {
  console.error('PATCH FAILED: HANDLERS_ANCHOR not found');
  process.exit(1);
}
if (content.includes("async function handleRotationAudit(")) {
  console.error('SKIP: handleRotationAudit already present');
  process.exit(1);
}
content = content.replace(HANDLERS_ANCHOR, HANDLERS_NEW);

// ─────────────────────────────────────────────────────────────────────────────
// 3) HTML widget — insert between sim-action-bar and SIM Status card.
//    The action bar div ends with: </div>\n                <div class="bg-dark-800 rounded-xl border border-dark-600">
//    We anchor on the line that immediately precedes the SIM Status card.
// ─────────────────────────────────────────────────────────────────────────────
const WIDGET_ANCHOR =
  "                </div>\n" +
  "                <div class=\"bg-dark-800 rounded-xl border border-dark-600\">\n" +
  "                    <div class=\"px-5 py-4 border-b border-dark-600\">\n" +
  "                        <div class=\"flex flex-wrap items-center justify-between gap-4\">\n" +
  "                            <div class=\"flex items-center gap-3\">\n" +
  "                                <h2 class=\"text-lg font-semibold text-white\">SIM Status</h2>";

const WIDGET_NEW =
  "                </div>\n" +
  "                <div id=\"rotation-audit-widget\" class=\"hidden mb-4 p-4 bg-dark-800 rounded-xl border border-dark-600 flex flex-wrap items-center gap-4\">\n" +
  "                    <div class=\"flex flex-col min-w-0\">\n" +
  "                        <span class=\"text-sm font-semibold text-white\">Rotation Audit (today)</span>\n" +
  "                        <span id=\"rotation-audit-runat\" class=\"text-xs text-gray-500\">Loading…</span>\n" +
  "                    </div>\n" +
  "                    <div class=\"flex items-center gap-2\">\n" +
  "                        <button id=\"rotation-audit-a\" onclick=\"showRotationAuditBucket('a')\" class=\"px-3 py-1.5 text-xs rounded transition bg-dark-700 text-gray-400\" title=\"Stuck mdn_pending\">A: <span id=\"rotation-audit-a-count\">–</span></button>\n" +
  "                        <button id=\"rotation-audit-b\" onclick=\"showRotationAuditBucket('b')\" class=\"px-3 py-1.5 text-xs rounded transition bg-dark-700 text-gray-400\" title=\"Rotated, not notified\">B: <span id=\"rotation-audit-b-count\">–</span></button>\n" +
  "                        <button id=\"rotation-audit-c\" onclick=\"showRotationAuditBucket('c')\" class=\"px-3 py-1.5 text-xs rounded transition bg-dark-700 text-gray-400\" title=\"Eligible, not attempted in 24h\">C: <span id=\"rotation-audit-c-count\">–</span></button>\n" +
  "                    </div>\n" +
  "                    <button onclick=\"reconcileNow()\" class=\"ml-auto px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded transition\">Reconcile Now</button>\n" +
  "                </div>\n" +
  "                <div class=\"bg-dark-800 rounded-xl border border-dark-600\">\n" +
  "                    <div class=\"px-5 py-4 border-b border-dark-600\">\n" +
  "                        <div class=\"flex flex-wrap items-center justify-between gap-4\">\n" +
  "                            <div class=\"flex items-center gap-3\">\n" +
  "                                <h2 class=\"text-lg font-semibold text-white\">SIM Status</h2>";

if (!content.includes(WIDGET_ANCHOR)) {
  console.error('PATCH FAILED: WIDGET_ANCHOR not found');
  process.exit(1);
}
if (content.includes('id="rotation-audit-widget"')) {
  console.error('SKIP: widget already present');
  process.exit(1);
}
content = content.replace(WIDGET_ANCHOR, WIDGET_NEW);

// ─────────────────────────────────────────────────────────────────────────────
// 4) switchTab hook — add loadRotationAudit() when SIMs tab is shown.
// ─────────────────────────────────────────────────────────────────────────────
const SWITCH_OLD = "            if (tabName === 'sms-usage') loadSmsUsage();\n        }";
const SWITCH_NEW =
  "            if (tabName === 'sms-usage') loadSmsUsage();\n" +
  "            if (tabName === 'sims') loadRotationAudit();\n" +
  "        }";

if (!content.includes(SWITCH_OLD)) {
  console.error('PATCH FAILED: SWITCH_OLD not found');
  process.exit(1);
}
content = content.replace(SWITCH_OLD, SWITCH_NEW);

// ─────────────────────────────────────────────────────────────────────────────
// 5) Frontend JS — add loadRotationAudit, showRotationAuditBucket, reconcileNow
//    just before the loadSims function declaration.
//    Uses ONLY string concatenation (no template literals) so we don't have to
//    deal with backtick/`${` escaping inside the outer getHTML template.
// ─────────────────────────────────────────────────────────────────────────────
const JS_ANCHOR = "        let lastSimsFetchedAt = 0;";
const JS_NEW =
  "        let lastRotationAudit = null;\n" +
  "\n" +
  "        async function loadRotationAudit() {\n" +
  "          try {\n" +
  "            const res = await fetch(API_BASE + '/rotation-audit');\n" +
  "            if (!res.ok) return;\n" +
  "            const payload = await res.json();\n" +
  "            const latest = payload.latest;\n" +
  "            lastRotationAudit = latest;\n" +
  "            const widget = document.getElementById('rotation-audit-widget');\n" +
  "            if (!widget) return;\n" +
  "            if (!latest) {\n" +
  "              widget.classList.add('hidden');\n" +
  "              return;\n" +
  "            }\n" +
  "            widget.classList.remove('hidden');\n" +
  "            document.getElementById('rotation-audit-a-count').textContent = latest.bucket_a_count;\n" +
  "            document.getElementById('rotation-audit-b-count').textContent = latest.bucket_b_count;\n" +
  "            document.getElementById('rotation-audit-c-count').textContent = latest.bucket_c_count;\n" +
  "            const runAt = new Date(latest.run_at);\n" +
  "            document.getElementById('rotation-audit-runat').textContent = 'Last run: ' + runAt.toLocaleString() + ' (' + (latest.trigger || '?') + ')';\n" +
  "            const colorBtn = function(id, count, activeCls) {\n" +
  "              const btn = document.getElementById(id);\n" +
  "              if (!btn) return;\n" +
  "              btn.className = 'px-3 py-1.5 text-xs rounded transition ' + (count > 0 ? activeCls : 'bg-dark-700 text-gray-400');\n" +
  "            };\n" +
  "            colorBtn('rotation-audit-a', latest.bucket_a_count, 'bg-red-600 hover:bg-red-700 text-white');\n" +
  "            colorBtn('rotation-audit-b', latest.bucket_b_count, 'bg-orange-600 hover:bg-orange-700 text-white');\n" +
  "            colorBtn('rotation-audit-c', latest.bucket_c_count, 'bg-gray-600 hover:bg-gray-500 text-white');\n" +
  "          } catch (e) {\n" +
  "            console.error('loadRotationAudit failed:', e);\n" +
  "          }\n" +
  "        }\n" +
  "\n" +
  "        function showRotationAuditBucket(bucket) {\n" +
  "          if (!lastRotationAudit) return;\n" +
  "          const ids = lastRotationAudit['bucket_' + bucket + '_sim_ids'] || [];\n" +
  "          const count = lastRotationAudit['bucket_' + bucket + '_count'] || 0;\n" +
  "          const labels = { a: 'Stuck mdn_pending', b: 'Rotated, not notified', c: 'Eligible, not attempted in 24h' };\n" +
  "          if (count === 0) {\n" +
  "            showToast('Bucket ' + bucket.toUpperCase() + ': empty', 'info');\n" +
  "            return;\n" +
  "          }\n" +
  "          const searchEl = document.getElementById('sims-search');\n" +
  "          if (searchEl) {\n" +
  "            searchEl.value = ids.join(', ');\n" +
  "            searchEl.dispatchEvent(new Event('input'));\n" +
  "            showToast(labels[bucket] + ': ' + count + ' SIMs (filtered in table)', 'info');\n" +
  "          } else {\n" +
  "            showToast(labels[bucket] + ' (' + count + '): ' + ids.join(', '), 'info');\n" +
  "          }\n" +
  "        }\n" +
  "\n" +
  "        async function reconcileNow() {\n" +
  "          const ok = await showConfirm('Reconcile Now?', 'Runs post-rotation reconciliation immediately. Hard caps: ≤60 AT&T GETs, ≤60 webhook POSTs, 0 plan-change PUTs, 90s wall-clock. Bypasses RECONCILIATION_ENABLED flag.');\n" +
  "          if (!ok) return;\n" +
  "          showToast('Running reconciliation…', 'info');\n" +
  "          try {\n" +
  "            const res = await fetch(API_BASE + '/rotation-audit/run', { method: 'POST' });\n" +
  "            const data = await res.json();\n" +
  "            if (data.ok && data.result) {\n" +
  "              const r = data.result;\n" +
  "              showToast('Reconcile done — A=' + (r.bucket_a_count || 0) + ' B=' + (r.bucket_b_count || 0) + ' C=' + (r.bucket_c_count || 0) + ' (' + (r.duration_ms || 0) + 'ms)', 'success');\n" +
  "              await loadRotationAudit();\n" +
  "            } else {\n" +
  "              showToast('Reconcile failed: ' + (data.error || JSON.stringify(data.result || data)), 'error');\n" +
  "            }\n" +
  "          } catch (e) {\n" +
  "            showToast('Reconcile error: ' + e, 'error');\n" +
  "          }\n" +
  "        }\n" +
  "\n" +
  "        " + JS_ANCHOR;

if (!content.includes(JS_ANCHOR)) {
  console.error('PATCH FAILED: JS_ANCHOR not found');
  process.exit(1);
}
if (content.includes('async function loadRotationAudit()')) {
  console.error('SKIP: loadRotationAudit already present');
  process.exit(1);
}
content = content.replace(JS_ANCHOR, JS_NEW);

// Convert back to CRLF
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied successfully (5 sections).');
