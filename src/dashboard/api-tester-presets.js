// Server-side preset registry for the API Tester.
//
// Single source of truth for each vendor call. The HTTP route surfaces
// `inputs` (only the variable fields the operator must fill) and calls
// `build({env, inputs, gateway, helixToken})` to produce the outbound
// request. Secrets and fixed defaults are injected here — never in the
// browser.

const ATOMIC_URL = (env) => env.ATOMIC_API_URL || 'https://solutionsatt-atomic.telgoo5.com:22712';

function atomicSession(env) {
  return { userName: env.ATOMIC_USERNAME, token: env.ATOMIC_TOKEN, pin: env.ATOMIC_PIN };
}

function txid() {
  // Build-time only; the server picks the timestamp at call time.
  return 'tx_' + Date.now();
}

function atomicBody(env, requestType, extra) {
  return {
    wholeSaleApi: {
      session: atomicSession(env),
      wholeSaleRequest: Object.assign({ requestType, partnerTransactionId: txid() }, extra || {}),
    },
  };
}

function atomicPost(env, body) {
  return {
    method: 'POST',
    url: ATOMIC_URL(env) + '/',
    headers: { 'Content-Type': 'application/json' },
    body,
  };
}

function wingHeaders(env, extra) {
  const auth = 'Basic ' + btoa(env.WING_IOT_USERNAME + ':' + env.WING_IOT_API_KEY);
  return Object.assign({ Authorization: auth, Accept: 'application/json' }, extra || {});
}

function wingUrl(env, iccid) {
  const base = env.WING_IOT_BASE_URL || 'https://restapi19.att.com/rws/api';
  return base + '/v1/devices/' + iccid;
}

function teltikQs(env, params) {
  const usp = new URLSearchParams();
  usp.set('apikey', env.TELTIK_API_KEY);
  Object.keys(params || {}).forEach((k) => {
    if (params[k] !== undefined && params[k] !== null && params[k] !== '') usp.set(k, params[k]);
  });
  return usp.toString();
}

function helixUrl(env, path) {
  return env.HX_API_BASE + path;
}

function helixHeaders(token, extra) {
  return Object.assign(
    { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    extra || {}
  );
}

function skylineBase(gateway) {
  return 'http://' + gateway.host + ':' + (gateway.api_port || 80);
}

function skylineCreds(gateway) {
  const usp = new URLSearchParams();
  usp.set('username', gateway.username || '');
  usp.set('password', gateway.password || '');
  return usp;
}

// --- input field shorthands ---
const inp = (name, label, opts) => Object.assign({ name, label, type: 'text', required: true }, opts || {});
const opt = (name, label, opts) => Object.assign({ name, label, type: 'text', required: false }, opts || {});
const gatewayPick = () => ({
  name: 'gateway_id',
  label: 'Gateway',
  type: 'select',
  required: true,
  source: 'gateways',
});

export const PRESETS = {
  // ─── ATOMIC ────────────────────────────────────────────────────────────────
  'atomic.activate': {
    vendor: 'atomic',
    label: 'Activate',
    inputs: [
      inp('iccid', 'ICCID'),
      inp('imei', 'IMEI'),
      opt('zip', 'ZIP', { default: '10001' }),
      opt('plan', 'Plan', { default: 'EBNOVOICE' }),
      opt('ban', 'BAN'),
      opt('portMdn', 'Port-in MDN'),
    ],
    build: ({ env, inputs }) => atomicPost(env, atomicBody(env, 'Activate', {
      imei: inputs.imei,
      sim: inputs.iccid,
      eSim: 'N',
      EID: '',
      BAN: inputs.ban || '',
      firstName: 'SUB',
      lastName: 'NINE',
      streetNumber: '123',
      streetDirection: '',
      streetName: 'Main St',
      zip: inputs.zip || '10001',
      plan: inputs.plan || 'EBNOVOICE',
      portMdn: inputs.portMdn || '',
    })),
  },
  'atomic.subscriberInquiry': {
    vendor: 'atomic',
    label: 'Subscriber Inquiry',
    inputs: [
      opt('iccid', 'ICCID'),
      opt('msisdn', 'MSISDN'),
    ],
    build: ({ env, inputs }) => atomicPost(env, atomicBody(env, 'subsriberInquiry', {
      MSISDN: inputs.msisdn || '',
      sim: inputs.iccid || '',
    })),
  },
  'atomic.suspend': {
    vendor: 'atomic',
    label: 'Suspend Subscriber',
    inputs: [inp('msisdn', 'MSISDN'), opt('reasonCode', 'Reason Code', { default: 'NPG' })],
    build: ({ env, inputs }) => atomicPost(env, atomicBody(env, 'suspendSubscriber', {
      MSISDN: inputs.msisdn,
      reasonCode: inputs.reasonCode || 'NPG',
    })),
  },
  'atomic.restore': {
    vendor: 'atomic',
    label: 'Restore Subscriber',
    inputs: [inp('msisdn', 'MSISDN'), opt('reasonCode', 'Reason Code', { default: 'CR' })],
    build: ({ env, inputs }) => atomicPost(env, atomicBody(env, 'restoreSubscriber', {
      MSISDN: inputs.msisdn,
      reasonCode: inputs.reasonCode || 'CR',
    })),
  },
  'atomic.deactivate': {
    vendor: 'atomic',
    label: 'Deactivate Subscriber',
    inputs: [inp('msisdn', 'MSISDN'), opt('reasonCode', 'Reason Code', { default: 'DD' })],
    build: ({ env, inputs }) => atomicPost(env, atomicBody(env, 'deactivateSubscriber', {
      MSISDN: inputs.msisdn,
      reasonCode: inputs.reasonCode || 'DD',
    })),
  },
  'atomic.reconnect': {
    vendor: 'atomic',
    label: 'Reconnect Subscriber',
    inputs: [inp('msisdn', 'MSISDN'), opt('reasonCode', 'Reason Code')],
    build: ({ env, inputs }) => atomicPost(env, atomicBody(env, 'reconnectSubscriber', {
      MSISDN: inputs.msisdn,
      reasonCode: inputs.reasonCode || '',
    })),
  },
  'atomic.swapMsisdn': {
    vendor: 'atomic',
    label: 'Swap MSISDN (MDN rotation)',
    inputs: [inp('msisdn', 'Current MSISDN'), opt('zipCode', 'ZIP', { default: '10001' })],
    build: ({ env, inputs }) => atomicPost(env, atomicBody(env, 'swapMSISDN', {
      MSISDN: inputs.msisdn,
      zipCode: inputs.zipCode || '10001',
    })),
  },
  'atomic.updateSubscriberInfo': {
    vendor: 'atomic',
    label: 'Update Subscriber Info',
    inputs: [
      inp('msisdn', 'MSISDN'),
      opt('firstName', 'First name', { default: 'SUB' }),
      opt('lastName', 'Last name', { default: 'NINE' }),
      opt('zipCode', 'ZIP', { default: '10001' }),
    ],
    build: ({ env, inputs }) => atomicPost(env, atomicBody(env, 'UpdateSubscriberInfo', {
      MSISDN: inputs.msisdn,
      firstName: inputs.firstName || 'SUB',
      lastName: inputs.lastName || 'NINE',
      address: {
        streetNumber: '123',
        streetName: 'Main St',
        streetDirection: '',
        zipCode: inputs.zipCode || '10001',
      },
    })),
  },
  'atomic.resendOta': {
    vendor: 'atomic',
    label: 'Resend OTA Profile',
    inputs: [inp('msisdn', 'MSISDN'), inp('iccid', 'ICCID')],
    build: ({ env, inputs }) => atomicPost(env, atomicBody(env, 'resendOtaProfile', {
      MSISDN: inputs.msisdn,
      sim: inputs.iccid,
    })),
  },

  // ─── Wing IoT ──────────────────────────────────────────────────────────────
  'wing.getDevice': {
    vendor: 'wing',
    label: 'Get Device (status/inquiry)',
    inputs: [inp('iccid', 'ICCID')],
    build: ({ env, inputs }) => ({
      method: 'GET',
      url: wingUrl(env, inputs.iccid),
      headers: wingHeaders(env),
      body: null,
    }),
  },
  'wing.activate': {
    vendor: 'wing',
    label: 'Activate Device',
    inputs: [inp('iccid', 'ICCID')],
    build: ({ env, inputs }) => ({
      method: 'PUT',
      url: wingUrl(env, inputs.iccid),
      headers: wingHeaders(env, { 'Content-Type': 'application/json' }),
      body: { communicationPlan: 'Wing Tel Inc - NON ABIR SMS MO/MT US', status: 'Activated' },
    }),
  },
  'wing.changePlanDialable': {
    vendor: 'wing',
    label: 'Change Plan → Dialable',
    inputs: [inp('iccid', 'ICCID')],
    build: ({ env, inputs }) => ({
      method: 'PUT',
      url: wingUrl(env, inputs.iccid),
      headers: wingHeaders(env, { 'Content-Type': 'application/json' }),
      body: { communicationPlan: 'Wing Tel Inc - DIALABLE SMS MO/MT US' },
    }),
  },
  'wing.changePlanNonDialable': {
    vendor: 'wing',
    label: 'Change Plan → Non-Dialable',
    inputs: [inp('iccid', 'ICCID')],
    build: ({ env, inputs }) => ({
      method: 'PUT',
      url: wingUrl(env, inputs.iccid),
      headers: wingHeaders(env, { 'Content-Type': 'application/json' }),
      body: { communicationPlan: 'Wing Tel Inc - NON ABIR SMS MO/MT US' },
    }),
  },

  // ─── Teltik (T-Mobile) ─────────────────────────────────────────────────────
  'teltik.allLines': {
    vendor: 'teltik',
    label: 'Get All Lines',
    inputs: [],
    build: ({ env }) => ({
      method: 'GET',
      url: 'https://api.smsgateway.xyz/v1/all-lines/?' + teltikQs(env, {}),
      headers: {},
      body: null,
    }),
  },
  'teltik.getInfo': {
    vendor: 'teltik',
    label: 'Get Info (by MDN)',
    inputs: [inp('mdn', 'MDN')],
    build: ({ env, inputs }) => ({
      method: 'GET',
      url: 'https://api.smsgateway.xyz/v1/get-info?' + teltikQs(env, { mdn: inputs.mdn }),
      headers: {},
      body: null,
    }),
  },
  'teltik.getPhoneNumber': {
    vendor: 'teltik',
    label: 'Get Phone Number (by ICCID)',
    inputs: [inp('iccid', 'ICCID')],
    build: ({ env, inputs }) => ({
      method: 'GET',
      url: 'https://api.smsgateway.xyz/v1/get-phone-number/?' + teltikQs(env, { iccid: inputs.iccid }),
      headers: {},
      body: null,
    }),
  },
  'teltik.changeNumber': {
    vendor: 'teltik',
    label: 'Change Number (MDN rotation)',
    inputs: [inp('iccid', 'ICCID')],
    build: ({ env, inputs }) => ({
      method: 'GET',
      url: 'https://api.smsgateway.xyz/v1/change-number/?' + teltikQs(env, { iccid: inputs.iccid }),
      headers: {},
      body: null,
    }),
  },
  'teltik.setForwardUrl': {
    vendor: 'teltik',
    label: 'Set Forward URL (webhook)',
    inputs: [inp('forward_url', 'Forward URL')],
    build: ({ env, inputs }) => ({
      method: 'POST',
      url: 'https://api.smsgateway.xyz/v1/forward-url?' + teltikQs(env, {}),
      headers: { 'Content-Type': 'application/json' },
      body: { forward_url: inputs.forward_url },
    }),
  },

  // ─── Helix (Bearer injected server-side) ───────────────────────────────────
  'helix.activate': {
    vendor: 'helix',
    label: 'Activate',
    needsHelixToken: true,
    inputs: [
      inp('iccid', 'ICCID'),
      inp('imei', 'IMEI'),
      opt('ban', 'BAN'),
      opt('fan', 'FAN'),
      opt('planId', 'Plan ID', { default: '0' }),
      opt('clientId', 'Client ID', { default: '0' }),
      opt('zipCode', 'ZIP', { default: '10001' }),
    ],
    build: ({ env, inputs, helixToken }) => ({
      method: 'POST',
      url: helixUrl(env, '/api/mobility-activation/activate'),
      headers: helixHeaders(helixToken),
      body: {
        clientId: parseInt(inputs.clientId || '0', 10),
        plan: { id: parseInt(inputs.planId || '0', 10) },
        BAN: inputs.ban || '',
        FAN: inputs.fan || '',
        activationType: 'new_activation',
        subscriber: { firstName: 'SUB', lastName: 'NINE' },
        address: { address1: '123 Main St', city: 'New York', state: 'NY', zipCode: inputs.zipCode || '10001' },
        service: { iccid: inputs.iccid, imei: inputs.imei },
      },
    }),
  },
  'helix.details': {
    vendor: 'helix',
    label: 'Subscriber Details',
    needsHelixToken: true,
    inputs: [inp('mobilitySubscriptionId', 'Subscription ID')],
    build: ({ env, inputs, helixToken }) => ({
      method: 'POST',
      url: helixUrl(env, '/api/mobility-subscriber/details'),
      headers: helixHeaders(helixToken),
      body: { mobilitySubscriptionId: inputs.mobilitySubscriptionId },
    }),
  },
  'helix.suspend': {
    vendor: 'helix',
    label: 'Status → Suspend',
    needsHelixToken: true,
    inputs: [inp('subscriberNumber', 'MDN'), inp('mobilitySubscriptionId', 'Subscription ID'), opt('reasonCode', 'Reason', { default: 'NPG' })],
    build: ({ env, inputs, helixToken }) => ({
      method: 'PATCH',
      url: helixUrl(env, '/api/mobility-subscriber/status'),
      headers: helixHeaders(helixToken),
      body: [{
        subscriberNumber: inputs.subscriberNumber,
        subscriberState: 'Suspend',
        reasonCode: inputs.reasonCode || 'NPG',
        reasonCodeId: 0,
        mobilitySubscriptionId: inputs.mobilitySubscriptionId,
      }],
    }),
  },
  'helix.unsuspend': {
    vendor: 'helix',
    label: 'Status → Unsuspend',
    needsHelixToken: true,
    inputs: [inp('subscriberNumber', 'MDN'), inp('mobilitySubscriptionId', 'Subscription ID'), opt('reasonCode', 'Reason', { default: 'CR' })],
    build: ({ env, inputs, helixToken }) => ({
      method: 'PATCH',
      url: helixUrl(env, '/api/mobility-subscriber/status'),
      headers: helixHeaders(helixToken),
      body: [{
        subscriberNumber: inputs.subscriberNumber,
        subscriberState: 'Unsuspend',
        reasonCode: inputs.reasonCode || 'CR',
        reasonCodeId: 0,
        mobilitySubscriptionId: inputs.mobilitySubscriptionId,
      }],
    }),
  },
  'helix.cancel': {
    vendor: 'helix',
    label: 'Status → Cancel',
    needsHelixToken: true,
    inputs: [inp('subscriberNumber', 'MDN'), inp('mobilitySubscriptionId', 'Subscription ID'), opt('reasonCode', 'Reason', { default: 'DD' })],
    build: ({ env, inputs, helixToken }) => ({
      method: 'PATCH',
      url: helixUrl(env, '/api/mobility-subscriber/status'),
      headers: helixHeaders(helixToken),
      body: [{
        subscriberNumber: inputs.subscriberNumber,
        subscriberState: 'Cancel',
        reasonCode: inputs.reasonCode || 'DD',
        reasonCodeId: 0,
        mobilitySubscriptionId: inputs.mobilitySubscriptionId,
      }],
    }),
  },
  'helix.resumeOnCancel': {
    vendor: 'helix',
    label: 'Status → Resume On Cancel',
    needsHelixToken: true,
    inputs: [inp('subscriberNumber', 'MDN'), inp('mobilitySubscriptionId', 'Subscription ID')],
    build: ({ env, inputs, helixToken }) => ({
      method: 'PATCH',
      url: helixUrl(env, '/api/mobility-subscriber/status'),
      headers: helixHeaders(helixToken),
      body: [{
        subscriberNumber: inputs.subscriberNumber,
        subscriberState: 'Resume On Cancel',
        reasonCode: '',
        reasonCodeId: 0,
        mobilitySubscriptionId: inputs.mobilitySubscriptionId,
      }],
    }),
  },
  'helix.ctn': {
    vendor: 'helix',
    label: 'CTN Swap (MDN rotation)',
    needsHelixToken: true,
    inputs: [inp('mobilitySubscriptionId', 'Subscription ID')],
    build: ({ env, inputs, helixToken }) => ({
      method: 'PATCH',
      url: helixUrl(env, '/api/mobility-subscriber/ctn'),
      headers: helixHeaders(helixToken),
      body: { mobilitySubscriptionId: inputs.mobilitySubscriptionId },
    }),
  },
  'helix.resetOta': {
    vendor: 'helix',
    label: 'OTA Refresh',
    needsHelixToken: true,
    inputs: [inp('ban', 'BAN'), inp('subscriberNumber', 'MDN'), inp('iccid', 'ICCID')],
    build: ({ env, inputs, helixToken }) => ({
      method: 'PATCH',
      url: helixUrl(env, '/api/mobility-subscriber/reset-ota'),
      headers: helixHeaders(helixToken),
      body: [{ ban: inputs.ban, subscriberNumber: inputs.subscriberNumber, iccid: inputs.iccid }],
    }),
  },
  'helix.plansByImei': {
    vendor: 'helix',
    label: 'Plans by IMEI',
    needsHelixToken: true,
    inputs: [inp('imei', 'IMEI'), opt('skuId', 'SKU ID', { default: '3' })],
    build: ({ env, inputs, helixToken }) => ({
      method: 'GET',
      url: helixUrl(env, '/api/plans-by-imei/' + encodeURIComponent(inputs.imei) +
        '?skuId=' + encodeURIComponent(inputs.skuId || '3') +
        '&resellerId=' + encodeURIComponent(env.HX_ACTIVATION_CLIENT_ID || '')),
      headers: { Authorization: 'Bearer ' + helixToken },
      body: null,
    }),
  },
  'helix.imeiPlan': {
    vendor: 'helix',
    label: 'IMEI Plan (sub-ops)',
    needsHelixToken: true,
    inputs: [inp('mobilitySubscriptionId', 'Subscription ID'), inp('imei', 'IMEI'), opt('planId', 'Plan ID', { default: '0' })],
    build: ({ env, inputs, helixToken }) => ({
      method: 'POST',
      url: helixUrl(env, '/api/mobility-sub-ops/imei-plan'),
      headers: helixHeaders(helixToken),
      body: {
        mobilitySubscriptionId: inputs.mobilitySubscriptionId,
        imei: inputs.imei,
        planId: parseInt(inputs.planId || '0', 10),
      },
    }),
  },

  // ─── Skyline gateway ───────────────────────────────────────────────────────
  'skyline.smsStat': {
    vendor: 'skyline',
    label: 'SMS Stats / Handshake',
    inputs: [gatewayPick()],
    build: ({ gateway }) => {
      const creds = skylineCreds(gateway);
      creds.set('version', '1.1');
      creds.set('ports', 'all');
      creds.set('type', '3');
      return { method: 'GET', url: skylineBase(gateway) + '/goip_get_sms_stat.html?' + creds.toString(), headers: {}, body: null };
    },
  },
  'skyline.status': {
    vendor: 'skyline',
    label: 'Port Status (ICCID/IMEI/signal)',
    inputs: [gatewayPick()],
    build: ({ gateway }) => {
      const creds = skylineCreds(gateway);
      creds.set('version', '1.1');
      creds.set('ports', 'all');
      creds.set('all_slots', '1');
      return { method: 'GET', url: skylineBase(gateway) + '/goip_get_status.html?' + creds.toString(), headers: {}, body: null };
    },
  },
  'skyline.sendSms': {
    vendor: 'skyline',
    label: 'Send SMS',
    inputs: [gatewayPick(), inp('port_num', 'Port (e.g. 1 or 1.01)'), inp('to', 'Destination MDN'), inp('text', 'Message', { default: 'Hello' })],
    build: ({ gateway, inputs }) => ({
      method: 'POST',
      url: skylineBase(gateway) + '/goip_post_sms.html?' + skylineCreds(gateway).toString(),
      headers: { 'Content-Type': 'application/json' },
      body: {
        type: 'send-sms', task_num: 1,
        tasks: [{ tid: 1, port: inputs.port_num, to: inputs.to, sms: inputs.text || 'Hello', smstype: 0, coding: 0 }],
      },
    }),
  },
  'skyline.switchSim': {
    vendor: 'skyline',
    label: 'Switch SIM (slot)',
    inputs: [gatewayPick(), inp('port_num', 'Port')],
    build: ({ gateway, inputs }) => ({
      method: 'POST',
      url: skylineBase(gateway) + '/goip_send_cmd.html?' + skylineCreds(gateway).toString(),
      headers: { 'Content-Type': 'application/json' },
      body: { type: 'command', op: 'switch', ports: inputs.port_num },
    }),
  },
  'skyline.setImei': {
    vendor: 'skyline',
    label: 'Set IMEI',
    inputs: [gatewayPick(), inp('slot_index', 'Slot index (N)'), inp('imei', 'IMEI')],
    build: ({ gateway, inputs }) => {
      const creds = skylineCreds(gateway);
      creds.set('op', 'set');
      return {
        method: 'POST',
        url: skylineBase(gateway) + '/goip_send_cmd.html?' + creds.toString(),
        headers: { 'Content-Type': 'text/plain' },
        body: 'sim_imei(' + inputs.slot_index + ')=' + inputs.imei,
      };
    },
  },
  'skyline.saveConfig': {
    vendor: 'skyline',
    label: 'Save Config (flash)',
    inputs: [gatewayPick()],
    build: ({ gateway }) => ({
      method: 'POST',
      url: skylineBase(gateway) + '/goip_send_cmd.html?' + skylineCreds(gateway).toString(),
      headers: { 'Content-Type': 'application/json' },
      body: { type: 'command', op: 'save' },
    }),
  },
  'skyline.lock': {
    vendor: 'skyline', label: 'Port: Lock',
    inputs: [gatewayPick(), inp('port_num', 'Port')],
    build: ({ gateway, inputs }) => ({
      method: 'POST',
      url: skylineBase(gateway) + '/goip_send_cmd.html?' + skylineCreds(gateway).toString(),
      headers: { 'Content-Type': 'application/json' },
      body: { type: 'command', op: 'lock', ports: inputs.port_num },
    }),
  },
  'skyline.unlock': {
    vendor: 'skyline', label: 'Port: Unlock',
    inputs: [gatewayPick(), inp('port_num', 'Port')],
    build: ({ gateway, inputs }) => ({
      method: 'POST',
      url: skylineBase(gateway) + '/goip_send_cmd.html?' + skylineCreds(gateway).toString(),
      headers: { 'Content-Type': 'application/json' },
      body: { type: 'command', op: 'unlock', ports: inputs.port_num },
    }),
  },
  'skyline.reboot': {
    vendor: 'skyline', label: 'Port: Reboot',
    inputs: [gatewayPick(), inp('port_num', 'Port')],
    build: ({ gateway, inputs }) => ({
      method: 'POST',
      url: skylineBase(gateway) + '/goip_send_cmd.html?' + skylineCreds(gateway).toString(),
      headers: { 'Content-Type': 'application/json' },
      body: { type: 'command', op: 'reboot', ports: inputs.port_num },
    }),
  },
  'skyline.reset': {
    vendor: 'skyline', label: 'Port: Reset',
    inputs: [gatewayPick(), inp('port_num', 'Port')],
    build: ({ gateway, inputs }) => ({
      method: 'POST',
      url: skylineBase(gateway) + '/goip_send_cmd.html?' + skylineCreds(gateway).toString(),
      headers: { 'Content-Type': 'application/json' },
      body: { type: 'command', op: 'reset', ports: inputs.port_num },
    }),
  },
};

const STATE_CHANGING_RE = /\b(suspend|deactivate|cancel|reset|reboot|change|swap|activate|switch|unsuspend|restore|reconnect|setImei|saveConfig|lock|unlock|setForwardUrl|imeiPlan|resetOta|ctn|resendOta)\b/i;

export function isStateChanging(key) {
  return STATE_CHANGING_RE.test(key);
}

export function listPresetsForClient() {
  // Returns the registry projected for the client — no `build`, no secrets.
  return Object.keys(PRESETS).map((key) => {
    const p = PRESETS[key];
    return {
      key,
      vendor: p.vendor,
      label: p.label,
      stateChanging: isStateChanging(key),
      inputs: (p.inputs || []).map((i) => ({
        name: i.name,
        label: i.label,
        type: i.type,
        required: !!i.required,
        source: i.source || null,
        default: i.default || '',
      })),
    };
  });
}
