// Fix: online_until = midnight NY after interval from last rotation; add carrier field
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'dashboard', 'index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// 1. Add last_mdn_rotated_at to sims select (vendor/rotation_interval_hours already added)
const OLD1 = `sims?select=id,iccid,status,vendor,rotation_interval_hours&id=eq.\${simId}`;
const NEW1 = `sims?select=id,iccid,status,vendor,rotation_interval_hours,last_mdn_rotated_at&id=eq.\${simId}`;
if (!content.includes(OLD1)) { console.error('ERROR: anchor 1 not found'); process.exit(1); }
content = content.replace(OLD1, NEW1);
console.log('✓ last_mdn_rotated_at added to sims select');

// 2. Replace vendor-aware online_until block with midnightNYAfterInterval approach
const OLD2 = `    // Calculate online_until — vendor-aware (Teltik = +48h, Helix = next 5AM UTC)
    let onlineUntil;
    if (sim.vendor === 'teltik') {
      const intervalHours = sim.rotation_interval_hours || 48;
      onlineUntil = new Date(Date.now() + intervalHours * 60 * 60 * 1000).toISOString();
    } else {
      const now = new Date();
      const next = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        5, 0, 0
      ));
      if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
      onlineUntil = next.toISOString();
    }`;

const NEW2 = `    // Calculate online_until — midnight NY of the rotation-due date
    const _baseTs = sim.last_mdn_rotated_at ? new Date(sim.last_mdn_rotated_at) : new Date();
    const _intervalHours = sim.rotation_interval_hours || (sim.vendor === 'teltik' ? 48 : 24);
    const _intervalDays = Math.ceil(_intervalHours / 24);
    const _nyDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(_baseTs);
    const [_y, _m, _d] = _nyDate.split('-').map(Number);
    const _probe = new Date(Date.UTC(_y, _m - 1, _d + _intervalDays, 5, 0, 0));
    const _probeNyDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(_probe);
    const _tzPart = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', timeZoneName: 'shortOffset'
    }).formatToParts(_probe).find(p => p.type === 'timeZoneName')?.value ?? 'GMT-4';
    const _offsetHours = -parseInt(_tzPart.replace('GMT', '') || '-4');
    const onlineUntil = new Date(\`\${_probeNyDate}T\${String(_offsetHours).padStart(2, '0')}:00:00.000Z\`).toISOString();`;

if (!content.includes(OLD2)) { console.error('ERROR: anchor 2 not found'); process.exit(1); }
content = content.replace(OLD2, NEW2);
console.log('✓ online_until uses midnightNYAfterInterval logic');

// 3. Add carrier field to payload
const OLD3 = `        online_until: onlineUntil,
        verified: verificationStatus === 'verified',`;
const NEW3 = `        online_until: onlineUntil,
        carrier: sim.vendor === 'teltik' ? 'T-Mobile' : 'att',
        verified: verificationStatus === 'verified',`;
if (!content.includes(OLD3)) { console.error('ERROR: anchor 3 not found'); process.exit(1); }
content = content.replace(OLD3, NEW3);
console.log('✓ carrier field added to payload');

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('✓ File written');
