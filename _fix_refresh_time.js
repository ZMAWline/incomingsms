const fs = require('fs');

const file = 'src/dashboard/index.js';
let content = fs.readFileSync(file, 'utf8');
const normalized = content.replace(/\r\n/g, '\n');

const OLD = `                tableState.sims.data = sims;
                lastSimsFetchedAt = Date.now();
                const cacheLabel = document.getElementById('sims-cache-label');
                if (cacheLabel) cacheLabel.textContent = '(just loaded)';`;

const NEW = `                tableState.sims.data = sims;
                lastSimsFetchedAt = Date.now();
                const cacheLabel = document.getElementById('sims-cache-label');
                if (cacheLabel) cacheLabel.textContent = '(just loaded)';
                const lastUpdated = document.getElementById('last-updated');
                if (lastUpdated) lastUpdated.textContent = 'Updated ' + new Date().toLocaleTimeString();`;

if (!normalized.includes(OLD)) {
  console.error('ERROR: old string not found');
  process.exit(1);
}

const result = normalized.replace(OLD, NEW).replace(/\n/g, '\r\n');
fs.writeFileSync(file, result);
console.log('Patched');
