/**
 * AT&T ATOMIC API Client
 * Single endpoint: POST https://solutionsatt-atomic.telgoo5.com:22712
 * Auth: Credentials in every request body (no OAuth)
 */

import { Env } from './types';
import { supabaseInsert } from './supabase';

const ATOMIC_PLAN_CODE = 'ATTNOVOICE';

interface AtomicSession {
    userName: string;
    token: string;
    pin: string;
}

interface AtomicResponse {
    wholeSaleApi: {
        session: { userName: string; timestamp?: string };
        wholeSaleResponse: {
            requestType: string;
            statusCode: string;
            description: string;
            Result?: {
                MSISDN?: string;
                status?: string;
                BAN?: string;
                attStatus?: string;
                activationDate?: string;
                [key: string]: any;
            };
            [key: string]: any;
        };
    };
}

function getSession(env: Env): AtomicSession {
    if (!env.ATOMIC_USERNAME || !env.ATOMIC_TOKEN || !env.ATOMIC_PIN) {
        throw new Error('ATOMIC credentials not configured');
    }
    return {
        userName: env.ATOMIC_USERNAME,
        token: env.ATOMIC_TOKEN,
        pin: env.ATOMIC_PIN,
    };
}

async function atomicRequest(
    env: Env,
    requestType: string,
    requestData: Record<string, any>,
    logContext: { runId: string; step: string; iccid?: string; imei?: string }
): Promise<AtomicResponse> {
    const url = env.ATOMIC_API_URL || 'https://solutionsatt-atomic.telgoo5.com:22712';
    const session = getSession(env);

    const requestBody = {
        wholeSaleApi: {
            session,
            wholeSaleRequest: {
                requestType,
                ...requestData,
            },
        },
    };

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
    });

    const responseText = await res.text();
    let json: AtomicResponse | null = null;
    try {
        json = JSON.parse(responseText);
    } catch {}

    // Log the API call
    await logCarrierApiCall(env, {
        run_id: logContext.runId,
        step: logContext.step,
        iccid: logContext.iccid || null,
        imei: logContext.imei || null,
        vendor: 'atomic',
        request_url: url,
        request_method: 'POST',
        request_body: requestBody,
        response_status: res.status,
        response_ok: res.ok,
        response_body_text: responseText,
        response_body_json: json,
        error: res.ok && json?.wholeSaleApi?.wholeSaleResponse?.statusCode === '00'
            ? null
            : `ATOMIC ${requestType} failed: ${json?.wholeSaleApi?.wholeSaleResponse?.description || res.status}`,
    });

    if (!res.ok) {
        throw new Error(`ATOMIC ${requestType} HTTP failed: ${res.status} ${responseText}`);
    }

    if (json?.wholeSaleApi?.wholeSaleResponse?.statusCode !== '00') {
        throw new Error(`ATOMIC ${requestType} failed: ${json?.wholeSaleApi?.wholeSaleResponse?.description || 'Unknown error'}`);
    }

    return json!;
}

/**
 * Activate a new subscriber
 */
export async function atomicActivate(
    env: Env,
    data: {
        iccid: string;
        imei: string;
        firstName: string;
        lastName: string;
        streetNumber: string;
        streetName: string;
        zip: string;
        partnerTransactionId?: string;
    },
    runId: string
): Promise<{ msisdn: string; ban: string; status: string }> {
    const response = await atomicRequest(env, 'Activate', {
        partnerTransactionId: data.partnerTransactionId || `act_${Date.now()}`,
        imei: data.imei,
        sim: data.iccid,
        eSim: 'N',
        EID: '',
        BAN: '',
        firstName: data.firstName,
        lastName: data.lastName,
        streetNumber: data.streetNumber,
        streetDirection: '',
        streetName: data.streetName,
        zip: data.zip,
        plan: ATOMIC_PLAN_CODE,
        portMdn: '',
    }, { runId, step: 'activate', iccid: data.iccid, imei: data.imei });

    const result = response.wholeSaleApi.wholeSaleResponse.Result;
    return {
        msisdn: result?.MSISDN || '',
        ban: result?.BAN || '',
        status: result?.status || '',
    };
}

/**
 * Subscriber inquiry - get details by MSISDN or SIM
 */
export async function atomicSubscriberInquiry(
    env: Env,
    data: { msisdn?: string; sim?: string },
    runId: string,
    iccid?: string
): Promise<any> {
    const response = await atomicRequest(env, 'subsriberInquiry', {
        MSISDN: data.msisdn || '',
        sim: data.sim || '',
    }, { runId, step: 'subscriber_inquiry', iccid });

    return response.wholeSaleApi.wholeSaleResponse;
}

/**
 * Suspend subscriber
 */
export async function atomicSuspend(
    env: Env,
    msisdn: string,
    runId: string,
    iccid?: string
): Promise<any> {
    return atomicRequest(env, 'suspendSubscriber', {
        MSISDN: msisdn,
        reasonCode: 'NPG',
    }, { runId, step: 'suspend', iccid });
}

/**
 * Restore suspended subscriber
 */
export async function atomicRestore(
    env: Env,
    msisdn: string,
    runId: string,
    iccid?: string
): Promise<any> {
    return atomicRequest(env, 'restoreSubscriber', {
        MSISDN: msisdn,
        reasonCode: 'CR',
    }, { runId, step: 'restore', iccid });
}

/**
 * Deactivate (cancel) subscriber
 */
export async function atomicDeactivate(
    env: Env,
    msisdn: string,
    runId: string,
    iccid?: string
): Promise<any> {
    return atomicRequest(env, 'deactivateSubscriber', {
        MSISDN: msisdn,
        reasonCode: 'DD',
    }, { runId, step: 'deactivate', iccid });
}

/**
 * Reconnect a deactivated subscriber
 */
export async function atomicReconnect(
    env: Env,
    msisdn: string,
    runId: string,
    iccid?: string
): Promise<any> {
    return atomicRequest(env, 'reconnectSubscriber', {
        MSISDN: msisdn,
        reasonCode: '',
    }, { runId, step: 'reconnect', iccid });
}

/**
 * Swap MSISDN (MDN change)
 * Note: New MDN area code based on ZIP currently associated with the MDN.
 * Update address first via atomicUpdateSubscriberInfo if targeting specific area code.
 */
export async function atomicSwapMsisdn(
    env: Env,
    msisdn: string,
    zipCode: string,
    runId: string,
    iccid?: string
): Promise<any> {
    return atomicRequest(env, 'swapMSISDN', {
        MSISDN: msisdn,
        zipCode,
    }, { runId, step: 'swap_msisdn', iccid });
}

/**
 * Update subscriber information (name/address)
 */
export async function atomicUpdateSubscriberInfo(
    env: Env,
    msisdn: string,
    data: {
        firstName?: string;
        lastName?: string;
        streetNumber?: string;
        streetName?: string;
        streetDirection?: string;
        zipCode?: string;
    },
    runId: string,
    iccid?: string
): Promise<any> {
    const requestData: Record<string, any> = { MSISDN: msisdn };

    if (data.firstName) requestData.firstName = data.firstName;
    if (data.lastName) requestData.lastName = data.lastName;
    if (data.streetNumber || data.streetName || data.zipCode) {
        requestData.address = {
            streetNumber: data.streetNumber || '',
            streetName: data.streetName || '',
            streetDirection: data.streetDirection || '',
            zipCode: data.zipCode || '',
        };
    }

    return atomicRequest(env, 'UpdateSubscriberInfo', requestData, {
        runId,
        step: 'update_subscriber_info',
        iccid,
    });
}

/**
 * Resend OTA profile
 */
export async function atomicResendOta(
    env: Env,
    msisdn: string,
    sim: string,
    runId: string
): Promise<any> {
    return atomicRequest(env, 'resendOtaProfile', {
        MSISDN: msisdn,
        sim,
    }, { runId, step: 'resend_ota', iccid: sim });
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
        console.warn('Failed to log ATOMIC API call:', e);
    }
}
