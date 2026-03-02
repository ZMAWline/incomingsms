const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'dashboard', 'index.js');
let src = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');

// --- 1. Remove the dead intercept that was incorrectly placed in the send-sms handler ---
const DEAD_INTERCEPT = `
    // Intercept set-imei to update IMEI pool automatically
    if (skylinePath === '/set-imei' && request.method === 'POST' && result.ok && requestBodyParsed) {
      try {
        const { gateway_id, port, imei: newImei } = requestBodyParsed;
        const normPort = normalizeImeiPoolPort(port);
        if (gateway_id && port && newImei) {
          // 1. Retire old IMEI on this gateway/port (if any)
          await fetch(\`\${env.SUPABASE_URL}/rest/v1/imei_pool?gateway_id=eq.\${gateway_id}&port=eq.\${encodeURIComponent(normPort)}&status=eq.in_use&imei=neq.\${newImei}\`, {
            method: 'PATCH',
            headers: {
              apikey: env.SUPABASE_SERVICE_ROLE_KEY,
              Authorization: \`Bearer \${env.SUPABASE_SERVICE_ROLE_KEY}\`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ status: 'retired', sim_id: null, assigned_at: null })
          });

          // 2. Upsert the new IMEI into the pool as in_use
          await fetch(\`\${env.SUPABASE_URL}/rest/v1/imei_pool?on_conflict=imei\`, {
            method: 'POST',
            headers: {
              apikey: env.SUPABASE_SERVICE_ROLE_KEY,
              Authorization: \`Bearer \${env.SUPABASE_SERVICE_ROLE_KEY}\`,
              'Content-Type': 'application/json',
              Prefer: 'resolution=merge-duplicates,return=minimal'
            },
            body: JSON.stringify({
              imei: newImei,
              status: 'in_use',
              gateway_id: parseInt(gateway_id),
              port: normPort,
              notes: \`Manually set via dashboard on \${new Date().toISOString().split('T')[0]}\`
            })
          });
        }
      } catch (poolErr) {
        console.error('Failed to update IMEI pool after set-imei:', poolErr);
      }
    }
`;

if (!src.includes(DEAD_INTERCEPT)) { console.error('Dead intercept not found'); process.exit(1); }
src = src.replace(DEAD_INTERCEPT, '\n');
console.log('Patch 1: removed dead intercept from send-sms handler');

// --- 2. Add the intercept in the real skyline proxy handler, before the return ---
const PROXY_RETURN = `    const responseText = await skylineResponse.text();
    let result;
    try { result = JSON.parse(responseText); } catch { result = { raw: responseText }; }

    return new Response(JSON.stringify(result, null, 2), {
      status: skylineResponse.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });`;

const PROXY_RETURN_WITH_INTERCEPT = `    const responseText = await skylineResponse.text();
    let result;
    try { result = JSON.parse(responseText); } catch { result = { raw: responseText }; }

    // Intercept set-imei to update IMEI pool automatically
    if (skylinePath === '/set-imei' && request.method === 'POST' && result.ok && requestBodyParsed) {
      try {
        const { gateway_id, port, imei: newImei } = requestBodyParsed;
        const normPort = normalizeImeiPoolPort(port);
        if (gateway_id && port && newImei) {
          // 1. Retire old IMEI on this gateway/port (if any)
          await fetch(\`\${env.SUPABASE_URL}/rest/v1/imei_pool?gateway_id=eq.\${gateway_id}&port=eq.\${encodeURIComponent(normPort)}&status=eq.in_use&imei=neq.\${newImei}\`, {
            method: 'PATCH',
            headers: {
              apikey: env.SUPABASE_SERVICE_ROLE_KEY,
              Authorization: \`Bearer \${env.SUPABASE_SERVICE_ROLE_KEY}\`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ status: 'retired', sim_id: null, assigned_at: null }),
          });
          // 2. Upsert new IMEI as in_use
          await fetch(\`\${env.SUPABASE_URL}/rest/v1/imei_pool?on_conflict=imei\`, {
            method: 'POST',
            headers: {
              apikey: env.SUPABASE_SERVICE_ROLE_KEY,
              Authorization: \`Bearer \${env.SUPABASE_SERVICE_ROLE_KEY}\`,
              'Content-Type': 'application/json',
              Prefer: 'resolution=merge-duplicates,return=minimal',
            },
            body: JSON.stringify({
              imei: newImei,
              status: 'in_use',
              gateway_id: parseInt(gateway_id),
              port: normPort,
              notes: \`Manually set via dashboard on \${new Date().toISOString().split('T')[0]}\`,
            }),
          });
        }
      } catch (poolErr) {
        console.error('Failed to update IMEI pool after set-imei:', poolErr);
      }
    }

    return new Response(JSON.stringify(result, null, 2), {
      status: skylineResponse.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });`;

if (!src.includes(PROXY_RETURN)) { console.error('Proxy return not found'); process.exit(1); }
src = src.replace(PROXY_RETURN, PROXY_RETURN_WITH_INTERCEPT);
console.log('Patch 2: added intercept in real skyline proxy handler');

// Write back with CRLF
fs.writeFileSync(filePath, src.replace(/\n/g, '\r\n'), 'utf8');
console.log('Done. File written.');
