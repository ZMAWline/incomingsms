// Fix: add vendor/carrier/rotation_interval_hours to handleSims formatted map
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'dashboard', 'index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

const OLD = `        last_notified_at: sim.last_notified_at || null,
      };
    });

    return new Response(JSON.stringify(formatted), {`;

const NEW = `        last_notified_at: sim.last_notified_at || null,
        vendor: sim.vendor || 'helix',
        carrier: sim.carrier || null,
        rotation_interval_hours: sim.rotation_interval_hours || 24,
      };
    });

    return new Response(JSON.stringify(formatted), {`;

if (!content.includes(OLD)) { console.error('ERROR: anchor not found'); process.exit(1); }
content = content.replace(OLD, NEW);
console.log('✓ vendor/carrier/rotation_interval_hours added to formatted map');

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('✓ File written');
