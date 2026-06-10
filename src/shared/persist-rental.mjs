// =========================================================
// persist-rental.mjs
// Translates a successful `number.online` webhook delivery into a rentals row.
//
// Why this exists (incident 2026-06-10):
//   The mdn-rotator / details-finalizer / reseller-sync workers all logged
//   delivered number.online webhooks with the reseller's rentalId in
//   webhook_deliveries.response_body, but none of them ever wrote that
//   rentalId into the canonical `rentals` table. Result: rentals stopped
//   being written after the 2026-05-29 batch backfill, and reports 135–139
//   escalated as `intake_unresolved_current_mdn_no_rental` even though we
//   already had the rentalId in webhook_deliveries.
//
// Live `rentals` schema (verified 2026-06-10 via Mgmt API):
//   id BIGSERIAL PK
//   reseller_id BIGINT NOT NULL FK→resellers
//   sim_id      BIGINT NOT NULL FK→sims
//   sim_number_id BIGINT NOT NULL FK→sim_numbers
//   carrier     TEXT NOT NULL CHECK (carrier IN ('att','tmobile'))
//   e164        TEXT
//   reseller_rental_id TEXT
//   rental_date DATE NOT NULL
//   minted_at   TIMESTAMPTZ NOT NULL DEFAULT now()
//   updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
//   UNIQUE (reseller_id, sim_number_id)  -- our idempotency key
// =========================================================

export function parseRentalIdFromResponse(body) {
  if (!body) return null;
  const s = String(body);
  try {
    const obj = JSON.parse(s);
    const v = obj && (obj.rentalId ?? obj.rental_id ?? obj.id);
    if (v != null) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch {}
  const m = s.match(/"rental[_]?[Ii]d"\s*:\s*([0-9]+)/);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function normalizeCarrier(raw) {
  if (raw == null) return null;
  const v = String(raw).trim().toLowerCase();
  if (v === 'att' || v === 'at&t' || v === 'at_t') return 'att';
  if (v === 'tmobile' || v === 't-mobile' || v === 'tmo') return 'tmobile';
  return null;
}

function isoDateOnly(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

export function buildRentalUpsertBody({ payload, responseBody, resellerId, sim, simNumber, deliveredAt }) {
  if (!payload || payload.event_type !== 'number.online') return null;
  const rentalId = parseRentalIdFromResponse(responseBody);
  if (rentalId == null) return null;
  if (!simNumber || simNumber.id == null) return null;
  if (!resellerId) return null;

  const carrier =
    normalizeCarrier(sim?.carrier) ||
    normalizeCarrier(payload?.data?.carrier) ||
    null;
  if (!carrier) return null;

  const e164 = payload?.data?.number || simNumber.e164 || null;
  const simId = sim?.id ?? Number(payload?.data?.sim_id);
  if (!simId) return null;

  return {
    reseller_id: Number(resellerId),
    sim_id: Number(simId),
    sim_number_id: Number(simNumber.id),
    carrier,
    e164,
    reseller_rental_id: String(rentalId),
    rental_date: isoDateOnly(deliveredAt),
  };
}

// Convenience: fetch the SIM row (for canonical carrier) + the sim_numbers row
// that owns this e164. Uses caller-supplied fetchImpl so tests can stub.
async function resolveSimAndNumber({ env, simId, e164, deliveredAt, fetchImpl }) {
  const f = fetchImpl || fetch;
  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  };

  const simRes = await f(
    `${env.SUPABASE_URL}/rest/v1/sims?select=id,carrier,vendor&id=eq.${encodeURIComponent(String(simId))}&limit=1`,
    { headers }
  );
  const simRows = simRes.ok ? await simRes.json() : [];
  const sim = Array.isArray(simRows) && simRows[0] ? simRows[0] : null;

  // Pick the sim_numbers row whose [valid_from, valid_to) window covers
  // deliveredAt. Most-common case: valid_to IS NULL and valid_from <= deliveredAt.
  // For backfill of historical rows we may pick a closed window — fine because
  // each rotation creates a brand-new sim_numbers id.
  const t = deliveredAt || new Date().toISOString();
  const tEnc = encodeURIComponent(t);
  const e164Enc = encodeURIComponent(e164);
  const numQ =
    `sim_numbers?select=id,sim_id,e164,valid_from,valid_to` +
    `&sim_id=eq.${encodeURIComponent(String(simId))}` +
    `&e164=eq.${e164Enc}` +
    `&valid_from=lte.${tEnc}` +
    `&or=(valid_to.is.null,valid_to.gte.${tEnc})` +
    `&order=valid_from.desc&limit=1`;
  const numRes = await f(`${env.SUPABASE_URL}/rest/v1/${numQ}`, { headers });
  let numRows = numRes.ok ? await numRes.json() : [];
  let simNumber = Array.isArray(numRows) && numRows[0] ? numRows[0] : null;

  if (!simNumber) {
    // Fallback: same sim_id + e164, current window (valid_to IS NULL).
    const fallback =
      `sim_numbers?select=id,sim_id,e164,valid_from,valid_to` +
      `&sim_id=eq.${encodeURIComponent(String(simId))}` +
      `&e164=eq.${e164Enc}` +
      `&valid_to=is.null&limit=1`;
    const fb = await f(`${env.SUPABASE_URL}/rest/v1/${fallback}`, { headers });
    numRows = fb.ok ? await fb.json() : [];
    simNumber = Array.isArray(numRows) && numRows[0] ? numRows[0] : null;
  }

  return { sim, simNumber };
}

export async function persistRentalFromWebhookResponse({
  env,
  payload,
  responseBody,
  resellerId,
  deliveredAt,
  fetchImpl,
}) {
  const f = fetchImpl || fetch;

  if (!payload || payload.event_type !== 'number.online') {
    return { ok: true, upserted: false, reason: 'not_number_online' };
  }
  const rentalId = parseRentalIdFromResponse(responseBody);
  if (rentalId == null) {
    return { ok: true, upserted: false, reason: 'no_rental_id_in_response' };
  }
  if (!resellerId) {
    return { ok: true, upserted: false, reason: 'no_reseller_id' };
  }

  const simId = Number(payload?.data?.sim_id);
  const e164 = payload?.data?.number;
  if (!simId || !e164) {
    return { ok: true, upserted: false, reason: 'missing_sim_id_or_number_in_payload' };
  }

  const { sim, simNumber } = await resolveSimAndNumber({
    env, simId, e164, deliveredAt, fetchImpl: f,
  });

  if (!simNumber) {
    return { ok: true, upserted: false, reason: 'sim_number_not_found' };
  }

  const body = buildRentalUpsertBody({
    payload, responseBody, resellerId, sim, simNumber, deliveredAt,
  });
  if (!body) {
    return { ok: true, upserted: false, reason: 'unmappable' };
  }

  // Upsert with on_conflict=reseller_id,sim_number_id so a second delivery for
  // the same (reseller, current-number) is idempotent. updated_at is bumped via
  // an explicit value rather than relying on a DB trigger (the schema has no
  // BEFORE UPDATE trigger; default now() only fires on INSERT).
  const upsertUrl =
    `${env.SUPABASE_URL}/rest/v1/rentals?on_conflict=reseller_id,sim_number_id`;
  const res = await f(upsertUrl, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({ ...body, updated_at: new Date().toISOString() }),
  });

  if (!res.ok) {
    let errText = '';
    try { errText = await res.text(); } catch {}
    return {
      ok: false,
      upserted: false,
      reason: 'upsert_http_error',
      status: res.status,
      error: errText.slice(0, 500),
      rentalContext: body,
    };
  }

  return { ok: true, upserted: true, rentalContext: body };
}
