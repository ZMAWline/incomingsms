// _fix_backfill_relay.js
// Routes the 2 Helix fetch calls inside handleBackfillCancelDates through relayFetch.

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// 1. Helix token fetch inside handleBackfillCancelDates
const OLD1 = `        // 3. Get Helix token
        const tokenRes = await fetch(env.HX_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                grant_type: 'password',
                client_id: env.HX_CLIENT_ID,
                audience: env.HX_AUDIENCE,
                username: env.HX_GRANT_USERNAME,
                password: env.HX_GRANT_PASSWORD,
            }),
        });`;

const NEW1 = `        // 3. Get Helix token
        const tokenRes = await relayFetch(env, env.HX_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                grant_type: 'password',
                client_id: env.HX_CLIENT_ID,
                audience: env.HX_AUDIENCE,
                username: env.HX_GRANT_USERNAME,
                password: env.HX_GRANT_PASSWORD,
            }),
        });`;

if (!content.includes(OLD1)) {
  console.error('PATCH FAILED: backfill token fetch not found');
  process.exit(1);
}
content = content.replace(OLD1, NEW1);
console.log('Patched backfill Helix token fetch');

// 2. Helix subscriber details fetch inside the loop
const OLD2 = `                const detailsRes = await fetch(\`\${env.HX_API_BASE}/api/mobility-subscriber/details\`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: \`Bearer \${token}\`,
                    },`;

const NEW2 = `                const detailsRes = await relayFetch(env, \`\${env.HX_API_BASE}/api/mobility-subscriber/details\`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: \`Bearer \${token}\`,
                    },`;

if (!content.includes(OLD2)) {
  console.error('PATCH FAILED: backfill details fetch not found');
  process.exit(1);
}
content = content.replace(OLD2, NEW2);
console.log('Patched backfill Helix details fetch');

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied successfully.');
