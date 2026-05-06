// _fix_stats_count.js
// Replace handleStats to use PostgREST count=exact instead of fetching all rows
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');

// Normalize to LF
content = content.replace(/\r\n/g, '\n');

const OLD = `async function handleStats(env, corsHeaders) {
  try {
    // Get SIM counts
    const simsResponse = await supabaseGet(env, 'sims?select=status');
    const sims = await simsResponse.json();

    const stats = {
      total_sims: sims.length,
      active_sims: sims.filter(s => s.status === 'active').length,
      provisioning_sims: sims.filter(s => s.status === 'provisioning').length,
    };

    // Get message count (last 24 hours)
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const messagesResponse = await supabaseGet(
      env,
      \`inbound_sms?select=id&received_at=gte.\${yesterday}\`
    );
    const messages = await messagesResponse.json();
    stats.messages_24h = messages.length;

    return new Response(JSON.stringify(stats), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}`;

const NEW = `async function handleStats(env, corsHeaders) {
  try {
    const base = env.SUPABASE_URL + '/rest/v1/';
    const authHeaders = {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
      Accept: 'application/json',
      Prefer: 'count=exact',
    };

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const [totalRes, activeRes, provRes, msgRes] = await Promise.all([
      fetch(base + 'sims?select=id&limit=1', { headers: authHeaders }),
      fetch(base + 'sims?select=id&status=eq.active&limit=1', { headers: authHeaders }),
      fetch(base + 'sims?select=id&status=eq.provisioning&limit=1', { headers: authHeaders }),
      fetch(base + 'inbound_sms?select=id&received_at=gte.' + yesterday + '&limit=1', { headers: authHeaders }),
    ]);

    const getCount = res => {
      const cr = res.headers.get('content-range') || '';
      return parseInt(cr.split('/')[1] || '0', 10);
    };

    const stats = {
      total_sims: getCount(totalRes),
      active_sims: getCount(activeRes),
      provisioning_sims: getCount(provRes),
      messages_24h: getCount(msgRes),
    };

    return new Response(JSON.stringify(stats), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}`;

if (!content.includes(OLD)) {
  console.error('PATCH FAILED: old string not found.');
  process.exit(1);
}

content = content.replace(OLD, NEW);

// Convert back to CRLF
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied successfully.');
