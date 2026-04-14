/**
 * AT&T IoT API Client (Wing Tel)
 * Base URL: https://restapi19.att.com/rws/api/
 * Auth: Basic Auth header
 */

import { Env } from './types';
import { supabaseInsert } from './supabase';

// Communication plans
export const WING_DIALABLE_PLAN = 'Wing Tel Inc - NON ABIR SMS MO/MT US';
export const WING_NON_DIALABLE_PLAN = 'Wing Tel Inc - ABIR 25Mbps SMS MO/MT US';

interface WingDeviceResponse {
    iccid?: string;
    status?: string;
    communicationPlan?: string;
    mdn?: string;
    customer?: string;
    [key: string]: any;
}

function getAuthHeader(env: Env): string {
    if (!env.WING_IOT_USERNAME || !env.WING_IOT_API_KEY) {
        throw new Error('Wing IoT credentials not configured');
    }
    const credentials = `${env.WING_IOT_USERNAME}:${env.WING_IOT_API_KEY}`;
    return `Basic ${btoa(credentials)}`;
}

function getBaseUrl(env: Env): string {
    return env.WING_IOT_BASE_URL || 'https://restapi19.att.com/rws/api';
}

/**
 * Get device status and details
 */
export async function wingGetDevice(
    env: Env,
    iccid: string,
    runId: string
): Promise<WingDeviceResponse> {
    const baseUrl = getBaseUrl(env);
    const url = `${baseUrl}/api/v1/devices/${iccid}`;

    const res = await fetch(url, {
        method: 'GET',
        headers: {
            Authorization: getAuthHeader(env),
        },
    });

    const responseText = await res.text();
    let json: WingDeviceResponse | null = null;
    try {
        json = JSON.parse(responseText);
    } catch {}

    await logCarrierApiCall(env, {
        run_id: runId,
        step: 'get_device',
        iccid,
        vendor: 'wing_iot',
        request_url: url,
        request_method: 'GET',
        request_body: null,
        response_status: res.status,
        response_ok: res.ok,
        response_body_text: responseText,
        response_body_json: json,
        error: res.ok ? null : `Wing IoT GET failed: ${res.status}`,
    });

    if (!res.ok) {
        throw new Error(`Wing IoT GET device failed: ${res.status} ${responseText}`);
    }

    return json || {};
}

/**
 * Activate device with dialable MDN
 */
export async function wingActivateDevice(
    env: Env,
    iccid: string,
    runId: string
): Promise<WingDeviceResponse> {
    const baseUrl = getBaseUrl(env);
    const url = `${baseUrl}/api/v1/devices/${iccid}`;

    const requestBody = {
        communicationPlan: WING_DIALABLE_PLAN,
        status: 'Activated',
    };

    const res = await fetch(url, {
        method: 'PUT',
        headers: {
            Authorization: getAuthHeader(env),
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
    });

    const responseText = await res.text();
    let json: WingDeviceResponse | null = null;
    try {
        json = JSON.parse(responseText);
    } catch {}

    await logCarrierApiCall(env, {
        run_id: runId,
        step: 'activate_device',
        iccid,
        vendor: 'wing_iot',
        request_url: url,
        request_method: 'PUT',
        request_body: requestBody,
        response_status: res.status,
        response_ok: res.ok,
        response_body_text: responseText,
        response_body_json: json,
        error: res.ok ? null : `Wing IoT activate failed: ${res.status}`,
    });

    if (!res.ok) {
        throw new Error(`Wing IoT activate device failed: ${res.status} ${responseText}`);
    }

    // Verify activation with GET
    const device = await wingGetDevice(env, iccid, runId);
    if (device.status !== 'Activated') {
        throw new Error(`Wing IoT activation verification failed: status=${device.status}`);
    }

    return device;
}

/**
 * Change communication plan
 */
export async function wingChangePlan(
    env: Env,
    iccid: string,
    communicationPlan: string,
    runId: string
): Promise<WingDeviceResponse> {
    const baseUrl = getBaseUrl(env);
    const url = `${baseUrl}/api/v1/devices/${iccid}`;

    const requestBody = {
        communicationPlan,
    };

    const res = await fetch(url, {
        method: 'PUT',
        headers: {
            Authorization: getAuthHeader(env),
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
    });

    const responseText = await res.text();
    let json: WingDeviceResponse | null = null;
    try {
        json = JSON.parse(responseText);
    } catch {}

    await logCarrierApiCall(env, {
        run_id: runId,
        step: 'change_plan',
        iccid,
        vendor: 'wing_iot',
        request_url: url,
        request_method: 'PUT',
        request_body: requestBody,
        response_status: res.status,
        response_ok: res.ok,
        response_body_text: responseText,
        response_body_json: json,
        error: res.ok ? null : `Wing IoT plan change failed: ${res.status}`,
    });

    if (!res.ok) {
        throw new Error(`Wing IoT plan change failed: ${res.status} ${responseText}`);
    }

    return json || {};
}

/**
 * Rotate MDN by switching plans (dialable -> non-dialable -> dialable)
 * This causes AT&T to assign a new MDN when switching back to dialable
 */
export async function wingRotateMdn(
    env: Env,
    iccid: string,
    runId: string
): Promise<{ oldMdn?: string; newMdn?: string }> {
    // Get current MDN
    const before = await wingGetDevice(env, iccid, runId);
    const oldMdn = before.mdn;

    // Step 1: Switch to non-dialable plan
    await wingChangePlan(env, iccid, WING_NON_DIALABLE_PLAN, runId);

    // Small delay to allow plan change to propagate
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Verify non-dialable
    const midCheck = await wingGetDevice(env, iccid, runId);
    if (midCheck.communicationPlan !== WING_NON_DIALABLE_PLAN) {
        console.warn(`Wing IoT MDN rotation: expected non-dialable plan, got ${midCheck.communicationPlan}`);
    }

    // Step 2: Switch back to dialable plan (this assigns new MDN)
    await wingChangePlan(env, iccid, WING_DIALABLE_PLAN, runId);

    // Small delay
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Get new MDN
    const after = await wingGetDevice(env, iccid, runId);
    const newMdn = after.mdn;

    if (newMdn === oldMdn) {
        console.warn(`Wing IoT MDN rotation: MDN did not change (still ${oldMdn})`);
    }

    return { oldMdn, newMdn };
}

/**
 * Check if a SIM is pre-provisioned and ready for activation
 * Wing IoT SIMs must be pre-provisioned by Wing Tel before use
 */
export async function wingIsPreProvisioned(
    env: Env,
    iccid: string,
    runId: string
): Promise<boolean> {
    try {
        const device = await wingGetDevice(env, iccid, runId);
        // Ready if customer is blank and has the correct plan
        return device.customer === '' && device.communicationPlan === WING_DIALABLE_PLAN;
    } catch (e) {
        // Device not found or error = not provisioned
        return false;
    }
}

/**
 * Log carrier API call to carrier_api_logs table
 */
async function logCarrierApiCall(env: Env, log: {
    run_id: string;
    step: string;
    iccid?: string | null;
    imei?: string | null;
    vendor: string;
    request_url: string;
    request_method: string;
    request_body: any;
    response_status: number;
    response_ok: boolean;
    response_body_text: string;
    response_body_json: any;
    error: string | null;
}) {
    try {
        await supabaseInsert(env, 'carrier_api_logs', [{
            ...log,
            timestamp: new Date().toISOString(),
        }]);
    } catch (e) {
        console.warn('Failed to log Wing IoT API call:', e);
    }
}
