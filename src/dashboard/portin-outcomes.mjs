// ATOMIC port-in history for the dashboard, read from atomic_portin_outcomes
// (written by details-finalizer and bulk-activator). Answers "why did this
// port-in fail?" with the carrier's own reason and when it was recorded.

const LIST_COLUMNS = 'id,sim_id,iccid,msisdn,outcome,source,carrier_code,carrier_reason_code,carrier_description,raw_response,recorded_at';
const LATEST_COLUMNS = 'sim_id,outcome,carrier_code,carrier_description,recorded_at';
const ID_CHUNK = 200;

async function getRows(env, path, fetchImpl) {
  const res = await fetchImpl(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Supabase GET atomic_portin_outcomes ${res.status}: ${await res.text().catch(() => '')}`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

// GET /api/sims/:id/portin-outcomes — newest first, at most 20 rows.
export async function handlePortinOutcomes(env, corsHeaders, simId, fetchImpl = fetch) {
  const headers = { ...corsHeaders, 'Content-Type': 'application/json' };
  try {
    const rows = await getRows(env, `atomic_portin_outcomes?select=${LIST_COLUMNS}&sim_id=eq.${encodeURIComponent(String(simId))}&order=recorded_at.desc,id.desc&limit=20`, fetchImpl);
    return new Response(JSON.stringify({ sim_id: Number(simId), outcomes: rows }), { headers });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error && error.message || error) }), { status: 502, headers });
  }
}

// sim_id -> newest outcome row, for the SIMs table badge. Only ATOMIC SIMs can
// have one, so callers pass just those ids. A failed lookup returns an empty
// map: the table still renders from the sims columns.
export async function loadLatestPortinOutcomes(env, simIds, fetchImpl = fetch) {
  const latest = new Map();
  const ids = [...new Set(simIds.filter(id => id != null))];
  try {
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const chunk = ids.slice(i, i + ID_CHUNK);
      const rows = await getRows(env, `atomic_portin_outcomes?select=${LATEST_COLUMNS}&sim_id=in.(${chunk.join(',')})&order=recorded_at.desc,id.desc&limit=5000`, fetchImpl);
      for (const row of rows) if (!latest.has(row.sim_id)) latest.set(row.sim_id, row);
    }
  } catch (error) {
    console.error(`[Dashboard] port-in outcomes lookup failed: ${error}`);
  }
  return latest;
}
