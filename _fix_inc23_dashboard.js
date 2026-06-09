// INC-23 / INC-16g — Dashboard surfacing for bad-rental auto-remediation.
// - Backend: enrich /api/bad-rentals with attempt summary; enrich
//   /api/bad-rentals/:id/report with full attempts list.
// - Frontend: Auto attempts sub-row in Bad Rentals list; attempts table,
//   Take over / Resume auto buttons, and escalation link in Report modal.
// - Guide tab: §K decision tree + §F situation tables with row anchors.

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

function replace(oldStr, newStr, label) {
  if (!content.includes(oldStr)) {
    console.error('PATCH FAILED [' + label + ']: old string not found.');
    process.exit(1);
  }
  if (content.indexOf(oldStr) !== content.lastIndexOf(oldStr)) {
    console.error('PATCH FAILED [' + label + ']: old string not unique.');
    process.exit(1);
  }
  content = content.replace(oldStr, newStr);
  console.log('OK   [' + label + ']');
}

/* ===========================================================
 * 1. handleBadRentals — fetch attempt summary per report and
 *    surface (count, last action, last outcome, last attempted_at).
 * =========================================================== */

const OLD_HBR_MAP = `    const rows = await resp.json();
    const flat = (Array.isArray(rows) ? rows : []).map(r => {`;

const NEW_HBR_MAP = `    const rows = await resp.json();
    // INC-23 — pull a compact attempts summary per report so the Bad Rentals
    // list can show "Auto attempts: N (last: <action> <outcome>)".
    const reportIds = (Array.isArray(rows) ? rows : []).map(r => r && r.id).filter(x => x != null);
    const attemptSummary = {};
    if (reportIds.length > 0) {
      try {
        const idIn = encodeURIComponent('(' + reportIds.join(',') + ')');
        const aResp = await supabaseGet(env,
          'rental_report_remediation_attempts?report_id=in.' + idIn
          + '&select=report_id,action,outcome,attempted_at,attempt_no,mode'
          + '&order=attempted_at.desc&limit=2000');
        if (aResp.ok) {
          const attempts = await aResp.json();
          if (Array.isArray(attempts)) {
            for (const a of attempts) {
              const k = a.report_id;
              if (!attemptSummary[k]) {
                attemptSummary[k] = {
                  count: 0,
                  last_action: a.action || null,
                  last_outcome: a.outcome || null,
                  last_attempted_at: a.attempted_at || null,
                  last_mode: a.mode || null,
                };
              }
              attemptSummary[k].count += 1;
            }
          }
        }
      } catch (e) {
        console.log('[handleBadRentals] attempts summary fetch failed: ' + e);
      }
    }
    const flat = (Array.isArray(rows) ? rows : []).map(r => {
      const s = attemptSummary[r.id] || null;`;

replace(OLD_HBR_MAP, NEW_HBR_MAP, 'handleBadRentals: attempt summary fetch');

const OLD_HBR_RET = `        auto_remediation_state: r.auto_remediation_state || null,
        last_auto_attempt_at: r.last_auto_attempt_at || null,
        escalation_reason: r.escalation_reason || null,
        resellers: r.resellers || null,`;

const NEW_HBR_RET = `        auto_remediation_state: r.auto_remediation_state || null,
        last_auto_attempt_at: r.last_auto_attempt_at || null,
        escalation_reason: r.escalation_reason || null,
        auto_attempts_count: s ? s.count : 0,
        auto_attempts_last_action: s ? s.last_action : null,
        auto_attempts_last_outcome: s ? s.last_outcome : null,
        auto_attempts_last_attempted_at: s ? s.last_attempted_at : null,
        auto_attempts_last_mode: s ? s.last_mode : null,
        resellers: r.resellers || null,`;

replace(OLD_HBR_RET, NEW_HBR_RET, 'handleBadRentals: return shape');

/* ===========================================================
 * 2. handleBadRentalReport — include full attempts list and any
 *    escalation issue link surfaced via events.evidence.
 * =========================================================== */

const OLD_REP_RET = `    const hasRawPayload = report && report.raw_payload != null;
    const storageNote = hasRawPayload ? null
      : 'Raw HTTP webhook body was not captured for this report (received before the 2026-06-04 diagnostics migration). The parsed report columns and audit timeline below are the most complete record available.';

    return new Response(JSON.stringify({ report, events, storage_note: storageNote }), {`;

const NEW_REP_RET = `    const hasRawPayload = report && report.raw_payload != null;
    const storageNote = hasRawPayload ? null
      : 'Raw HTTP webhook body was not captured for this report (received before the 2026-06-04 diagnostics migration). The parsed report columns and audit timeline below are the most complete record available.';

    // INC-23 — auto-remediation attempts table (one row per attempted action).
    let attempts = [];
    try {
      const aResp = await supabaseGet(env,
        'rental_report_remediation_attempts?report_id=eq.' + reportId
        + '&select=id,attempt_no,mode,action,attempted_at,outcome,evidence,error_message,next_review_at'
        + '&order=attempted_at.desc&limit=200');
      if (aResp.ok) {
        const j = await aResp.json();
        if (Array.isArray(j)) attempts = j;
      }
    } catch (e) {
      console.log('[handleBadRentalReport] attempts fetch failed: ' + e);
    }

    // INC-23 — surface a Paperclip escalation link if any event evidence carries it.
    // Wired forward-compatibly: INC-16f will populate one of these keys.
    let escalation = null;
    try {
      for (const ev of events) {
        const ev_e = ev && ev.evidence;
        if (!ev_e || typeof ev_e !== 'object') continue;
        const url = ev_e.escalation_issue_url || ev_e.paperclip_issue_url || null;
        const issueId = ev_e.escalation_issue_id || ev_e.paperclip_issue_id || null;
        if (url || issueId) {
          escalation = {
            url: url || null,
            issue_id: issueId || null,
            reason: ev_e.escalation_reason || report.escalation_reason || null,
            event_at: ev.created_at || null,
          };
          break;
        }
      }
      if (!escalation && report.escalation_reason) {
        escalation = { url: null, issue_id: null, reason: report.escalation_reason, event_at: null };
      }
    } catch (_) { /* tolerate any shape */ }

    return new Response(JSON.stringify({ report, events, attempts, escalation, storage_note: storageNote }), {`;

replace(OLD_REP_RET, NEW_REP_RET, 'handleBadRentalReport: attempts+escalation');

// Also extend the report select to include escalation_reason and auto state cols
// so the modal can show them even if no events carry the link.
const OLD_REP_SELECT = `    const reportSelect = [
      'id','reseller_id','rental_id','sim_id','sim_number_id','e164',
      'reason_code','reason_note','attempts','first_attempt_at','client_request_id',
      'status','remediation_action','duplicate_of',
      'received_at','triaged_at','closed_at','updated_at',
      'raw_payload','source',
      'resellers(name)',
      'rentals(reseller_rental_id)',
    ].join(',');`;

const NEW_REP_SELECT = `    const reportSelect = [
      'id','reseller_id','rental_id','sim_id','sim_number_id','e164',
      'reason_code','reason_note','attempts','first_attempt_at','client_request_id',
      'status','remediation_action','duplicate_of',
      'received_at','triaged_at','closed_at','updated_at',
      'raw_payload','source',
      'auto_remediation_state','last_auto_attempt_at','escalation_reason',
      'resellers(name)',
      'rentals(reseller_rental_id)',
    ].join(',');`;

replace(OLD_REP_SELECT, NEW_REP_SELECT, 'handleBadRentalReport: select cols');

/* ===========================================================
 * 3. Frontend — Bad Rentals row: append an "Auto attempts" sub-row.
 *    The main row currently ends with `</tr>`; insert a second <tr>
 *    when auto_attempts_count > 0 OR auto_remediation_state is set.
 * =========================================================== */

const OLD_ROW_RETURN = `                    return '<tr class="hover:bg-dark-700/40" data-report-id="' + escapeHtml(r.id) + '" data-sim-id="' + escapeHtml(r.sim_id || '') + '" data-reported-e164="' + escapeHtml(reported || '') + '" data-current-e164="' + escapeHtml(current || '') + '">' +
                        '<td class="px-4 py-3 font-mono text-xs"><a onclick="event.stopPropagation();openBadRentalReport(' + escapeHtml(r.id) + ')" title="Show the report payload the reseller submitted" class="text-cyan-300 hover:text-cyan-200 underline decoration-dotted cursor-pointer">' + escapeHtml(r.id) + '</a></td>' +
                        '<td class="px-4 py-3 text-dark-200">' + escapeHtml(resellerName) + '</td>' +
                        '<td class="px-4 py-3 font-mono">' + mdnCell + '</td>' +
                        '<td class="px-4 py-3 text-dark-300 text-xs" title="' + escapeHtml(r.reason_note || '') + '">' + escapeHtml(r.reason_code || '—') + '</td>' +
                        '<td class="px-4 py-3">' + statusBadge + '</td>' +
                        '<td class="px-4 py-3 text-dark-300 font-mono text-xs">' + simLink + '</td>' +
                        '<td class="px-4 py-3 text-dark-300 font-mono text-xs">' + rentalIdCell + '</td>' +
                        '<td class="px-4 py-3 text-dark-400 text-xs">' + escapeHtml(fmtDt(r.received_at)) + '</td>' +
                        '<td class="px-4 py-3">' + actionCell + '</td>' +
                    '</tr>';
                }).join('');`;

const NEW_ROW_RETURN = `                    // INC-23 — auto-remediation sub-row.
                    const autoState = r.auto_remediation_state || null;
                    const autoCount = r.auto_attempts_count || 0;
                    const autoLastAction  = r.auto_attempts_last_action  || null;
                    const autoLastOutcome = r.auto_attempts_last_outcome || null;
                    const autoLastAt      = r.auto_attempts_last_attempted_at || r.last_auto_attempt_at || null;
                    const autoLastMode    = r.auto_attempts_last_mode || null;
                    let autoSubRow = '';
                    if (autoCount > 0 || autoState) {
                        const stateBadgeColor = (function(){
                            switch (autoState) {
                                case 'operator_locked': return 'bg-amber-500/20 text-amber-200';
                                case 'escalated':       return 'bg-rose-500/20 text-rose-200';
                                case 'verify_pending':  return 'bg-sky-500/20 text-sky-200';
                                case 'paused':          return 'bg-slate-500/20 text-slate-200';
                                case 'in_progress':     return 'bg-blue-500/20 text-blue-200';
                                case 'done':            return 'bg-emerald-500/20 text-emerald-200';
                                default:                return 'bg-dark-700 text-dark-200';
                            }
                        })();
                        const stateChip = autoState
                            ? '<span class="inline-block px-1.5 py-0.5 text-[10px] font-medium rounded ' + stateBadgeColor + '" title="auto_remediation_state">' + escapeHtml(autoState) + '</span>'
                            : '';
                        const lastTxt = autoCount > 0
                            ? 'last: ' + escapeHtml(autoLastAction || '?') + ' → ' + escapeHtml(autoLastOutcome || '?')
                                + (autoLastMode ? ' (' + escapeHtml(autoLastMode) + ')' : '')
                                + (autoLastAt ? ' · ' + escapeHtml(fmtDt(autoLastAt)) : '')
                            : 'no attempts yet';
                        autoSubRow = '<tr class="bg-dark-900/40 border-t-0" data-auto-sub-for="' + escapeHtml(r.id) + '">'
                            + '<td></td>'
                            + '<td colspan="8" class="px-4 py-1.5 text-[11px] text-dark-300">'
                            +   '<span class="text-dark-400 uppercase tracking-wide mr-2">Auto attempts:</span>'
                            +   '<span class="font-mono text-dark-200 mr-2">' + escapeHtml(String(autoCount)) + '</span>'
                            +   stateChip
                            +   '<span class="ml-2">' + lastTxt + '</span>'
                            + '</td>'
                            + '</tr>';
                    }
                    return '<tr class="hover:bg-dark-700/40" data-report-id="' + escapeHtml(r.id) + '" data-sim-id="' + escapeHtml(r.sim_id || '') + '" data-reported-e164="' + escapeHtml(reported || '') + '" data-current-e164="' + escapeHtml(current || '') + '">' +
                        '<td class="px-4 py-3 font-mono text-xs"><a onclick="event.stopPropagation();openBadRentalReport(' + escapeHtml(r.id) + ')" title="Show the report payload the reseller submitted" class="text-cyan-300 hover:text-cyan-200 underline decoration-dotted cursor-pointer">' + escapeHtml(r.id) + '</a></td>' +
                        '<td class="px-4 py-3 text-dark-200">' + escapeHtml(resellerName) + '</td>' +
                        '<td class="px-4 py-3 font-mono">' + mdnCell + '</td>' +
                        '<td class="px-4 py-3 text-dark-300 text-xs" title="' + escapeHtml(r.reason_note || '') + '">' + escapeHtml(r.reason_code || '—') + '</td>' +
                        '<td class="px-4 py-3">' + statusBadge + '</td>' +
                        '<td class="px-4 py-3 text-dark-300 font-mono text-xs">' + simLink + '</td>' +
                        '<td class="px-4 py-3 text-dark-300 font-mono text-xs">' + rentalIdCell + '</td>' +
                        '<td class="px-4 py-3 text-dark-400 text-xs">' + escapeHtml(fmtDt(r.received_at)) + '</td>' +
                        '<td class="px-4 py-3">' + actionCell + '</td>' +
                    '</tr>' + autoSubRow;
                }).join('');`;

replace(OLD_ROW_RETURN, NEW_ROW_RETURN, 'Bad Rentals row: Auto attempts sub-row');

/* ===========================================================
 * 4. Report modal: replace renderBadRentalReportBody to include
 *    attempts table, escalation link, and Take over/Resume auto buttons.
 * =========================================================== */

const OLD_RENDER_TAIL = `            return ''
                + legacyBanner
                + '<div class="mb-4">'
                +   '<div class="text-[10px] uppercase tracking-wide font-semibold text-dark-300 mb-2">Parsed report fields</div>'
                +   fieldsHtml
                + '</div>'
                + '<div class="mb-4">'
                +   '<div class="text-[10px] uppercase tracking-wide font-semibold text-dark-300 mb-2">Audit timeline (rental_report_events)</div>'
                +   eventsHtml
                + '</div>'
                + rawPayloadBlock
                + '<details class="mt-2">'
                +   '<summary class="cursor-pointer text-[10px] uppercase tracking-wide text-dark-400 hover:text-dark-200">Raw row JSON (parsed columns)</summary>'
                +   '<pre class="mt-2 p-3 bg-dark-900 border border-dark-700 rounded text-[10px] text-dark-300 overflow-x-auto">' + escapeHtml(rawJson) + '</pre>'
                + '</details>';
        }`;

const NEW_RENDER_TAIL = `            // INC-23 — Auto-remediation attempts table.
            const attempts = (data && Array.isArray(data.attempts)) ? data.attempts : [];
            let attemptsHtml;
            if (!attempts.length) {
                attemptsHtml = '<div class="text-dark-500">No auto-remediation attempts recorded.</div>';
            } else {
                attemptsHtml = '<div class="overflow-x-auto rounded border border-dark-700">'
                    + '<table class="w-full text-[11px]">'
                    +   '<thead class="bg-dark-900 text-dark-400 uppercase tracking-wide text-[10px]">'
                    +     '<tr>'
                    +       '<th class="px-2 py-1.5 text-left">#</th>'
                    +       '<th class="px-2 py-1.5 text-left">Mode</th>'
                    +       '<th class="px-2 py-1.5 text-left">Action</th>'
                    +       '<th class="px-2 py-1.5 text-left">Outcome</th>'
                    +       '<th class="px-2 py-1.5 text-left">Attempted at</th>'
                    +       '<th class="px-2 py-1.5 text-left">Next review</th>'
                    +       '<th class="px-2 py-1.5 text-left">Error</th>'
                    +     '</tr>'
                    +   '</thead>'
                    +   '<tbody class="divide-y divide-dark-700">';
                for (let i = 0; i < attempts.length; i++) {
                    const a = attempts[i];
                    const outcomeColor = (function(o){
                        switch (o) {
                            case 'success':          return 'text-emerald-300';
                            case 'failed':           return 'text-rose-300';
                            case 'no_change':        return 'text-dark-300';
                            case 'skipped_cooldown': return 'text-amber-300';
                            case 'verify_pending':   return 'text-sky-300';
                            default:                 return 'text-dark-200';
                        }
                    })(a.outcome);
                    const modeAnchor = a.mode
                        ? '<a href="#auto-rem-' + escapeHtml(a.mode) + '" data-auto-rem-jump="' + escapeHtml(a.mode) + '" class="text-cyan-300 hover:text-cyan-200 underline decoration-dotted cursor-pointer">' + escapeHtml(a.mode) + '</a>'
                        : '—';
                    let evidenceTip = '';
                    if (a.evidence && typeof a.evidence === 'object') {
                        try { evidenceTip = JSON.stringify(a.evidence); } catch(_) { evidenceTip = ''; }
                    }
                    const actionCell = '<span title="' + escapeHtml(evidenceTip) + '">' + escapeHtml(a.action || '—') + '</span>';
                    attemptsHtml += '<tr class="hover:bg-dark-700/30">'
                        + '<td class="px-2 py-1.5 font-mono text-dark-400">' + escapeHtml(String(a.attempt_no != null ? a.attempt_no : '—')) + '</td>'
                        + '<td class="px-2 py-1.5 font-mono text-dark-200">' + modeAnchor + '</td>'
                        + '<td class="px-2 py-1.5 text-dark-100">' + actionCell + '</td>'
                        + '<td class="px-2 py-1.5 font-semibold ' + outcomeColor + '">' + escapeHtml(a.outcome || '—') + '</td>'
                        + '<td class="px-2 py-1.5 text-dark-300">' + escapeHtml(fmt(a.attempted_at)) + '</td>'
                        + '<td class="px-2 py-1.5 text-dark-400">' + (a.next_review_at ? escapeHtml(fmt(a.next_review_at)) : '<span class="text-dark-600">—</span>') + '</td>'
                        + '<td class="px-2 py-1.5 text-rose-300/90">' + (a.error_message ? escapeHtml(String(a.error_message).slice(0, 200)) : '<span class="text-dark-600">—</span>') + '</td>'
                        + '</tr>';
                }
                attemptsHtml += '</tbody></table></div>';
            }

            // INC-23 — Auto-remediation state + Take over / Resume auto controls.
            const autoState = r.auto_remediation_state || null;
            const autoLast  = r.last_auto_attempt_at
                ? fmt(r.last_auto_attempt_at)
                : 'never';
            const stateChipColor = (function(s){
                switch (s) {
                    case 'operator_locked': return 'bg-amber-500/20 text-amber-200';
                    case 'escalated':       return 'bg-rose-500/20 text-rose-200';
                    case 'verify_pending':  return 'bg-sky-500/20 text-sky-200';
                    case 'paused':          return 'bg-slate-500/20 text-slate-200';
                    case 'in_progress':     return 'bg-blue-500/20 text-blue-200';
                    case 'done':            return 'bg-emerald-500/20 text-emerald-200';
                    default:                return 'bg-dark-700 text-dark-200';
                }
            })(autoState);
            const stateChip = autoState
                ? '<span class="inline-block px-2 py-0.5 text-[10px] font-medium rounded ' + stateChipColor + '">' + escapeHtml(autoState) + '</span>'
                : '<span class="text-dark-500 text-[10px]">no state</span>';
            const reportIdAttr = escapeHtml(String(r.id || ''));
            const takeOverBtn = autoState !== 'operator_locked'
                ? '<button onclick="badRentalsReportTakeOver(' + reportIdAttr + ')" class="px-2.5 py-1 text-[11px] bg-amber-600 hover:bg-amber-500 text-white rounded" title="Set auto_remediation_state=operator_locked">Take over</button>'
                : '';
            const resumeBtn = autoState === 'operator_locked'
                ? '<button onclick="badRentalsReportResumeAuto(' + reportIdAttr + ')" class="px-2.5 py-1 text-[11px] bg-dark-700 hover:bg-dark-600 text-gray-200 rounded" title="Clear operator_locked so auto-remediation resumes">Resume auto</button>'
                : '';
            const autoControls = '<div class="flex items-center gap-3 flex-wrap">'
                + '<div class="text-[11px] text-dark-300">'
                +   '<span class="text-dark-400 uppercase tracking-wide mr-1">state:</span>' + stateChip
                +   '<span class="ml-3 text-dark-400 uppercase tracking-wide">last attempt:</span> <span class="text-dark-200">' + escapeHtml(autoLast) + '</span>'
                + '</div>'
                + '<div class="flex items-center gap-2">' + takeOverBtn + resumeBtn + '</div>'
                + '<div id="bad-rentals-report-auto-error" class="hidden text-[11px] text-rose-300"></div>'
                + '</div>';

            // INC-23 — Escalation link (Paperclip child issue) when one exists.
            const escalation = data && data.escalation ? data.escalation : null;
            let escalationBlock = '';
            if (escalation) {
                const url = escalation.url || null;
                const idTxt = escalation.issue_id ? String(escalation.issue_id) : null;
                const reason = escalation.reason || null;
                const link = url
                    ? '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer" class="text-rose-200 hover:text-rose-100 underline">' + escapeHtml(idTxt || url) + '</a>'
                    : (idTxt ? '<span class="text-rose-200 font-mono">' + escapeHtml(idTxt) + '</span>' : '<span class="text-dark-400">no link captured</span>');
                escalationBlock = '<div class="mb-4 p-3 rounded border border-rose-500/40 bg-rose-500/10">'
                    + '<div class="text-[10px] uppercase tracking-wide font-semibold text-rose-200 mb-1">Operator escalation</div>'
                    + '<div class="text-xs text-rose-100">'
                    +   (reason ? '<span class="font-semibold">' + escapeHtml(reason) + '</span> · ' : '')
                    +   'issue: ' + link
                    + '</div>'
                    + '</div>';
            }

            return ''
                + legacyBanner
                + escalationBlock
                + '<div class="mb-4 p-3 rounded border border-dark-700 bg-dark-900/40">'
                +   '<div class="text-[10px] uppercase tracking-wide font-semibold text-dark-300 mb-2">Auto-remediation</div>'
                +   autoControls
                + '</div>'
                + '<div class="mb-4">'
                +   '<div class="text-[10px] uppercase tracking-wide font-semibold text-dark-300 mb-2">Auto-remediation attempts (rental_report_remediation_attempts)</div>'
                +   attemptsHtml
                + '</div>'
                + '<div class="mb-4">'
                +   '<div class="text-[10px] uppercase tracking-wide font-semibold text-dark-300 mb-2">Parsed report fields</div>'
                +   fieldsHtml
                + '</div>'
                + '<div class="mb-4">'
                +   '<div class="text-[10px] uppercase tracking-wide font-semibold text-dark-300 mb-2">Audit timeline (rental_report_events)</div>'
                +   eventsHtml
                + '</div>'
                + rawPayloadBlock
                + '<details class="mt-2">'
                +   '<summary class="cursor-pointer text-[10px] uppercase tracking-wide text-dark-400 hover:text-dark-200">Raw row JSON (parsed columns)</summary>'
                +   '<pre class="mt-2 p-3 bg-dark-900 border border-dark-700 rounded text-[10px] text-dark-300 overflow-x-auto">' + escapeHtml(rawJson) + '</pre>'
                + '</details>';
        }

        // INC-23 — Take over / Resume auto from the report modal (mirrors the
        // edit-modal handlers but operates on a passed-in reportId).
        async function badRentalsReportTakeOver(reportId)   { return badRentalsReportAutoLockCall(reportId, 'pause-auto',  'Take over'); }
        async function badRentalsReportResumeAuto(reportId) { return badRentalsReportAutoLockCall(reportId, 'resume-auto', 'Resume auto'); }
        async function badRentalsReportAutoLockCall(reportId, suffix, label) {
            const errEl = document.getElementById('bad-rentals-report-auto-error');
            if (errEl) { errEl.classList.add('hidden'); errEl.textContent = ''; }
            try {
                const resp = await fetch(API_BASE + '/bad-rentals/' + encodeURIComponent(reportId) + '/' + suffix, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({}),
                });
                const data = await resp.json().catch(function(){ return {}; });
                if (!resp.ok) {
                    if (errEl) { errEl.textContent = (data && data.error) ? data.error : ('HTTP ' + resp.status); errEl.classList.remove('hidden'); }
                    return;
                }
                if (typeof showToast === 'function') showToast(label + ' applied to report ' + reportId, 'success');
                // Re-render the modal body with fresh state.
                if (typeof openBadRentalReport === 'function') openBadRentalReport(reportId);
                if (typeof loadBadRentals === 'function') loadBadRentals();
            } catch(e) {
                if (errEl) { errEl.textContent = 'Network error: ' + e.message; errEl.classList.remove('hidden'); }
                console.error('[badRentalsReportAutoLockCall]', e);
            }
        }

        // INC-23 — Delegated click handler for attempts-table mode anchors
        // (registered once; idempotent across re-renders).
        if (!window._autoRemJumpHandlerInstalled) {
            window._autoRemJumpHandlerInstalled = true;
            document.addEventListener('click', function(ev) {
                const t = ev.target && ev.target.closest ? ev.target.closest('[data-auto-rem-jump]') : null;
                if (!t) return;
                ev.preventDefault();
                const mode = t.getAttribute('data-auto-rem-jump');
                if (mode) gotoAutoRemSituation(mode);
            });
        }

        // INC-23 — Click a §K decision tree node or an attempts-row mode → jump
        // to the matching situation row in the Guide tab's §F tables.
        function gotoAutoRemSituation(mode) {
            try {
                if (typeof switchTab === 'function') switchTab('guide');
                // Close any open Bad Rentals modal first so the scroll lands on Guide.
                if (typeof closeBadRentalReport === 'function') closeBadRentalReport();
                setTimeout(function(){
                    const el = document.getElementById('auto-rem-' + mode);
                    if (el && el.scrollIntoView) {
                        el.scrollIntoView({behavior:'smooth', block:'center'});
                        el.classList.add('ring-2','ring-amber-400');
                        setTimeout(function(){ el.classList.remove('ring-2','ring-amber-400'); }, 2500);
                    }
                }, 100);
            } catch(e) { console.error('gotoAutoRemSituation failed', e); }
        }`;

replace(OLD_RENDER_TAIL, NEW_RENDER_TAIL, 'renderBadRentalReportBody + helpers');

/* ===========================================================
 * 5. Guide tab — TOC entry + decision tree + §F situation tables.
 *    Inserted just before the closing </div> of #tab-guide.
 * =========================================================== */

const OLD_TOC = `                        <a href="#" onclick="event.preventDefault();document.getElementById('guide-auto-imei-att').scrollIntoView({behavior:'smooth'})" class="text-accent hover:underline">Auto IMEI Change (AT&amp;T)</a>`;
const NEW_TOC = `                        <a href="#" onclick="event.preventDefault();document.getElementById('guide-auto-imei-att').scrollIntoView({behavior:'smooth'})" class="text-accent hover:underline">Auto IMEI Change (AT&amp;T)</a>
                        <a href="#" onclick="event.preventDefault();document.getElementById('guide-bad-rental-auto-remediation').scrollIntoView({behavior:'smooth'})" class="text-accent hover:underline">Bad-Rental Auto-Remediation (§K + §F)</a>`;

replace(OLD_TOC, NEW_TOC, 'Guide TOC entry');

// Guide section: §K decision tree + §F vendor tables, anchored per situation
// id (auto-rem-A1, auto-rem-W7, …). Inserted right before the tab-guide
// closing </div>. We locate the unique block "guide-auto-imei-att" → its end.
const OLD_GUIDE_TAIL = `                    </div>
                </div>

            </div>

            <div id="tab-api-tester" class="tab-content hidden">`;

const GUIDE_BLOCK = `                    </div>
                </div>

                <div id="guide-bad-rental-auto-remediation" class="bg-dark-800 rounded-xl p-5 border border-dark-600 mb-6">
                    <h3 class="text-lg font-semibold text-white mb-3">Bad-Rental Auto-Remediation (§K decision tree + §F vendor playbooks)</h3>
                    <p class="text-sm text-gray-400 mb-4">Driven by the <code class="text-accent">bad-rental-remediator</code> worker (cron 0 */2 * * *). Click any node to jump to the matching situation row. From the Bad Rentals report modal, attempt rows link back into this guide.</p>

                    <div class="text-xs text-gray-300 space-y-3 mb-5">
                        <p class="text-white font-medium">Decision tree (§K)</p>
                        <div class="rounded-lg border border-dark-600 bg-dark-900/60 p-4 overflow-x-auto">
                            <pre class="text-[12px] leading-snug text-dark-100 whitespace-pre">2h cron tick
   |
   v
[intake] resolve id, gather evidence, decide vendor
   |
   v
[§B] IMEI correctness check
   +-- wrong type -----------------> escalate imei_wrong_type
   +-- ok
        |
        v
[§E] cancel-guard (vendor cancelled/deactivated)
   +-- active rental remains -----> escalate vendor_cancelled_active_rental
   +-- no active rental ----------> close duplicate
   +-- (didn’t fire)
        |
        v
[shared situations] S1..S6
        |
        v
[branch on sims.vendor]</pre>
                            <div class="grid grid-cols-1 md:grid-cols-4 gap-2 mt-3 text-[12px]">
                                <button onclick="gotoAutoRemSituation('A1')" class="text-left px-3 py-2 rounded border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 text-amber-100">Atomic (AT&amp;T) → A1–A10</button>
                                <button onclick="gotoAutoRemSituation('W1')" class="text-left px-3 py-2 rounded border border-sky-500/40 bg-sky-500/10 hover:bg-sky-500/20 text-sky-100">Wing IoT → W1–W9</button>
                                <button onclick="gotoAutoRemSituation('H1')" class="text-left px-3 py-2 rounded border border-fuchsia-500/40 bg-fuchsia-500/10 hover:bg-fuchsia-500/20 text-fuchsia-100">Helix (T-Mobile) → H1–H9</button>
                                <button onclick="gotoAutoRemSituation('T1')" class="text-left px-3 py-2 rounded border border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-100">Teltik → T1–T11</button>
                            </div>
                            <pre class="text-[12px] leading-snug text-dark-100 whitespace-pre mt-3">[apply auto_action] per situation (if cooldown allows)
   |
   v
[re-query vendor] §C.4 conditions 1,2,3 satisfied?
   +-- no  -----> record outcome, escalate per situation
   +-- yes
        |
        v
[§C.1] send unique SMS
   +-- send fail -> §C.2 retry up to 3x60s
   |                +-- all fail -> escalate verify_send_failed
   +-- send ok
        |
        v
set verify_pending; schedule §C.3 poll
        |
        v
[§C.3] inbound_sms match within 5 min?
   +-- no  -----> escalate verify_receive_timeout
   +-- yes -----> [§D] notify-reseller (resend webhook + status update) -> remediated</pre>
                        </div>
                    </div>

                    <p class="text-white font-medium text-sm mb-2">Shared situations S1–S6</p>
                    <div class="overflow-x-auto mb-5">
                        <table class="w-full text-[12px]">
                            <thead class="bg-dark-900 text-dark-400 uppercase tracking-wide text-[10px]">
                                <tr>
                                    <th class="px-2 py-1.5 text-left">#</th>
                                    <th class="px-2 py-1.5 text-left">Situation</th>
                                    <th class="px-2 py-1.5 text-left">Auto action</th>
                                </tr>
                            </thead>
                            <tbody class="divide-y divide-dark-700 text-dark-200">
                                <tr id="auto-rem-S1" class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-amber-300">S1</td><td class="px-2 py-1.5">Vendor reachable, webhook delivery missing</td><td class="px-2 py-1.5"><code class="text-accent">resend_online</code></td></tr>
                                <tr id="auto-rem-S2" class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-amber-300">S2</td><td class="px-2 py-1.5">DB stale vs vendor truth</td><td class="px-2 py-1.5"><code class="text-accent">db_sync_upsert</code></td></tr>
                                <tr id="auto-rem-S3" class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-amber-300">S3</td><td class="px-2 py-1.5">Duplicate of an earlier open report</td><td class="px-2 py-1.5"><code class="text-accent">close_duplicate</code></td></tr>
                                <tr id="auto-rem-S4" class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-amber-300">S4</td><td class="px-2 py-1.5">Recent rotation/swap explains reseller complaint</td><td class="px-2 py-1.5"><code class="text-accent">classify_only</code> → close after notify</td></tr>
                                <tr id="auto-rem-S5" class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-amber-300">S5</td><td class="px-2 py-1.5">Operator already taking over (locked)</td><td class="px-2 py-1.5">skip (operator_locked)</td></tr>
                                <tr id="auto-rem-S6" class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-amber-300">S6</td><td class="px-2 py-1.5">Insufficient evidence to act</td><td class="px-2 py-1.5">escalate — operator</td></tr>
                            </tbody>
                        </table>
                    </div>

                    <p class="text-white font-medium text-sm mb-2">§F.1 Atomic (AT&amp;T ATOMIC) — A1–A10</p>
                    <div class="overflow-x-auto mb-5">
                        <table class="w-full text-[12px]">
                            <thead class="bg-dark-900 text-dark-400 uppercase tracking-wide text-[10px]">
                                <tr><th class="px-2 py-1.5 text-left">#</th><th class="px-2 py-1.5 text-left">Detection</th><th class="px-2 py-1.5 text-left">Auto action</th><th class="px-2 py-1.5 text-left">Cooldown / cap</th></tr>
                            </thead>
                            <tbody class="divide-y divide-dark-700 text-dark-200">
                                <tr id="auto-rem-A1"  class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-amber-300">A1</td><td class="px-2 py-1.5">inquiry Active + webhook delivered + reseller still bad</td><td class="px-2 py-1.5"><code class="text-accent">atomic_ota</code> (resendOtaProfile)</td><td class="px-2 py-1.5">1 try / 24h</td></tr>
                                <tr id="auto-rem-A2"  class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-amber-300">A2</td><td class="px-2 py-1.5">inquiry Active; sims.status ≠ active</td><td class="px-2 py-1.5"><code class="text-accent">db_sync_upsert</code></td><td class="px-2 py-1.5">1 idempotent</td></tr>
                                <tr id="auto-rem-A3"  class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-amber-300">A3</td><td class="px-2 py-1.5">inquiry Suspended</td><td class="px-2 py-1.5"><code class="text-accent">atomic_restore</code> (CR)</td><td class="px-2 py-1.5">1 try / 24h</td></tr>
                                <tr id="auto-rem-A4"  class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-amber-300">A4</td><td class="px-2 py-1.5">inquiry Cancelled / Deactivated</td><td class="px-2 py-1.5">§E guard → close duplicate or escalate</td><td class="px-2 py-1.5">0 fix</td></tr>
                                <tr id="auto-rem-A5"  class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-amber-300">A5</td><td class="px-2 py-1.5">ICCID not found at vendor</td><td class="px-2 py-1.5">escalate — operator</td><td class="px-2 py-1.5">0</td></tr>
                                <tr id="auto-rem-A6"  class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-amber-300">A6</td><td class="px-2 py-1.5">Active; no delivered webhook for latest number.online</td><td class="px-2 py-1.5"><code class="text-accent">resend_online</code> (force)</td><td class="px-2 py-1.5">2 tries / 1h</td></tr>
                                <tr id="auto-rem-A7"  class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-amber-300">A7</td><td class="px-2 py-1.5">Vendor IMEI ≠ DB IMEI but both correct type</td><td class="px-2 py-1.5"><code class="text-accent">db_sync_upsert</code> (sims.imei)</td><td class="px-2 py-1.5">1 idempotent</td></tr>
                                <tr id="auto-rem-A8"  class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-amber-300">A8</td><td class="px-2 py-1.5">IMEI wrong type (phone IMEI on router etc.)</td><td class="px-2 py-1.5">escalate <code class="text-accent">imei_wrong_type</code></td><td class="px-2 py-1.5">0</td></tr>
                                <tr id="auto-rem-A9"  class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-amber-300">A9</td><td class="px-2 py-1.5">Active; inquiry MDN ≠ sims.current_mdn_e164</td><td class="px-2 py-1.5"><code class="text-accent">db_sync_upsert</code> (sims.current_mdn)</td><td class="px-2 py-1.5">1 idempotent</td></tr>
                                <tr id="auto-rem-A10" class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-amber-300">A10</td><td class="px-2 py-1.5">Unable to reproduce after §C SMS verify</td><td class="px-2 py-1.5"><code class="text-accent">classify_only</code></td><td class="px-2 py-1.5">3 ticks / 2h</td></tr>
                            </tbody>
                        </table>
                    </div>

                    <p class="text-white font-medium text-sm mb-2">§F.2 Wing IoT — W1–W9</p>
                    <div class="overflow-x-auto mb-5">
                        <table class="w-full text-[12px]">
                            <thead class="bg-dark-900 text-dark-400 uppercase tracking-wide text-[10px]">
                                <tr><th class="px-2 py-1.5 text-left">#</th><th class="px-2 py-1.5 text-left">Detection</th><th class="px-2 py-1.5 text-left">Auto action</th><th class="px-2 py-1.5 text-left">Cooldown / cap</th></tr>
                            </thead>
                            <tbody class="divide-y divide-dark-700 text-dark-200">
                                <tr id="auto-rem-W1" class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-sky-300">W1</td><td class="px-2 py-1.5">GET Activated + dialable plan; sims.status ≠ active</td><td class="px-2 py-1.5"><code class="text-accent">db_sync_upsert</code></td><td class="px-2 py-1.5">1 idempotent</td></tr>
                                <tr id="auto-rem-W2" class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-sky-300">W2</td><td class="px-2 py-1.5">Active dialable; no delivered webhook</td><td class="px-2 py-1.5"><code class="text-accent">resend_online</code></td><td class="px-2 py-1.5">2 tries / 1h</td></tr>
                                <tr id="auto-rem-W3" class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-sky-300">W3</td><td class="px-2 py-1.5">Active dialable + recent reseller report</td><td class="px-2 py-1.5"><code class="text-accent">resend_online</code> + §C SMS (no OTA exists for Wing)</td><td class="px-2 py-1.5">1 try / 24h</td></tr>
                                <tr id="auto-rem-W4" class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-sky-300">W4</td><td class="px-2 py-1.5">GET status ≠ Activated</td><td class="px-2 py-1.5">escalate; §E if cancellation suspected</td><td class="px-2 py-1.5">0</td></tr>
                                <tr id="auto-rem-W5" class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-sky-300">W5</td><td class="px-2 py-1.5">GET 404 (ICCID not at vendor)</td><td class="px-2 py-1.5">escalate <code class="text-accent">vendor_iccid_not_found</code></td><td class="px-2 py-1.5">0</td></tr>
                                <tr id="auto-rem-W6" class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-sky-300">W6</td><td class="px-2 py-1.5">GET MDN ≠ DB MDN</td><td class="px-2 py-1.5"><code class="text-accent">db_sync_upsert</code> (verify SMS at vendor MDN)</td><td class="px-2 py-1.5">1 idempotent</td></tr>
                                <tr id="auto-rem-W7" class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-sky-300">W7</td><td class="px-2 py-1.5">Mode wrong: ABIR while rental needs dialable</td><td class="px-2 py-1.5"><code class="text-accent">wing_put_dialable</code> (NON ABIR SMS MO/MT US)</td><td class="px-2 py-1.5">1 try / 24h</td></tr>
                                <tr id="auto-rem-W8" class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-sky-300">W8</td><td class="px-2 py-1.5">IMEI wrong type (phone IMEI on Wing SIM)</td><td class="px-2 py-1.5">escalate — operator</td><td class="px-2 py-1.5">0</td></tr>
                                <tr id="auto-rem-W9" class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-sky-300">W9</td><td class="px-2 py-1.5">All clean + §C SMS verifies</td><td class="px-2 py-1.5"><code class="text-accent">classify_only</code> → unable_to_reproduce</td><td class="px-2 py-1.5">3 ticks / 2h</td></tr>
                            </tbody>
                        </table>
                    </div>

                    <p class="text-white font-medium text-sm mb-2">§F.3 Helix (T-Mobile via SOLO) — H1–H9</p>
                    <div class="overflow-x-auto mb-5">
                        <table class="w-full text-[12px]">
                            <thead class="bg-dark-900 text-dark-400 uppercase tracking-wide text-[10px]">
                                <tr><th class="px-2 py-1.5 text-left">#</th><th class="px-2 py-1.5 text-left">Detection</th><th class="px-2 py-1.5 text-left">Auto action</th><th class="px-2 py-1.5 text-left">Cooldown / cap</th></tr>
                            </thead>
                            <tbody class="divide-y divide-dark-700 text-dark-200">
                                <tr id="auto-rem-H1" class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-fuchsia-300">H1</td><td class="px-2 py-1.5">4.7 details Active; DB ≠ active</td><td class="px-2 py-1.5"><code class="text-accent">db_sync_upsert</code></td><td class="px-2 py-1.5">1 idempotent</td></tr>
                                <tr id="auto-rem-H2" class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-fuchsia-300">H2</td><td class="px-2 py-1.5">Active; no delivered webhook</td><td class="px-2 py-1.5"><code class="text-accent">resend_online</code></td><td class="px-2 py-1.5">2 tries / 1h</td></tr>
                                <tr id="auto-rem-H3" class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-fuchsia-300">H3</td><td class="px-2 py-1.5">Active + delivered + recent reseller report</td><td class="px-2 py-1.5"><code class="text-accent">helix_ota</code> (4.11)</td><td class="px-2 py-1.5">1 try / 24h</td></tr>
                                <tr id="auto-rem-H4" class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-fuchsia-300">H4</td><td class="px-2 py-1.5">4.7 state Suspended</td><td class="px-2 py-1.5"><code class="text-accent">helix_unsuspend</code> (4.6 CR/35)</td><td class="px-2 py-1.5">1 try / 24h</td></tr>
                                <tr id="auto-rem-H5" class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-fuchsia-300">H5</td><td class="px-2 py-1.5">4.7 state Cancelled</td><td class="px-2 py-1.5">§E guard → close duplicate or escalate</td><td class="px-2 py-1.5">0 auto-fix</td></tr>
                                <tr id="auto-rem-H6" class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-fuchsia-300">H6</td><td class="px-2 py-1.5">4.7 returns not-found</td><td class="px-2 py-1.5">escalate</td><td class="px-2 py-1.5">0</td></tr>
                                <tr id="auto-rem-H7" class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-fuchsia-300">H7</td><td class="px-2 py-1.5">DB MDN ≠ Helix MDN</td><td class="px-2 py-1.5"><code class="text-accent">db_sync_upsert</code></td><td class="px-2 py-1.5">1 idempotent</td></tr>
                                <tr id="auto-rem-H8" class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-fuchsia-300">H8</td><td class="px-2 py-1.5">IMEI wrong / drift</td><td class="px-2 py-1.5">escalate (4.8 IMEI write is operator-only)</td><td class="px-2 py-1.5">0</td></tr>
                                <tr id="auto-rem-H9" class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-fuchsia-300">H9</td><td class="px-2 py-1.5">All clean + §C SMS verifies</td><td class="px-2 py-1.5"><code class="text-accent">classify_only</code> → unable_to_reproduce</td><td class="px-2 py-1.5">3 ticks / 2h</td></tr>
                            </tbody>
                        </table>
                    </div>

                    <p class="text-white font-medium text-sm mb-2">§F.4 Teltik — T1–T11</p>
                    <div class="overflow-x-auto mb-5">
                        <table class="w-full text-[12px]">
                            <thead class="bg-dark-900 text-dark-400 uppercase tracking-wide text-[10px]">
                                <tr><th class="px-2 py-1.5 text-left">#</th><th class="px-2 py-1.5 text-left">Detection</th><th class="px-2 py-1.5 text-left">Auto action</th><th class="px-2 py-1.5 text-left">Cooldown / cap</th></tr>
                            </thead>
                            <tbody class="divide-y divide-dark-700 text-dark-200">
                                <tr id="auto-rem-T1"  class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-emerald-300">T1</td><td class="px-2 py-1.5">/get-phone-number + /port-status healthy; DB ≠ active</td><td class="px-2 py-1.5"><code class="text-accent">db_sync_upsert</code></td><td class="px-2 py-1.5">1 idempotent</td></tr>
                                <tr id="auto-rem-T2"  class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-emerald-300">T2</td><td class="px-2 py-1.5">Healthy; no delivered webhook</td><td class="px-2 py-1.5"><code class="text-accent">resend_online</code></td><td class="px-2 py-1.5">2 tries / 1h</td></tr>
                                <tr id="auto-rem-T3"  class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-emerald-300">T3</td><td class="px-2 py-1.5">Healthy + delivered + recent reseller report</td><td class="px-2 py-1.5"><code class="text-accent">teltik_reset_network</code> → <code class="text-accent">teltik_reset_port</code></td><td class="px-2 py-1.5">1 try each / 24h</td></tr>
                                <tr id="auto-rem-T4"  class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-emerald-300">T4</td><td class="px-2 py-1.5">/port-status pending/in-progress &gt; 6h</td><td class="px-2 py-1.5"><code class="text-accent">teltik_reset_port</code></td><td class="px-2 py-1.5">1 try / 24h</td></tr>
                                <tr id="auto-rem-T5"  class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-emerald-300">T5</td><td class="px-2 py-1.5">/port-status offline</td><td class="px-2 py-1.5"><code class="text-accent">teltik_reset_port</code></td><td class="px-2 py-1.5">1 try / 24h</td></tr>
                                <tr id="auto-rem-T6"  class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-emerald-300">T6</td><td class="px-2 py-1.5">/get-info returns terminal (suspended/cancelled)</td><td class="px-2 py-1.5">§E guard</td><td class="px-2 py-1.5">0 fix</td></tr>
                                <tr id="auto-rem-T7"  class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-emerald-300">T7</td><td class="px-2 py-1.5">ICCID/MDN not in Teltik</td><td class="px-2 py-1.5">escalate</td><td class="px-2 py-1.5">0</td></tr>
                                <tr id="auto-rem-T8"  class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-emerald-300">T8</td><td class="px-2 py-1.5">DB MDN ≠ Teltik MDN</td><td class="px-2 py-1.5"><code class="text-accent">db_sync_upsert</code></td><td class="px-2 py-1.5">1 idempotent</td></tr>
                                <tr id="auto-rem-T9"  class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-emerald-300">T9</td><td class="px-2 py-1.5">/forward-url GET absent/wrong</td><td class="px-2 py-1.5">escalate <code class="text-accent">teltik_forward_url_misconfigured</code></td><td class="px-2 py-1.5">0</td></tr>
                                <tr id="auto-rem-T10" class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-emerald-300">T10</td><td class="px-2 py-1.5">§B IMEI check fails</td><td class="px-2 py-1.5">escalate — operator</td><td class="px-2 py-1.5">0</td></tr>
                                <tr id="auto-rem-T11" class="hover:bg-dark-700/40"><td class="px-2 py-1.5 font-mono text-emerald-300">T11</td><td class="px-2 py-1.5">All clean + §C SMS verifies</td><td class="px-2 py-1.5"><code class="text-accent">classify_only</code> → unable_to_reproduce</td><td class="px-2 py-1.5">3 ticks / 2h</td></tr>
                            </tbody>
                        </table>
                    </div>

                    <div class="text-[11px] text-dark-400 mt-3">
                        Spec: <code class="text-accent">docs/superpowers/plans/2026-06-07-bad-rental-auto-remediation.md</code> (§K + §F.1–§F.4). Worker: <code class="text-accent">src/bad-rental-remediator/</code>. Audit tables: <code class="text-accent">rental_report_remediation_attempts</code>, <code class="text-accent">rental_report_events</code>.
                    </div>
                </div>

            </div>

            <div id="tab-api-tester" class="tab-content hidden">`;

replace(OLD_GUIDE_TAIL, GUIDE_BLOCK, 'Guide tab: bad-rental decision tree + situation tables');

/* ===========================================================
 * Write back as CRLF and finish.
 * =========================================================== */

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied successfully.');
