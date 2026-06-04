// _fix_bad_rentals_mgmt.js
// INC-3 Phase 1 follow-on: bad-rentals dashboard enhancements.
//   1. handleBadRentals: embed the report's captured sim_numbers row (so the UI
//      gets old-MDN valid_to/valid_from); accept ?status=all to drop the filter.
//   2. handleUpdateBadRental: new endpoint for arbitrary status transitions among
//      the existing rental_reports CHECK enum, with audit-event logging.
//   3. Frontend: status filter dropdown above the table; show "Old MDN retired at X"
//      under stale reported MDNs; Edit button per row → modal that calls /update.
//
// CRLF-preserving patch — see .claude/skills/patch-dashboard.

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// ---------------------------------------------------------------------------
// PATCH 1: replace handleBadRentals body (positional).
// ---------------------------------------------------------------------------
{
  const startMarker = 'async function handleBadRentals(';
  const start = content.indexOf(startMarker);
  if (start === -1) { console.error('handleBadRentals not found'); process.exit(1); }
  const end = content.indexOf('\nasync function ', start + 1);
  if (end === -1) { console.error('end of handleBadRentals not found'); process.exit(1); }

  const NEW_FN =
`async function handleBadRentals(env, corsHeaders, url) {
  try {
    const statusParam = url.searchParams.get('status');
    const includeAll = statusParam === 'all';
    const statusFilter = (statusParam && !includeAll) ? statusParam : 'received,in_triage';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 1000);
    // Embeds:
    //   resellers(name)                       — operator label
    //   rentals(reseller_rental_id)           — reseller's own id when echoed
    //   sims(sim_numbers(...))                — the SIM's CURRENT MDN (valid_to IS NULL)
    //   report_sim_number — via the explicit FK rental_reports_sim_number_id_fkey —
    //     the sim_numbers row CAPTURED at intake. Its valid_to tells the UI
    //     when the reported MDN was retired (= "old number expiration").
    const select = [
      'id', 'reseller_id', 'e164', 'reason_code', 'reason_note', 'status',
      'sim_id', 'sim_number_id', 'rental_id',
      'remediation_action', 'duplicate_of',
      'received_at', 'triaged_at', 'closed_at', 'updated_at',
      'resellers(name)',
      'rentals(reseller_rental_id)',
      'sims(sim_numbers(e164,valid_to))',
      'report_sim_number:sim_numbers!rental_reports_sim_number_id_fkey(e164,valid_from,valid_to)',
    ].join(',');
    let query = 'rental_reports?select=' + encodeURIComponent(select);
    if (!includeAll) {
      query += '&status=in.(' + encodeURIComponent(statusFilter) + ')';
    }
    query += '&sims.sim_numbers.valid_to=is.null'
      + '&order=received_at.desc&limit=' + limit;
    const resp = await supabaseGet(env, query);
    if (!resp.ok) {
      const txt = await resp.text();
      return new Response(JSON.stringify({ error: 'supabase_' + resp.status, detail: txt }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const rows = await resp.json();
    const flat = (Array.isArray(rows) ? rows : []).map(r => {
      const currentE164 = r && r.sims && Array.isArray(r.sims.sim_numbers) && r.sims.sim_numbers[0]
        ? r.sims.sim_numbers[0].e164
        : null;
      const resellerRentalId = r && r.rentals ? r.rentals.reseller_rental_id : null;
      const rsn = r && r.report_sim_number ? r.report_sim_number : null;
      return {
        id: r.id,
        reseller_id: r.reseller_id,
        e164: r.e164,
        reason_code: r.reason_code,
        reason_note: r.reason_note,
        status: r.status,
        sim_id: r.sim_id,
        sim_number_id: r.sim_number_id,
        rental_id: r.rental_id,
        remediation_action: r.remediation_action,
        duplicate_of: r.duplicate_of,
        received_at: r.received_at,
        triaged_at: r.triaged_at,
        closed_at: r.closed_at,
        updated_at: r.updated_at,
        resellers: r.resellers || null,
        reseller_rental_id: resellerRentalId,
        current_e164: currentE164,
        report_sim_number_e164: rsn ? rsn.e164 : null,
        report_sim_number_valid_from: rsn ? rsn.valid_from : null,
        report_sim_number_valid_to: rsn ? rsn.valid_to : null,
      };
    });
    return new Response(JSON.stringify(flat), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

`;

  content = content.slice(0, start) + NEW_FN + content.slice(end + 1);
  console.log('Patch 1: handleBadRentals replaced');
}

// ---------------------------------------------------------------------------
// PATCH 2: insert handleUpdateBadRental after handleResolveBadRental.
// ---------------------------------------------------------------------------
{
  // Locate the start of the *next* function after handleResolveBadRental.
  const startMarker = 'async function handleResolveBadRental(';
  const start = content.indexOf(startMarker);
  if (start === -1) { console.error('handleResolveBadRental not found'); process.exit(1); }
  const end = content.indexOf('\nasync function ', start + 1);
  if (end === -1) { console.error('end of handleResolveBadRental not found'); process.exit(1); }

  // Insert just before the `\n` that precedes the next function.
  const INSERT =
`
// POST /api/bad-rentals/:id/update — operator edit for any rental_reports status
// transition. Validates against the same CHECK enums as the migration and
// writes a rental_report_events audit row for every change. Reopening a closed
// report (terminal → open) clears closed_at and remediation_action/duplicate_of
// so the row stays in a coherent state; the event log preserves the history.
async function handleUpdateBadRental(id, request, env, corsHeaders) {
  try {
    const reportId = parseInt(id, 10);
    if (!Number.isFinite(reportId) || reportId <= 0) {
      return new Response(JSON.stringify({ error: 'invalid report id' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let body = {};
    try { body = await request.json(); } catch (_) { body = {}; }

    const ALLOWED_STATUSES = ['received','in_triage','remediated','unable_to_reproduce','duplicate'];
    const TERMINAL_STATUSES = ['remediated','unable_to_reproduce','duplicate'];
    const ALLOWED_ACTIONS = ['rotated','port_reset','sim_replaced','mdn_swapped','other'];

    const toStatus = body.status ? String(body.status).toLowerCase() : null;
    if (!toStatus || !ALLOWED_STATUSES.includes(toStatus)) {
      return new Response(JSON.stringify({ error: 'status must be one of ' + ALLOWED_STATUSES.join(',') }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const remediationActionRaw = body.remediation_action != null && body.remediation_action !== ''
      ? String(body.remediation_action).toLowerCase()
      : null;
    if (toStatus === 'remediated') {
      if (!remediationActionRaw || !ALLOWED_ACTIONS.includes(remediationActionRaw)) {
        return new Response(JSON.stringify({ error: 'remediation_action required for status=remediated; one of ' + ALLOWED_ACTIONS.join(',') }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    } else if (remediationActionRaw && !ALLOWED_ACTIONS.includes(remediationActionRaw)) {
      return new Response(JSON.stringify({ error: 'remediation_action must be one of ' + ALLOWED_ACTIONS.join(',') }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let duplicateOf = null;
    if (body.duplicate_of != null && body.duplicate_of !== '') {
      const n = parseInt(body.duplicate_of, 10);
      if (!Number.isFinite(n) || n <= 0) {
        return new Response(JSON.stringify({ error: 'duplicate_of must be a positive integer' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (n === reportId) {
        return new Response(JSON.stringify({ error: 'duplicate_of cannot reference the report itself' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      duplicateOf = n;
    }

    const note = body.note ? String(body.note).slice(0, 500) : null;
    const actor = body.actor ? String(body.actor).slice(0, 120) : 'operator';

    const curResp = await supabaseGet(env, 'rental_reports?id=eq.' + reportId + '&select=id,status,triaged_at,closed_at,remediation_action,duplicate_of');
    if (!curResp.ok) {
      const txt = await curResp.text();
      return new Response(JSON.stringify({ error: 'supabase_' + curResp.status, detail: txt }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const curRows = await curResp.json();
    if (!Array.isArray(curRows) || curRows.length === 0) {
      return new Response(JSON.stringify({ error: 'report not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const cur = curRows[0];
    const fromStatus = cur.status;

    const nowIso = new Date().toISOString();
    const patch = { status: toStatus, updated_at: nowIso };

    if (fromStatus === 'received' && toStatus !== 'received' && !cur.triaged_at) {
      patch.triaged_at = nowIso;
    }
    if (TERMINAL_STATUSES.includes(toStatus)) {
      patch.closed_at = cur.closed_at || nowIso;
    } else {
      patch.closed_at = null;
    }

    if (toStatus === 'remediated') {
      patch.remediation_action = remediationActionRaw;
      patch.duplicate_of = null;
    } else if (toStatus === 'duplicate') {
      patch.remediation_action = null;
      patch.duplicate_of = duplicateOf;
    } else {
      patch.remediation_action = null;
      patch.duplicate_of = null;
    }

    const patchResp = await fetch(\`\${env.SUPABASE_URL}/rest/v1/rental_reports?id=eq.\${reportId}\`, {
      method: 'PATCH',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: \`Bearer \${env.SUPABASE_SERVICE_ROLE_KEY}\`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(patch),
    });
    if (!patchResp.ok) {
      const txt = await patchResp.text();
      return new Response(JSON.stringify({ error: 'patch_failed', detail: txt }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const updated = await patchResp.json();

    try {
      const evidence = {};
      if (patch.remediation_action) evidence.remediation_action = patch.remediation_action;
      if (patch.duplicate_of) evidence.duplicate_of = patch.duplicate_of;
      await fetch(\`\${env.SUPABASE_URL}/rest/v1/rental_report_events\`, {
        method: 'POST',
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: \`Bearer \${env.SUPABASE_SERVICE_ROLE_KEY}\`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          report_id: reportId,
          from_status: fromStatus,
          to_status: toStatus,
          actor: actor,
          note: note,
          evidence: Object.keys(evidence).length ? evidence : null,
        }),
      });
    } catch (e) {
      console.log('[UpdateBadRental] event log insert failed: ' + e);
    }

    return new Response(JSON.stringify({ ok: true, report: updated[0] || null }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}
`;

  content = content.slice(0, end) + INSERT + content.slice(end);
  console.log('Patch 2: handleUpdateBadRental inserted');
}

// ---------------------------------------------------------------------------
// PATCH 3: add /update route before /resolve route.
// ---------------------------------------------------------------------------
{
  const OLD =
`    if (url.pathname.startsWith('/api/bad-rentals/') && url.pathname.endsWith('/resolve') && request.method === 'POST') {
      const id = url.pathname.slice('/api/bad-rentals/'.length, -('/resolve'.length));
      return handleResolveBadRental(id, request, env, corsHeaders);
    }`;
  const NEW =
`    if (url.pathname.startsWith('/api/bad-rentals/') && url.pathname.endsWith('/update') && request.method === 'POST') {
      const id = url.pathname.slice('/api/bad-rentals/'.length, -('/update'.length));
      return handleUpdateBadRental(id, request, env, corsHeaders);
    }

    if (url.pathname.startsWith('/api/bad-rentals/') && url.pathname.endsWith('/resolve') && request.method === 'POST') {
      const id = url.pathname.slice('/api/bad-rentals/'.length, -('/resolve'.length));
      return handleResolveBadRental(id, request, env, corsHeaders);
    }`;
  if (!content.includes(OLD)) { console.error('Patch 3: /resolve route not found'); process.exit(1); }
  content = content.replace(OLD, NEW);
  console.log('Patch 3: /update route added');
}

// ---------------------------------------------------------------------------
// PATCH 4: Frontend HTML — add status filter dropdown + edit modal.
// ---------------------------------------------------------------------------
{
  const OLD =
`                <div id="bad-rentals-status" class="text-dark-400 text-sm mb-4"></div>
                <div id="bad-rentals-table-wrap" class="overflow-x-auto rounded-lg border border-dark-600">`;
  const NEW =
`                <div class="flex items-center gap-3 mb-4">
                    <label class="text-xs text-dark-400 uppercase" for="bad-rentals-status-filter">Status</label>
                    <select id="bad-rentals-status-filter" onchange="loadBadRentals()" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300">
                        <option value="received,in_triage" selected>Open (received + in triage)</option>
                        <option value="all">All</option>
                        <option value="received">Received only</option>
                        <option value="in_triage">In triage only</option>
                        <option value="remediated">Remediated</option>
                        <option value="unable_to_reproduce">Unable to reproduce</option>
                        <option value="duplicate">Duplicate</option>
                    </select>
                    <span id="bad-rentals-status" class="text-dark-400 text-sm ml-2"></span>
                </div>
                <div id="bad-rentals-table-wrap" class="overflow-x-auto rounded-lg border border-dark-600">`;
  if (!content.includes(OLD)) { console.error('Patch 4a: status anchor not found'); process.exit(1); }
  content = content.replace(OLD, NEW);
  console.log('Patch 4a: filter dropdown inserted');

  // Insert modal markup after the bad-rentals tab content closing div, before
  // the next "Billing Tab" comment.
  const OLD_M =
`                <p class="text-xs text-dark-500 mt-4">To triage: use existing rotate/port-reset/replace tools. Status updates go in rental_report_events (operator notes coming in Phase 2).</p>
            </div>


            <!-- Billing Tab -->`;
  const NEW_M =
`                <p class="text-xs text-dark-500 mt-4">To triage: use existing rotate/port-reset/replace tools. Edit a row to record a status transition; every change is logged to rental_report_events.</p>
            </div>

            <!-- Bad Rentals — Edit modal -->
            <div id="bad-rentals-edit-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
                <div class="bg-dark-800 border border-dark-600 rounded-xl p-6 w-full max-w-md">
                    <div class="flex items-center justify-between mb-4">
                        <h3 class="text-lg font-semibold text-white">Edit report <span id="bad-rentals-edit-id" class="text-dark-400 font-mono text-sm"></span></h3>
                        <button onclick="closeBadRentalEdit()" class="text-dark-400 hover:text-white text-2xl leading-none">&times;</button>
                    </div>
                    <div id="bad-rentals-edit-summary" class="text-xs text-dark-400 mb-3"></div>
                    <div class="space-y-3">
                        <div>
                            <label class="block text-xs text-dark-400 uppercase mb-1" for="bad-rentals-edit-status">Status</label>
                            <select id="bad-rentals-edit-status" onchange="renderBadRentalEditConditional()" class="w-full text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-200">
                                <option value="received">received</option>
                                <option value="in_triage">in_triage</option>
                                <option value="remediated">remediated</option>
                                <option value="unable_to_reproduce">unable_to_reproduce</option>
                                <option value="duplicate">duplicate</option>
                            </select>
                        </div>
                        <div id="bad-rentals-edit-remediation-wrap" class="hidden">
                            <label class="block text-xs text-dark-400 uppercase mb-1" for="bad-rentals-edit-remediation">Remediation action</label>
                            <select id="bad-rentals-edit-remediation" class="w-full text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-200">
                                <option value="rotated">rotated</option>
                                <option value="port_reset">port_reset</option>
                                <option value="sim_replaced">sim_replaced</option>
                                <option value="mdn_swapped">mdn_swapped</option>
                                <option value="other">other</option>
                            </select>
                        </div>
                        <div id="bad-rentals-edit-duplicate-wrap" class="hidden">
                            <label class="block text-xs text-dark-400 uppercase mb-1" for="bad-rentals-edit-duplicate">Duplicate of (report id)</label>
                            <input id="bad-rentals-edit-duplicate" type="number" min="1" class="w-full text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-200" />
                        </div>
                        <div>
                            <label class="block text-xs text-dark-400 uppercase mb-1" for="bad-rentals-edit-note">Note (logged to event audit, ≤500 chars)</label>
                            <textarea id="bad-rentals-edit-note" rows="3" maxlength="500" class="w-full text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-200"></textarea>
                        </div>
                        <div id="bad-rentals-edit-error" class="hidden text-xs text-red-400"></div>
                    </div>
                    <div class="flex items-center justify-end gap-2 mt-5">
                        <button onclick="closeBadRentalEdit()" class="px-3 py-1.5 text-xs bg-dark-700 hover:bg-dark-600 text-gray-200 rounded">Cancel</button>
                        <button onclick="submitBadRentalEdit()" id="bad-rentals-edit-submit" class="px-4 py-1.5 text-xs bg-accent hover:bg-green-700 text-white rounded">Save</button>
                    </div>
                </div>
            </div>


            <!-- Billing Tab -->`;
  if (!content.includes(OLD_M)) { console.error('Patch 4b: tab close anchor not found'); process.exit(1); }
  content = content.replace(OLD_M, NEW_M);
  console.log('Patch 4b: edit modal markup inserted');
}

// ---------------------------------------------------------------------------
// PATCH 5: Frontend JS — replace loadBadRentals (positional inside template).
// ---------------------------------------------------------------------------
{
  const startMarker = '        async function loadBadRentals() {';
  const start = content.indexOf(startMarker);
  if (start === -1) { console.error('loadBadRentals not found'); process.exit(1); }
  // End at the next `        async function ` or `        function ` at the same indent.
  let searchFrom = start + startMarker.length;
  let end = -1;
  while (true) {
    const a = content.indexOf('\n        async function ', searchFrom);
    const b = content.indexOf('\n        function ', searchFrom);
    let cand;
    if (a === -1) cand = b;
    else if (b === -1) cand = a;
    else cand = Math.min(a, b);
    if (cand === -1) { console.error('end of loadBadRentals not found'); process.exit(1); }
    end = cand;
    break;
  }

  // Helpers for backtick / template-expression characters inside the outer getHTML template.
  const BT = '\\' + '`';   // produces \` in the file
  const DS = '\\' + '${';  // produces \${ in the file (unused — string-concat instead)

  const NEW_JS =
`        async function loadBadRentals() {
            const badge = document.getElementById('bad-rentals-badge');
            const statusEl = document.getElementById('bad-rentals-status');
            const tbody = document.getElementById('bad-rentals-tbody');
            const filterSel = document.getElementById('bad-rentals-status-filter');
            if (!tbody) return;
            tbody.innerHTML = '<tr><td colspan="9" class="px-4 py-8 text-center text-dark-400">Loading&hellip;</td></tr>';
            if (statusEl) statusEl.textContent = '';
            const filterVal = filterSel ? filterSel.value : 'received,in_triage';
            const isOpenFilter = filterVal === 'received,in_triage';
            try {
                const qs = filterVal ? ('?status=' + encodeURIComponent(filterVal)) : '';
                const resp = await fetch(API_BASE + '/bad-rentals' + qs);
                if (!resp.ok) throw new Error('API ' + resp.status);
                const rows = await resp.json();
                window._badRentalRowsById = {};
                if (!Array.isArray(rows) || rows.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="9" class="px-4 py-8 text-center text-dark-400">No reports match this filter.</td></tr>';
                    // Badge tracks open reports only — leave it untouched when viewing
                    // a non-open filter so the sidebar count stays accurate.
                    if (badge && isOpenFilter) { badge.textContent = '0'; badge.classList.add('hidden'); }
                    if (statusEl) statusEl.textContent = '';
                    return;
                }
                if (badge && isOpenFilter) { badge.textContent = rows.length; badge.classList.remove('hidden'); }
                const filterLabel = filterSel && filterSel.options[filterSel.selectedIndex]
                    ? filterSel.options[filterSel.selectedIndex].text
                    : filterVal;
                if (statusEl) statusEl.textContent = rows.length + ' report' + (rows.length === 1 ? '' : 's') + ' · filter: ' + filterLabel;
                const fmtDt = function(s) {
                    return s ? new Date(s).toLocaleString('en-US', {month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}) : '—';
                };
                const STATUS_BADGES = {
                    received:            '<span class="inline-block px-2 py-0.5 text-xs font-medium rounded-full bg-amber-500/20 text-amber-300">Received</span>',
                    in_triage:           '<span class="inline-block px-2 py-0.5 text-xs font-medium rounded-full bg-blue-500/20 text-blue-300">In triage</span>',
                    remediated:          '<span class="inline-block px-2 py-0.5 text-xs font-medium rounded-full bg-emerald-500/20 text-emerald-300">Remediated</span>',
                    unable_to_reproduce: '<span class="inline-block px-2 py-0.5 text-xs font-medium rounded-full bg-slate-500/30 text-slate-200">Unable to reproduce</span>',
                    duplicate:           '<span class="inline-block px-2 py-0.5 text-xs font-medium rounded-full bg-purple-500/20 text-purple-300">Duplicate</span>',
                };
                tbody.innerHTML = rows.map(function(r) {
                    window._badRentalRowsById[r.id] = r;
                    const resellerName = (r.resellers && r.resellers.name) ? r.resellers.name : (r.reseller_id || '—');
                    const statusBadge = STATUS_BADGES[r.status] || ('<span class="inline-block px-2 py-0.5 text-xs font-medium rounded-full bg-dark-700 text-dark-200">' + escapeHtml(r.status || '—') + '</span>');
                    const simLink = r.sim_id
                        ? '<a onclick="event.stopPropagation();goToSimsBySearch(&quot;' + escapeHtml(r.sim_id) + '&quot;)" title="Open SIMs page filtered to this SIM ID" class="text-cyan-300 hover:text-cyan-200 underline decoration-dotted cursor-pointer">' + escapeHtml(r.sim_id) + '</a>'
                        : '—';
                    const reported = r.e164 || null;
                    const current = r.current_e164 || null;
                    const isStale = !!(reported && current && reported !== current);
                    // Old-MDN expiration: when the captured sim_numbers row has a
                    // valid_to set, the reported MDN's lifetime ended at that time.
                    // Surface that under the reported number so the operator can
                    // explain to the reseller why their number stopped working.
                    const retiredAt = r.report_sim_number_valid_to || null;
                    const retiredLine = retiredAt
                        ? '<div class="text-[10px] text-amber-200/80 mt-0.5" title="Reported MDN\\\\'s sim_numbers.valid_to — when the number was retired/rotated">Old MDN retired ' + escapeHtml(fmtDt(retiredAt)) + '</div>'
                        : '';
                    let mdnCell;
                    if (!reported && !current) {
                        mdnCell = '—';
                    } else if (isStale) {
                        mdnCell =
                            '<div class="flex flex-col gap-0.5">' +
                              '<span title="Reported MDN — stale, the SIM has rotated/swapped since this report" class="text-amber-300 line-through decoration-amber-500/60">' + escapeHtml(reported) + '</span>' +
                              retiredLine +
                              '<span title="Current MDN — the SIM\\\\'s active number right now" class="text-emerald-300 font-semibold">' + escapeHtml(current) + ' <span class="text-[10px] uppercase tracking-wide text-emerald-400/80">current</span></span>' +
                            '</div>';
                    } else if (reported && current && reported === current) {
                        mdnCell = '<span title="Reported and current MDN match — SIM has not rotated since report" class="text-dark-200">' + escapeHtml(reported) + '</span>' + retiredLine;
                    } else if (reported) {
                        mdnCell = '<span title="Reported MDN; current MDN unknown (SIM has no active sim_numbers row)" class="text-dark-300">' + escapeHtml(reported) + '</span>' + retiredLine;
                    } else {
                        mdnCell = '<span title="Current MDN; reported MDN missing on report" class="text-emerald-300">' + escapeHtml(current) + '</span>';
                    }
                    let rentalIdCell;
                    if (r.reseller_rental_id) {
                        rentalIdCell = '<span title="Reseller-supplied rental id (rentals.reseller_rental_id)" class="text-dark-200">' + escapeHtml(r.reseller_rental_id) + '</span>';
                    } else if (r.rental_id != null) {
                        rentalIdCell = '<span title="Reseller didn\\\\'t echo a rental id — showing internal rental_id as fallback" class="text-dark-400 italic">#' + escapeHtml(r.rental_id) + '</span>';
                    } else {
                        rentalIdCell = '—';
                    }
                    const isOpen = (r.status === 'received' || r.status === 'in_triage');
                    const editBtn = '<button onclick="event.stopPropagation();openBadRentalEdit(' + escapeHtml(r.id) + ')" class="px-2 py-1 text-xs rounded bg-dark-700 border border-dark-500 text-gray-200 hover:bg-dark-600 transition">Edit</button>';
                    const fixBtn = isOpen
                        ? '<button onclick="event.stopPropagation();markBadRentalFixed(' + escapeHtml(r.id) + ')" class="px-2 py-1 text-xs rounded bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 transition">Mark fixed</button>'
                        : '';
                    const actionCell = '<div class="flex items-center gap-1">' + fixBtn + editBtn + '</div>';
                    return '<tr class="hover:bg-dark-700/40" data-report-id="' + escapeHtml(r.id) + '" data-sim-id="' + escapeHtml(r.sim_id || '') + '" data-reported-e164="' + escapeHtml(reported || '') + '" data-current-e164="' + escapeHtml(current || '') + '">' +
                        '<td class="px-4 py-3 text-dark-300 font-mono text-xs">' + escapeHtml(r.id) + '</td>' +
                        '<td class="px-4 py-3 text-dark-200">' + escapeHtml(resellerName) + '</td>' +
                        '<td class="px-4 py-3 font-mono">' + mdnCell + '</td>' +
                        '<td class="px-4 py-3 text-dark-300 text-xs" title="' + escapeHtml(r.reason_note || '') + '">' + escapeHtml(r.reason_code || '—') + '</td>' +
                        '<td class="px-4 py-3">' + statusBadge + '</td>' +
                        '<td class="px-4 py-3 text-dark-300 font-mono text-xs">' + simLink + '</td>' +
                        '<td class="px-4 py-3 text-dark-300 font-mono text-xs">' + rentalIdCell + '</td>' +
                        '<td class="px-4 py-3 text-dark-400 text-xs">' + escapeHtml(fmtDt(r.received_at)) + '</td>' +
                        '<td class="px-4 py-3">' + actionCell + '</td>' +
                    '</tr>';
                }).join('');
            } catch(e) {
                tbody.innerHTML = '<tr><td colspan="9" class="px-4 py-4 text-center text-red-400">Error loading reports: ' + escapeHtml(e.message) + '</td></tr>';
                console.error('[loadBadRentals]', e);
            }
        }

        function openBadRentalEdit(reportId) {
            const r = (window._badRentalRowsById || {})[reportId];
            if (!r) { alert('Report ' + reportId + ' not in current view; refresh first.'); return; }
            const modal = document.getElementById('bad-rentals-edit-modal');
            if (!modal) return;
            document.getElementById('bad-rentals-edit-id').textContent = '#' + reportId;
            document.getElementById('bad-rentals-edit-status').value = r.status || 'received';
            document.getElementById('bad-rentals-edit-remediation').value = r.remediation_action || 'other';
            document.getElementById('bad-rentals-edit-duplicate').value = r.duplicate_of != null ? String(r.duplicate_of) : '';
            document.getElementById('bad-rentals-edit-note').value = '';
            const err = document.getElementById('bad-rentals-edit-error');
            if (err) { err.classList.add('hidden'); err.textContent = ''; }
            const summary = document.getElementById('bad-rentals-edit-summary');
            if (summary) {
                const reseller = (r.resellers && r.resellers.name) ? r.resellers.name : ('reseller #' + (r.reseller_id || '?'));
                const mdn = r.e164 || '—';
                summary.textContent = reseller + ' · reported ' + mdn + ' · current status: ' + (r.status || '?');
            }
            modal.dataset.reportId = String(reportId);
            modal.classList.remove('hidden');
            renderBadRentalEditConditional();
        }

        function closeBadRentalEdit() {
            const modal = document.getElementById('bad-rentals-edit-modal');
            if (modal) modal.classList.add('hidden');
        }

        function renderBadRentalEditConditional() {
            const status = document.getElementById('bad-rentals-edit-status').value;
            const remWrap = document.getElementById('bad-rentals-edit-remediation-wrap');
            const dupWrap = document.getElementById('bad-rentals-edit-duplicate-wrap');
            if (remWrap) remWrap.classList.toggle('hidden', status !== 'remediated');
            if (dupWrap) dupWrap.classList.toggle('hidden', status !== 'duplicate');
        }

        async function submitBadRentalEdit() {
            const modal = document.getElementById('bad-rentals-edit-modal');
            const reportId = modal ? modal.dataset.reportId : null;
            const errEl = document.getElementById('bad-rentals-edit-error');
            const btn = document.getElementById('bad-rentals-edit-submit');
            const showErr = function(m) { if (errEl) { errEl.textContent = m; errEl.classList.remove('hidden'); } };
            if (!reportId) { showErr('No report id'); return; }
            const status = document.getElementById('bad-rentals-edit-status').value;
            const remediation = document.getElementById('bad-rentals-edit-remediation').value;
            const duplicateOf = document.getElementById('bad-rentals-edit-duplicate').value;
            const note = document.getElementById('bad-rentals-edit-note').value;
            const payload = { status: status, note: note || null };
            if (status === 'remediated') payload.remediation_action = remediation;
            if (status === 'duplicate' && duplicateOf) payload.duplicate_of = duplicateOf;
            if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
            if (errEl) { errEl.classList.add('hidden'); errEl.textContent = ''; }
            try {
                const resp = await fetch(API_BASE + '/bad-rentals/' + encodeURIComponent(reportId) + '/update', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
                const data = await resp.json().catch(function(){ return {}; });
                if (!resp.ok) {
                    showErr((data && data.error) ? data.error : ('HTTP ' + resp.status));
                    return;
                }
                if (typeof showToast === 'function') showToast('Report ' + reportId + ' updated', 'success');
                closeBadRentalEdit();
                if (typeof loadBadRentals === 'function') loadBadRentals();
            } catch(e) {
                showErr('Network error: ' + e.message);
                console.error('[submitBadRentalEdit]', e);
            } finally {
                if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
            }
        }

`;

  content = content.slice(0, start) + NEW_JS + content.slice(end + 1);
  console.log('Patch 5: loadBadRentals replaced + edit helpers added');
}

// ---------------------------------------------------------------------------
// Write back as CRLF.
// ---------------------------------------------------------------------------
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('All patches applied. File size: ' + content.length + ' bytes.');
