// Bulk Query: add 250ms spacing between SIMs + single retry-on-exception.
// "Failed to fetch" mid-bulk is the dashboard/relay layer dropping under
// sustained load, not AT&T rate-limiting.

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

const OLD =
`            for (const sim of sims) {
                const vendor = sim.vendor || 'unknown';
                const label = (sim.iccid || ('#' + sim.id));
                try {`;

const NEW =
`            // Per-vendor endpoint + body shape — used by the catch block to retry.
            const _epFor = (v) => v === 'wing_iot' ? '/wing-check'
                : v === 'teltik' ? '/teltik-query'
                : v === 'atomic' ? '/atomic-query' : '/helix-query';
            const _bodyFor = (v, s) => v === 'helix'
                ? { mobility_subscription_id: s.mobility_subscription_id || s.iccid || '' }
                : v === 'atomic' ? { identifier: s.iccid || '' }
                : { iccid: s.iccid || '' };

            for (let _i = 0; _i < sims.length; _i++) {
                const sim = sims[_i];
                const vendor = sim.vendor || 'unknown';
                const label = (sim.iccid || ('#' + sim.id));
                // Spacing: 250 ms between calls keeps the relay + AT&T layers
                // from saturating mid-batch. Adds ~1 min per 240 SIMs.
                if (_i > 0) await new Promise(r => setTimeout(r, 250));
                try {`;

if (!content.includes(OLD)) {
  console.error('PATCH FAILED: bulk loop opener not found.');
  process.exit(1);
}
content = content.replace(OLD, NEW);

// Now add retry-on-exception in the catch block.
const OLD_CATCH =
`                } catch (e) {
                    failCount++;
                    lines.push(label + ' [' + vendor + ']: EXCEPTION — ' + e.message);
                }
                output.textContent = lines.join('\\\\n');
            }`;

const NEW_CATCH =
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
                }
                output.textContent = lines.join('\\\\n');
            }`;

if (!content.includes(OLD_CATCH)) {
  console.error('PATCH FAILED: catch block not found.');
  process.exit(1);
}
content = content.replace(OLD_CATCH, NEW_CATCH);

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied successfully.');
