// Fix: make manual resend online_until vendor-aware (Teltik = +48h, Helix = next 5AM UTC)
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'dashboard', 'index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// 1. Add vendor + rotation_interval_hours to the sims select
const OLD1 = `const simResponse = await supabaseGet(env, \`sims?select=id,iccid,status&id=eq.\${simId}\`);`;
const NEW1 = `const simResponse = await supabaseGet(env, \`sims?select=id,iccid,status,vendor,rotation_interval_hours&id=eq.\${simId}\`);`;

if (!content.includes(OLD1)) { console.error('ERROR: anchor 1 not found'); process.exit(1); }
content = content.replace(OLD1, NEW1);
console.log('✓ vendor/rotation_interval_hours added to sims select');

// 2. Replace hardcoded online_until calculation with vendor-aware version
const OLD2 = `    // Calculate next rotation time (5 AM UTC next day)
    const now = new Date();
    const next = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      5, 0, 0
    ));
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    const onlineUntil = next.toISOString();`;

const NEW2 = `    // Calculate online_until — vendor-aware (Teltik = +48h, Helix = next 5AM UTC)
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

if (!content.includes(OLD2)) { console.error('ERROR: anchor 2 not found'); process.exit(1); }
content = content.replace(OLD2, NEW2);
console.log('✓ online_until made vendor-aware');

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('✓ File written');
