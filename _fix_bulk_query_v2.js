// (1) Bulk Query result lines now include action notes for skipped DB syncs
//     (e.g. "[rotation_status→failed: stuck on ABIR]").
// (2) Increase per-SIM spacing (250→500ms) and retry budget (1→2 retries with
//     1s then 3s backoff) — single retry wasn't catching every transient
//     "failed to fetch".

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// ── Change A: wing_iot result line — add db_skip_reason note ──────────────
const OLD_A =
`                        if (r.ok) {
                            okCount++;
                            const wStatus = r.response && r.response.status ? r.response.status : 'OK';
                            const wNote = r.db_update && r.db_update.found ? (r.db_update.status_updated ? ' [status→active]' : '') + (r.db_update.mdn_updated ? ' [MDN→' + r.db_update.mdn_new + ']' : '') : '';
                            lines.push(label + ' [wing_iot]: ' + wStatus + wNote);
                        } else {`;

const NEW_A =
`                        if (r.ok) {
                            okCount++;
                            const wStatus = r.response && r.response.status ? r.response.status : 'OK';
                            const wPlan = r.response && r.response.communicationPlan ? r.response.communicationPlan : '';
                            let wNote = '';
                            if (r.db_update && r.db_update.found) {
                                if (r.db_update.status_updated) wNote += ' [status→active]';
                                if (r.db_update.mdn_updated) wNote += ' [MDN→' + r.db_update.mdn_new + ']';
                            }
                            if (r.db_skip_reason) {
                                const planTag = wPlan && wPlan.indexOf('ABIR') !== -1 && wPlan.indexOf('NON ABIR') === -1
                                    ? 'ABIR (non-dialable)'
                                    : (wPlan || 'wrong plan');
                                wNote += ' [rotation_status→failed: stuck on ' + planTag + ']';
                            }
                            lines.push(label + ' [wing_iot]: ' + wStatus + wNote);
                        } else {`;

if (!content.includes(OLD_A)) {
  console.error('PATCH FAILED: change A old block not found.');
  process.exit(1);
}
content = content.replace(OLD_A, NEW_A);

// ── Change B: spacing 250→500ms ─────────────────────────────────────────────
const OLD_B =
`                // Spacing: 250 ms between calls keeps the relay + AT&T layers
                // from saturating mid-batch. Adds ~1 min per 240 SIMs.
                if (_i > 0) await new Promise(r => setTimeout(r, 250));`;

const NEW_B =
`                // Spacing between calls keeps the relay + AT&T layers from
                // saturating mid-batch. Adds ~2 min per 240 SIMs.
                if (_i > 0) await new Promise(r => setTimeout(r, 500));`;

if (!content.includes(OLD_B)) {
  console.error('PATCH FAILED: change B old block not found.');
  process.exit(1);
}
content = content.replace(OLD_B, NEW_B);

// ── Change C: catch block — 1 retry → up-to-2 retries (1s, 3s backoff) ─────
const OLD_C =
`                } catch (e) {
                    // Most "failed to fetch" are transient relay/network blips —
                    // back off briefly and retry once before giving up.
                    await new Promise(r => setTimeout(r, 1000));
                    try {
                        const _res2 = await fetch(API_BASE + _epFor(vendor), {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(_bodyFor(vendor, sim))
                        });
                        const _r2 = await _res2.json();
                        if (_r2.ok) {
                            okCount++;
                            lines.push(label + ' [' + vendor + ']: OK (after retry)');
                        } else {
                            failCount++;
                            lines.push(label + ' [' + vendor + ']: ERROR after retry — ' + (_r2.error || 'unknown'));
                        }
                    } catch (e2) {
                        failCount++;
                        lines.push(label + ' [' + vendor + ']: EXCEPTION — ' + e.message + ' (retry: ' + e2.message + ')');
                    }
                }`;

const NEW_C =
`                } catch (e) {
                    // Up to 2 retries with 1s and 3s backoff. "failed to fetch"
                    // can persist past a single short retry under sustained load.
                    let _settled = false;
                    let _lastErr = e;
                    const _backoffs = [1000, 3000];
                    for (let _r = 0; _r < _backoffs.length && !_settled; _r++) {
                        await new Promise(r => setTimeout(r, _backoffs[_r]));
                        try {
                            const _res2 = await fetch(API_BASE + _epFor(vendor), {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(_bodyFor(vendor, sim))
                            });
                            const _r2 = await _res2.json();
                            if (_r2.ok) {
                                okCount++;
                                lines.push(label + ' [' + vendor + ']: OK (after retry ' + (_r + 1) + ')');
                            } else {
                                failCount++;
                                lines.push(label + ' [' + vendor + ']: ERROR after retry — ' + (_r2.error || 'unknown'));
                            }
                            _settled = true;
                        } catch (e2) {
                            _lastErr = e2;
                        }
                    }
                    if (!_settled) {
                        failCount++;
                        lines.push(label + ' [' + vendor + ']: EXCEPTION — ' + e.message + ' (final: ' + _lastErr.message + ')');
                    }
                }`;

if (!content.includes(OLD_C)) {
  console.error('PATCH FAILED: change C catch block not found.');
  process.exit(1);
}
content = content.replace(OLD_C, NEW_C);

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied successfully.');
