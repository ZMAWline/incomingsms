// _fix_recompute_paginate.js
// Replace per-row PATCH loop in handleBillAuditRecompute with paginated fetch + bulk upsert,
// to avoid (a) PostgREST 1000-row cap on reads, (b) Cloudflare subrequest cap on writes.
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// Replace the line-fetch (limit=10000 trap)
const FETCH_OLD = "            const lines = await sbGet(env, `bill_audit_lines?upload_id=eq.${upload.id}&order=id.asc&limit=10000`) || [];";
const FETCH_NEW = "            const lines = await supabaseGetAllArray(env, `bill_audit_lines?upload_id=eq.${upload.id}&order=id.asc`) || [];";
if (!content.includes(FETCH_OLD)) { console.error('PATCH FAILED: fetch line not found'); process.exit(1); }
content = content.replace(FETCH_OLD, FETCH_NEW);

// Replace per-row PATCH loop with bulk upsert (one POST per ~500-row chunk).
const LOOP_OLD =
`            // Persist line-level updates (one PATCH per line — simple and small N)
            for (const r of updated) {
                await sbPatch(env, \`bill_audit_lines?id=eq.\${r.id}\`, {
                    sim_id: r.sim_id,
                    sim_status: r.sim_status,
                    discrepancy_type: r.discrepancy_type,
                    discrepancy_detail: r.discrepancy_detail,
                    expected_price: r.expected_price,
                });
            }`;

const LOOP_NEW =
`            // Bulk upsert in chunks (avoids CF subrequest cap and PostgREST 1000-row read cap)
            const upsertRows = updated.map(r => ({
                id: r.id,
                upload_id: r.upload_id,
                vendor: r.vendor,
                subscription_iccid: r.subscription_iccid,
                bypassed_plan_id: r.bypassed_plan_id,
                price: r.price,
                from_date: r.from_date,
                to_date: r.to_date,
                wing_id: r.wing_id,
                item_type: r.item_type,
                description: r.description,
                subscription_name: r.subscription_name,
                subscription_identifier: r.subscription_identifier,
                carrier: r.carrier,
                sim_id: r.sim_id,
                sim_status: r.sim_status,
                discrepancy_type: r.discrepancy_type,
                discrepancy_detail: r.discrepancy_detail,
                expected_price: r.expected_price,
            }));
            for (let i = 0; i < upsertRows.length; i += 500) {
                const batch = upsertRows.slice(i, i + 500);
                await fetch(\`\${env.SUPABASE_URL}/rest/v1/bill_audit_lines?on_conflict=id\`, {
                    method: 'POST',
                    headers: {
                        'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
                        'Authorization': \`Bearer \${env.SUPABASE_SERVICE_ROLE_KEY}\`,
                        'Content-Type': 'application/json',
                        'Prefer': 'resolution=merge-duplicates,return=minimal',
                    },
                    body: JSON.stringify(batch),
                });
            }`;

if (!content.includes(LOOP_OLD)) { console.error('PATCH FAILED: per-row PATCH loop not found'); process.exit(1); }
content = content.replace(LOOP_OLD, LOOP_NEW);

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Recompute pagination patch applied.');
