// _fix_dashboard_relay.js
// Adds relayFetch helper to dashboard worker and routes 4 external fetch calls through it.
// These are: webhook send (sim-online), helix-query token+details, blimei-sweep token+details.

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');

// Normalize to LF for reliable search/replace
content = content.replace(/\r\n/g, '\n');

// ─── 1. Add relayFetch helper near the top (after the export default { block opens) ───

const RELAY_HELPER_ANCHOR = 'async function handleStats(env, corsHeaders)';

if (content.includes('function relayFetch(')) {
  console.log('relayFetch already present in dashboard, skipping helper insertion');
} else {
  if (!content.includes(RELAY_HELPER_ANCHOR)) {
    console.error('PATCH FAILED: anchor for relayFetch insertion not found');
    process.exit(1);
  }
  const RELAY_HELPER = `function relayFetch(env, url, init) {
  if (env.RELAY_URL && env.RELAY_KEY) {
    return fetch(env.RELAY_URL + '/' + url, {
      ...init,
      headers: { ...(init && init.headers || {}), 'x-relay-key': env.RELAY_KEY },
    });
  }
  return fetch(url, init);
}

`;
  content = content.replace(RELAY_HELPER_ANCHOR, RELAY_HELPER + RELAY_HELPER_ANCHOR);
  console.log('Added relayFetch helper');
}

// ─── 2. sim-online webhook send (line ~1045) ───

const OLD_WEBHOOK = `    const webhookResponse = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });`;

const NEW_WEBHOOK = `    const webhookResponse = await relayFetch(env, webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });`;

if (!content.includes(OLD_WEBHOOK)) {
  console.error('PATCH FAILED: sim-online webhook fetch not found');
  process.exit(1);
}
content = content.replace(OLD_WEBHOOK, NEW_WEBHOOK);
console.log('Patched sim-online webhook');

// ─── 3. helix-query: token fetch ───

const OLD_HQ_TOKEN = `    const tokenRes = await fetch(env.HX_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'password',
        client_id: env.HX_CLIENT_ID,
        audience: env.HX_AUDIENCE,
        username: env.HX_GRANT_USERNAME,
        password: env.HX_GRANT_PASSWORD,
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      return new Response(JSON.stringify({ error: 'Failed to get Helix token', details: tokenData }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const token = tokenData.access_token;
    const detailsUrl = env.HX_API_BASE + '/api/mobility-subscriber/details';
    const detailsRes = await fetch(detailsUrl, {`;

const NEW_HQ_TOKEN = `    const tokenRes = await relayFetch(env, env.HX_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'password',
        client_id: env.HX_CLIENT_ID,
        audience: env.HX_AUDIENCE,
        username: env.HX_GRANT_USERNAME,
        password: env.HX_GRANT_PASSWORD,
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      return new Response(JSON.stringify({ error: 'Failed to get Helix token', details: tokenData }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const token = tokenData.access_token;
    const detailsUrl = env.HX_API_BASE + '/api/mobility-subscriber/details';
    const detailsRes = await relayFetch(env, detailsUrl, {`;

if (!content.includes(OLD_HQ_TOKEN)) {
  console.error('PATCH FAILED: helix-query token+details fetch not found');
  process.exit(1);
}
content = content.replace(OLD_HQ_TOKEN, NEW_HQ_TOKEN);
console.log('Patched helix-query token+details');

// ─── 4. blimei-sweep: token fetch ───

const OLD_BS_TOKEN = `    const tokenRes = await fetch(env.HX_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'password',
        client_id: env.HX_CLIENT_ID,
        audience: env.HX_AUDIENCE,
        username: env.HX_GRANT_USERNAME,
        password: env.HX_GRANT_PASSWORD,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      return new Response(JSON.stringify({ error: 'Failed to get Helix token', details: tokenData }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const token = tokenData.access_token;`;

const NEW_BS_TOKEN = `    const tokenRes = await relayFetch(env, env.HX_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'password',
        client_id: env.HX_CLIENT_ID,
        audience: env.HX_AUDIENCE,
        username: env.HX_GRANT_USERNAME,
        password: env.HX_GRANT_PASSWORD,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      return new Response(JSON.stringify({ error: 'Failed to get Helix token', details: tokenData }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const token = tokenData.access_token;`;

if (!content.includes(OLD_BS_TOKEN)) {
  console.error('PATCH FAILED: blimei-sweep token fetch not found');
  process.exit(1);
}
content = content.replace(OLD_BS_TOKEN, NEW_BS_TOKEN);
console.log('Patched blimei-sweep token');

// ─── 5. blimei-sweep: details fetch inside loop ───

const OLD_BS_DETAILS = `        const detailsRes = await fetch(env.HX_API_BASE + '/api/mobility-subscriber/details', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({ mobilitySubscriptionId: parseInt(sim.mobility_subscription_id) }),
        });`;

const NEW_BS_DETAILS = `        const detailsRes = await relayFetch(env, env.HX_API_BASE + '/api/mobility-subscriber/details', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({ mobilitySubscriptionId: parseInt(sim.mobility_subscription_id) }),
        });`;

if (!content.includes(OLD_BS_DETAILS)) {
  console.error('PATCH FAILED: blimei-sweep details fetch not found');
  process.exit(1);
}
content = content.replace(OLD_BS_DETAILS, NEW_BS_DETAILS);
console.log('Patched blimei-sweep details');

// Convert back to CRLF
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Dashboard relay patch applied successfully.');
