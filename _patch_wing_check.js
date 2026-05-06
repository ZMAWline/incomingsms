// Add Wing IoT device check endpoint
const fs = require('fs');
const path = require('path');

const dashPath = path.join(__dirname, 'src', 'dashboard', 'index.js');
let content = fs.readFileSync(dashPath, 'utf8');

// 1. Add route handler
const routeOld = `if (url.pathname === '/api/helix-query') {
      return handleHelixQuery(request, env, corsHeaders);
    }`;

const routeNew = `if (url.pathname === '/api/wing-check') {
      return handleWingCheck(request, env, corsHeaders);
    }

    if (url.pathname === '/api/helix-query') {
      return handleHelixQuery(request, env, corsHeaders);
    }`;

if (content.includes(routeOld)) {
  content = content.replace(routeOld, routeNew);
} else if (content.includes(routeOld.replace(/\n/g, '\r\n'))) {
  content = content.replace(routeOld.replace(/\n/g, '\r\n'), routeNew.replace(/\n/g, '\r\n'));
} else {
  console.error('ERROR: Could not find helix-query route');
  process.exit(1);
}

// 2. Add handler function (before handleHelixQuery)
const handlerOld = `async function handleHelixQuery(request, env, corsHeaders) {`;

const handlerNew = `async function handleWingCheck(request, env, corsHeaders) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }
  try {
    const { iccid } = await request.json();
    if (!iccid) {
      return new Response(JSON.stringify({ error: 'iccid required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const baseUrl = env.WING_IOT_BASE_URL || 'https://restapi19.att.com/rws/api';
    const url = baseUrl + '/v1/devices/' + encodeURIComponent(iccid);
    const auth = 'Basic ' + btoa(env.WING_IOT_USERNAME + ':' + env.WING_IOT_API_KEY);

    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: auth }
    });

    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}

    return new Response(JSON.stringify({
      ok: res.ok,
      status: res.status,
      iccid,
      response: json || text
    }, null, 2), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleHelixQuery(request, env, corsHeaders) {`;

if (content.includes(handlerOld)) {
  content = content.replace(handlerOld, handlerNew);
} else if (content.includes(handlerOld.replace(/\n/g, '\r\n'))) {
  content = content.replace(handlerOld.replace(/\n/g, '\r\n'), handlerNew.replace(/\n/g, '\r\n'));
} else {
  console.error('ERROR: Could not find handleHelixQuery');
  process.exit(1);
}

fs.writeFileSync(dashPath, content, 'utf8');
console.log('Wing check endpoint added!');
console.log('Test with: curl -X POST https://dashboard.zalmen-531.workers.dev/api/wing-check -H "Content-Type: application/json" -d \'{"iccid":"89010303300133220351"}\'');
