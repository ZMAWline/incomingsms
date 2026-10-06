// Billing uses the shared bounded transport. A rejected write must never
// become an apparently successful invoice download, rate change or import.
import { supabaseFetch } from '../../shared/fetch-timeout.mjs';
import { sbGet, sbGetAll, sbPost as post } from '../../shared/supabase-rest.mjs';
import { SupabaseError } from '../request.mjs';

export async function billingFetch(env, url, init) {
  const response = await supabaseFetch(env, url, init);
  if (!response.ok) throw new SupabaseError(response.status, await response.text());
  return response;
}

export function supabaseGet(env, path) {
  return sbGet(env, path, { raw: true });
}

export function supabaseGetAllArray(env, path) {
  return sbGetAll(env, path);
}

// Rate creation and bill imports need the inserted row's ID. PostgREST
// otherwise defaults to an empty body even when the insert succeeds.
export function sbPost(env, path, body) {
  return post(env, path, body, { prefer: 'return=representation' });
}
