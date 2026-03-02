
import { Env } from './types';

export async function supabaseGet(env: Env, path: string): Promise<Response> {
    return fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
        method: "GET",
        headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
    });
}

export async function supabaseSelect<T = any>(env: Env, query: string): Promise<T[]> {
    const res = await supabaseGet(env, query);
    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Supabase select failed: ${res.status} ${txt}`);
    }
    return await res.json();
}

export async function supabaseInsert<T = any>(env: Env, table: string, rows: T[]): Promise<Response> {
    return fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
        method: "POST",
        headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
        },
        body: JSON.stringify(rows),
    });
}

export async function supabasePatch<T = any>(env: Env, query: string, updates: Partial<T>): Promise<Response> {
    return fetch(`${env.SUPABASE_URL}/rest/v1/${query}`, {
        method: "PATCH",
        headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
            Prefer: "return=representation",
        },
        body: JSON.stringify(updates),
    });
}
