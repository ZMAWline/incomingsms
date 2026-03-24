
import { Env } from './types';
import { supabaseInsert } from './supabase';

const TOKEN_CACHE_KEY = "helix_token";

function relayFetch(env: Env, url: string, init?: RequestInit): Promise<Response> {
    if (env.RELAY_URL && env.RELAY_KEY) {
        return fetch(`${env.RELAY_URL}/${url}`, {
            ...init,
            headers: {
                ...(init?.headers as Record<string, string> || {}),
                'x-relay-key': env.RELAY_KEY,
            },
        });
    }
    return fetch(url, init);
}
const TOKEN_TTL_SECONDS = 1800; // 30 minutes

export async function getCachedToken(env: Env): Promise<string> {
    // Try to get cached token from KV
    if (env.TOKEN_CACHE) {
        const cached = await env.TOKEN_CACHE.get(TOKEN_CACHE_KEY);
        if (cached) {
            console.log("Using cached Helix token");
            return cached;
        }
    }

    // Fetch new token
    console.log("Fetching new Helix token");
    const token = await hxGetBearerToken(env);

    // Cache the token in KV
    if (env.TOKEN_CACHE) {
        await env.TOKEN_CACHE.put(TOKEN_CACHE_KEY, token, { expirationTtl: TOKEN_TTL_SECONDS });
    }

    return token;
}

export async function hxGetBearerToken(env: Env): Promise<string> {
    if (!env.HX_TOKEN_URL) throw new Error("HX_TOKEN_URL not configured");

    const res = await relayFetch(env, env.HX_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            grant_type: "password",
            client_id: env.HX_CLIENT_ID,
            audience: env.HX_AUDIENCE,
            username: env.HX_GRANT_USERNAME,
            password: env.HX_GRANT_PASSWORD,
        }),
    });

    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) {
        throw new Error(`Token failed: ${res.status} ${JSON.stringify(json)}`);
    }
    return json.access_token;
}

export async function hxMdnChange(env: Env, token: string, mobilitySubscriptionId: string, runId: string, iccid: string): Promise<any> {
    const url = `${env.HX_API_BASE}/api/mobility-subscriber/ctn`;
    const method = "PATCH";
    const requestBody = { mobilitySubscriptionId };

    const res = await relayFetch(env, url, {
        method,
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(requestBody),
    });

    const responseText = await res.text();
    let json = {};
    try {
        json = JSON.parse(responseText);
    } catch { }

    // Log the API call
    await logHelixApiCall(env, {
        run_id: runId,
        step: "mdn_change",
        iccid,
        request_url: url,
        request_method: method,
        request_body: requestBody,
        response_status: res.status,
        response_ok: res.ok,
        response_body_text: responseText,
        response_body_json: json,
        error: res.ok ? null : `MDN change failed: ${res.status}`,
    });

    if (!res.ok) {
        throw new Error(`MDN change failed: ${res.status} ${JSON.stringify(json)}`);
    }
    return json;
}

export async function hxSubscriberDetails(env: Env, token: string, mobilitySubscriptionId: string, runId: string, iccid: string) {
    const url = `${env.HX_API_BASE}/api/mobility-subscriber/details`;
    const method = "POST";
    const requestBody = { mobilitySubscriptionId };

    const res = await relayFetch(env, url, {
        method,
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(requestBody),
    });

    const responseText = await res.text();
    let json: any = {};
    try {
        json = JSON.parse(responseText);
    } catch { }

    await logHelixApiCall(env, {
        run_id: runId,
        step: "subscriber_details",
        iccid,
        request_url: url,
        request_method: method,
        request_body: requestBody,
        response_status: res.status,
        response_ok: res.ok,
        response_body_text: responseText,
        response_body_json: json,
        error: res.ok ? null : `Details failed: ${res.status}`,
    });

    if (!res.ok) {
        throw new Error(`Details failed: ${res.status} ${JSON.stringify(json)}`);
    }
    return json;
}

export async function hxOtaRefresh(env: Env, token: string, data: { ban: string; subscriberNumber: string; iccid: string }, runId: string, iccid: string) {
    const url = `${env.HX_API_BASE}/api/mobility-subscriber/reset-ota`;
    const method = "PATCH";
    const requestBody = [
        {
            ban: data.ban,
            subscriberNumber: data.subscriberNumber,
            iccid: data.iccid
        }
    ];

    const res = await relayFetch(env, url, {
        method,
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(requestBody)
    });

    const responseText = await res.text();
    let json = {};
    try {
        json = JSON.parse(responseText);
    } catch { }

    await logHelixApiCall(env, {
        run_id: runId,
        step: "ota_refresh",
        iccid,
        request_url: url,
        request_method: method,
        request_body: requestBody,
        response_status: res.status,
        response_ok: res.ok,
        response_body_text: responseText,
        response_body_json: json,
        error: res.ok ? null : `OTA Refresh failed: ${res.status}`
    });

    if (!res.ok) {
        throw new Error(`OTA Refresh failed: ${res.status} ${JSON.stringify(json)}`);
    }
    return json;
}

export async function hxChangeSubscriberStatus(env: Env, token: string, data: any, runId: string, iccid: string, stepName: string = "change_status") {
    const url = `${env.HX_API_BASE}/api/mobility-subscriber/status`;
    const method = "PATCH";
    // Wrap in array if not already an array, and remove mobilitySubscriptionId
    const cleanData = Array.isArray(data) ? data : [data];
    const requestBody = cleanData.map(item => {
        const { mobilitySubscriptionId, ...rest } = item;
        return rest;
    });

    const res = await relayFetch(env, url, {
        method,
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(requestBody)
    });

    const responseText = await res.text();
    let json = {};
    try {
        json = JSON.parse(responseText);
    } catch { }

    await logHelixApiCall(env, {
        run_id: runId,
        step: stepName,
        iccid,
        request_url: url,
        request_method: method,
        request_body: requestBody,
        response_status: res.status,
        response_ok: res.ok,
        response_body_text: responseText,
        response_body_json: json,
        error: res.ok ? null : `Status change failed: ${res.status}`
    });

    if (!res.ok) {
        throw new Error(`Status change failed: ${res.status} ${JSON.stringify(json)}`);
    }
    return json;
}


async function logHelixApiCall(env: Env, log: any) {
    // Fire and forget log insertion
    try {
        await supabaseInsert(env, 'helix_api_logs', [{
            ...log,
            timestamp: new Date().toISOString(),
        }]);
    } catch (e) {
        console.warn("Failed to log Helix API call:", e);
    }
}
