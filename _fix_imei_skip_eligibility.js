// _fix_imei_skip_eligibility.js
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');

content = content.replace(/\r\n/g, '\n');

const OLD = `      // Eligibility gate: check each IMEI before adding
      const rejectedIneligible = [];
      const eligible = [];
      if (env.MDN_ROTATOR && env.ADMIN_RUN_SECRET) {
        for (const candidate of toAdd) {
          try {
            const checkUrl = 'https://mdn-rotator/check-imei?secret=' + encodeURIComponent(env.ADMIN_RUN_SECRET) + '&imei=' + encodeURIComponent(candidate.imei);
            const checkRes = await env.MDN_ROTATOR.fetch(checkUrl, { method: 'GET' });
            const checkData = checkRes.ok ? await checkRes.json().catch(() => ({})) : {};
            if (checkData.eligible === true) {
              eligible.push(candidate);
            } else {
              rejectedIneligible.push({ imei: candidate.imei, reason: checkData.result ? JSON.stringify(checkData.result).slice(0, 200) : 'Not eligible for carrier/plan' });
            }
          } catch (eligErr) {
            // On check error, allow the IMEI (do not block on Helix errors)
            console.error('[IMEI Add] Eligibility check error for ' + candidate.imei + ': ' + eligErr);
            eligible.push(candidate);
          }
        }
      } else {
        // No MDN_ROTATOR binding — skip eligibility check
        eligible.push(...toAdd);
      }

      let added = 0;
      if (eligible.length > 0) {
        const addInsertRes = await fetch(\`\${env.SUPABASE_URL}/rest/v1/imei_pool?on_conflict=imei\`, {
          method: 'POST',
          headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: \`Bearer \${env.SUPABASE_SERVICE_ROLE_KEY}\`,
            'Content-Type': 'application/json',
            Prefer: 'resolution=ignore-duplicates,return=representation',
          },
          body: JSON.stringify(eligible),
        });`;

const NEW = `      let added = 0;
      if (toAdd.length > 0) {
        const addInsertRes = await fetch(\`\${env.SUPABASE_URL}/rest/v1/imei_pool?on_conflict=imei\`, {
          method: 'POST',
          headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: \`Bearer \${env.SUPABASE_SERVICE_ROLE_KEY}\`,
            'Content-Type': 'application/json',
            Prefer: 'resolution=ignore-duplicates,return=representation',
          },
          body: JSON.stringify(toAdd),
        });`;

if (!content.includes(OLD)) {
  console.error('PATCH FAILED: old string not found. File may have changed.');
  process.exit(1);
}

content = content.replace(OLD, NEW);

// Also fix the response to remove rejected_ineligible reference
const OLD2 = `        added = Array.isArray(addInserted) ? addInserted.length : 0;
      }

      return new Response(JSON.stringify({
        ok: true,
        added,
        duplicates: dupCount,
        invalid: invalid.length,
        rejected_retired: rejectedRetired,
        rejected_ineligible: rejectedIneligible || [],
      })`;

const NEW2 = `        added = Array.isArray(addInserted) ? addInserted.length : 0;
      }

      return new Response(JSON.stringify({
        ok: true,
        added,
        duplicates: dupCount,
        invalid: invalid.length,
        rejected_retired: rejectedRetired,
      })`;

if (!content.includes(OLD2)) {
  console.error('PATCH FAILED: old2 string not found.');
  process.exit(1);
}

content = content.replace(OLD2, NEW2);

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied successfully.');
