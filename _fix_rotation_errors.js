const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'dashboard', 'index.js');
let src = fs.readFileSync(filePath, 'utf8');

// Normalize to LF for patching
src = src.replace(/\r\n/g, '\n');

// --- Patch 1: handleErrors — add rotation error query and merge ---
const oldHandleErrors =
`    // Also get SIMs with last_activation_error (legacy errors)
    const simQuery = \`sims?select=id,iccid,port,status,last_activation_error,gateways(code),sim_numbers(e164)&last_activation_error=not.is.null&sim_numbers.valid_to=is.null&order=id.desc&limit=200\`;
    const simResponse = await supabaseGet(env, simQuery);
    const simErrors = await simResponse.json();

    // Convert SIM errors to unified format
    const legacyErrors = (Array.isArray(simErrors) ? simErrors : []).map(sim => ({
      id: \`sim_\${sim.id}\`,
      source: 'activation',
      action: 'activate',
      sim_id: sim.id,
      iccid: sim.iccid,
      error_message: sim.last_activation_error,
      error_details: null,
      severity: 'error',
      status: 'open',
      resolved_at: null,
      resolved_by: null,
      resolution_notes: null,
      created_at: null,
      phone_number: sim.sim_numbers?.[0]?.e164 || null,
      gateway_code: sim.gateways?.code || null,
      sim_status: sim.status,
      _legacy: true,
    }));

    // Merge: system_errors first, then legacy activation errors
    const sysFormatted = (Array.isArray(systemErrors) ? systemErrors : []).map(e => ({ ...e, _legacy: false }));
    const merged = [...sysFormatted, ...legacyErrors];`;

const newHandleErrors =
`    // Also get SIMs with last_activation_error (legacy errors)
    const simQuery = \`sims?select=id,iccid,port,status,last_activation_error,gateways(code),sim_numbers(e164)&last_activation_error=not.is.null&sim_numbers.valid_to=is.null&order=id.desc&limit=200\`;
    const simResponse = await supabaseGet(env, simQuery);
    const simErrors = await simResponse.json();

    // Also get SIMs with last_rotation_error
    const rotQuery = \`sims?select=id,iccid,port,status,last_rotation_error,last_rotation_at,gateways(code),sim_numbers(e164)&last_rotation_error=not.is.null&sim_numbers.valid_to=is.null&order=last_rotation_at.desc.nullslast&limit=200\`;
    const rotResponse = await supabaseGet(env, rotQuery);
    const rotErrors = await rotResponse.json();

    // Convert SIM errors to unified format
    const legacyErrors = (Array.isArray(simErrors) ? simErrors : []).map(sim => ({
      id: \`sim_\${sim.id}\`,
      source: 'activation',
      action: 'activate',
      sim_id: sim.id,
      iccid: sim.iccid,
      error_message: sim.last_activation_error,
      error_details: null,
      severity: 'error',
      status: 'open',
      resolved_at: null,
      resolved_by: null,
      resolution_notes: null,
      created_at: null,
      phone_number: sim.sim_numbers?.[0]?.e164 || null,
      gateway_code: sim.gateways?.code || null,
      sim_status: sim.status,
      _legacy: true,
    }));

    // Convert rotation errors to unified format
    const rotationErrors = (Array.isArray(rotErrors) ? rotErrors : []).map(sim => ({
      id: \`rot_\${sim.id}\`,
      source: 'rotation',
      action: 'rotate_mdn',
      sim_id: sim.id,
      iccid: sim.iccid,
      error_message: sim.last_rotation_error,
      error_details: null,
      severity: 'error',
      status: 'open',
      resolved_at: null,
      resolved_by: null,
      resolution_notes: null,
      created_at: sim.last_rotation_at || null,
      phone_number: sim.sim_numbers?.[0]?.e164 || null,
      gateway_code: sim.gateways?.code || null,
      sim_status: sim.status,
      _legacy: true,
    }));

    // Merge: system_errors first, then legacy activation errors, then rotation errors
    const sysFormatted = (Array.isArray(systemErrors) ? systemErrors : []).map(e => ({ ...e, _legacy: false }));
    const merged = [...sysFormatted, ...legacyErrors, ...rotationErrors];`;

if (!src.includes(oldHandleErrors)) {
  console.error('PATCH 1 FAILED: could not find handleErrors target');
  process.exit(1);
}
src = src.replace(oldHandleErrors, newHandleErrors);
console.log('Patch 1 applied: handleErrors rotation query');

// --- Patch 2: handleResolveError — handle rot_ prefixed IDs ---
const oldResolve =
`    // Filter out legacy sim_ IDs and handle them separately
    const systemIds = error_ids.filter(id => typeof id === 'number');
    const legacySimIds = error_ids.filter(id => typeof id === 'string' && id.startsWith('sim_')).map(id => parseInt(id.replace('sim_', '')));`;

const newResolve =
`    // Filter out legacy sim_ IDs and rotation rot_ IDs and handle them separately
    const systemIds = error_ids.filter(id => typeof id === 'number');
    const legacySimIds = error_ids.filter(id => typeof id === 'string' && id.startsWith('sim_')).map(id => parseInt(id.replace('sim_', '')));
    const rotationSimIds = error_ids.filter(id => typeof id === 'string' && id.startsWith('rot_')).map(id => parseInt(id.replace('rot_', '')));`;

if (!src.includes(oldResolve)) {
  console.error('PATCH 2 FAILED: could not find handleResolveError filter target');
  process.exit(1);
}
src = src.replace(oldResolve, newResolve);
console.log('Patch 2 applied: handleResolveError rot_ filter');

// --- Patch 3: handleResolveError — add rotation ID clear logic after legacy sim block ---
const oldClearActivation =
`    // Clear last_activation_error for legacy SIM errors
    if (legacySimIds.length > 0) {
      for (const simId of legacySimIds) {
        await fetch(\`\${env.SUPABASE_URL}/rest/v1/sims?id=eq.\${simId}\`, {
          method: 'PATCH',
          headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: \`Bearer \${env.SUPABASE_SERVICE_ROLE_KEY}\`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({ last_activation_error: null }),
        });
      }
    }

    return new Response(JSON.stringify({ ok: true, resolved: systemIds.length + legacySimIds.length }), {`;

const newClearActivation =
`    // Clear last_activation_error for legacy SIM errors
    if (legacySimIds.length > 0) {
      for (const simId of legacySimIds) {
        await fetch(\`\${env.SUPABASE_URL}/rest/v1/sims?id=eq.\${simId}\`, {
          method: 'PATCH',
          headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: \`Bearer \${env.SUPABASE_SERVICE_ROLE_KEY}\`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({ last_activation_error: null }),
        });
      }
    }

    // Clear last_rotation_error for rotation SIM errors
    if (rotationSimIds.length > 0) {
      for (const simId of rotationSimIds) {
        await fetch(\`\${env.SUPABASE_URL}/rest/v1/sims?id=eq.\${simId}\`, {
          method: 'PATCH',
          headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: \`Bearer \${env.SUPABASE_SERVICE_ROLE_KEY}\`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({ last_rotation_error: null }),
        });
      }
    }

    return new Response(JSON.stringify({ ok: true, resolved: systemIds.length + legacySimIds.length + rotationSimIds.length }), {`;

if (!src.includes(oldClearActivation)) {
  console.error('PATCH 3 FAILED: could not find handleResolveError clear block');
  process.exit(1);
}
src = src.replace(oldClearActivation, newClearActivation);
console.log('Patch 3 applied: handleResolveError rotation clear');

// Convert back to CRLF
src = src.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, src, 'utf8');
console.log('Done. File written with CRLF.');
