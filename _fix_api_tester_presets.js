// Expand API Tester with comprehensive per-vendor presets.
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// ── 1) Replace dropdown options with vendor-grouped optgroups ─────────────
const OLD_OPTS =
  '                            <select id="api-tester-preset" onchange="applyApiPreset()" class="w-full text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 focus:outline-none focus:border-accent">\n' +
  '                                <option value="">&#8212; Custom &#8212;</option>\n' +
  '                                <option value="atomic">ATOMIC (AT&amp;T)</option>\n' +
  '                                <option value="wing">Wing IoT (AT&amp;T)</option>\n' +
  '                                <option value="teltik">Teltik (T-Mobile)</option>\n' +
  '                                <option value="helix">Helix (AT&amp;T, legacy)</option>\n' +
  '                            </select>';

const NEW_OPTS =
  '                            <select id="api-tester-preset" onchange="applyApiPreset()" class="w-full text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 focus:outline-none focus:border-accent">\n' +
  '                                <option value="">&#8212; Custom &#8212;</option>\n' +
  '                                <optgroup label="ATOMIC (AT&amp;T)">\n' +
  '                                    <option value="atomic.activate">Activate</option>\n' +
  '                                    <option value="atomic.subscriberInquiry">Subscriber Inquiry</option>\n' +
  '                                    <option value="atomic.suspend">Suspend Subscriber</option>\n' +
  '                                    <option value="atomic.restore">Restore Subscriber</option>\n' +
  '                                    <option value="atomic.deactivate">Deactivate Subscriber</option>\n' +
  '                                    <option value="atomic.reconnect">Reconnect Subscriber</option>\n' +
  '                                    <option value="atomic.swapMsisdn">Swap MSISDN (MDN rotation)</option>\n' +
  '                                    <option value="atomic.updateSubscriberInfo">Update Subscriber Info</option>\n' +
  '                                    <option value="atomic.resendOta">Resend OTA Profile</option>\n' +
  '                                </optgroup>\n' +
  '                                <optgroup label="Wing IoT (AT&amp;T)">\n' +
  '                                    <option value="wing.getDevice">Get Device (status/inquiry)</option>\n' +
  '                                    <option value="wing.activate">Activate Device</option>\n' +
  '                                    <option value="wing.changePlanDialable">Change Plan &rarr; Dialable</option>\n' +
  '                                    <option value="wing.changePlanNonDialable">Change Plan &rarr; Non-Dialable</option>\n' +
  '                                </optgroup>\n' +
  '                                <optgroup label="Teltik (T-Mobile)">\n' +
  '                                    <option value="teltik.allLines">Get All Lines</option>\n' +
  '                                    <option value="teltik.getInfo">Get Info (by MDN)</option>\n' +
  '                                    <option value="teltik.getPhoneNumber">Get Phone Number (by ICCID)</option>\n' +
  '                                    <option value="teltik.changeNumber">Change Number (MDN rotation)</option>\n' +
  '                                    <option value="teltik.setForwardUrl">Set Forward URL (webhook)</option>\n' +
  '                                </optgroup>\n' +
  '                                <optgroup label="Helix (legacy)">\n' +
  '                                    <option value="helix.token">Get Bearer Token</option>\n' +
  '                                    <option value="helix.activate">Activate</option>\n' +
  '                                    <option value="helix.details">Subscriber Details</option>\n' +
  '                                    <option value="helix.suspend">Status &rarr; Suspend</option>\n' +
  '                                    <option value="helix.unsuspend">Status &rarr; Unsuspend</option>\n' +
  '                                    <option value="helix.cancel">Status &rarr; Cancel</option>\n' +
  '                                    <option value="helix.resumeOnCancel">Status &rarr; Resume On Cancel</option>\n' +
  '                                    <option value="helix.ctn">CTN Swap (MDN rotation)</option>\n' +
  '                                    <option value="helix.resetOta">OTA Refresh</option>\n' +
  '                                    <option value="helix.plansByImei">Plans by IMEI</option>\n' +
  '                                    <option value="helix.imeiPlan">IMEI Plan (sub-ops)</option>\n' +
  '                                </optgroup>\n' +
  '                                <optgroup label="Skyline Gateway">\n' +
  '                                    <option value="skyline.smsStat">SMS Stats / Handshake</option>\n' +
  '                                    <option value="skyline.status">Port Status (ICCID/IMEI/signal)</option>\n' +
  '                                    <option value="skyline.sendSms">Send SMS</option>\n' +
  '                                    <option value="skyline.switchSim">Switch SIM (slot)</option>\n' +
  '                                    <option value="skyline.setImei">Set IMEI</option>\n' +
  '                                    <option value="skyline.saveConfig">Save Config (flash)</option>\n' +
  '                                    <option value="skyline.lock">Port: Lock</option>\n' +
  '                                    <option value="skyline.unlock">Port: Unlock</option>\n' +
  '                                    <option value="skyline.reboot">Port: Reboot</option>\n' +
  '                                    <option value="skyline.reset">Port: Reset</option>\n' +
  '                                </optgroup>\n' +
  '                            </select>';

if (content.includes(OLD_OPTS)) {
  content = content.replace(OLD_OPTS, NEW_OPTS);
} else if (!content.includes('value="atomic.activate"')) {
  console.error('PATCH FAILED: preset <select> block not found and new options absent.');
  process.exit(1);
}

// ── 2) Replace API_TESTER_PRESETS with comprehensive per-call presets ─────
const OLD_PRESETS_START = '        var API_TESTER_PRESETS = {';
// Use specific terminator: the closing `};` line is immediately followed by
// a blank line and then `        function addRelayHeader(`. This guards against
// matching the wrong `};` later in the file.
const OLD_PRESETS_END_MARKER = '        };\n\n        function addRelayHeader(';
const sIdx = content.indexOf(OLD_PRESETS_START);
if (sIdx === -1) { console.error('PATCH FAILED: API_TESTER_PRESETS not found.'); process.exit(1); }
const eIdx = content.indexOf(OLD_PRESETS_END_MARKER, sIdx);
if (eIdx === -1) { console.error('PATCH FAILED: end of API_TESTER_PRESETS not found.'); process.exit(1); }
// Replace through the `};\n` line; preserve the blank line + function addRelayHeader.
const PRESETS_CLOSE = '        };\n';
const replaceEnd = eIdx + PRESETS_CLOSE.length;

// Build the new presets block. Body strings are JSON; use JS string concat so
// inner backticks/${ aren't an issue (none here).
// Bodies are stored as JS OBJECTS (or empty strings, or plain text). The applied
// frontend code stringifies them with JSON.stringify(..., null, 2) at apply time.
// Storing as objects sidesteps all backslash/quote escaping issues that arise
// when JSON-stringified bodies live inside the outer getHTML() template literal.
const atomicEnvelope = function(requestType, extraFields) {
  return {
    wholeSaleApi: {
      session: { userName: '<ATOMIC_USERNAME>', token: '<ATOMIC_TOKEN>', pin: '<ATOMIC_PIN>' },
      wholeSaleRequest: Object.assign({ requestType: requestType, partnerTransactionId: 'tx_<timestamp>' }, extraFields)
    }
  };
};

const presets = {
  // ── ATOMIC ─────────────────────────────────────────────────────────────
  'atomic.activate': {
    method: 'POST',
    url: 'https://solutionsatt-atomic.telgoo5.com:22712/',
    headers: [['Content-Type', 'application/json']],
    body: atomicEnvelope('Activate', {
      imei: '<IMEI>', sim: '<ICCID>', eSim: 'N', EID: '', BAN: '',
      firstName: 'SUB', lastName: 'NINE',
      streetNumber: '123', streetDirection: '', streetName: 'Main St',
      zip: '10001', plan: 'ATTNOVOICE', portMdn: ''
    })
  },
  'atomic.subscriberInquiry': {
    method: 'POST',
    url: 'https://solutionsatt-atomic.telgoo5.com:22712/',
    headers: [['Content-Type', 'application/json']],
    body: atomicEnvelope('subsriberInquiry', { MSISDN: '<MSISDN>', sim: '<ICCID>' })
  },
  'atomic.suspend': {
    method: 'POST',
    url: 'https://solutionsatt-atomic.telgoo5.com:22712/',
    headers: [['Content-Type', 'application/json']],
    body: atomicEnvelope('suspendSubscriber', { MSISDN: '<MSISDN>', reasonCode: 'NPG' })
  },
  'atomic.restore': {
    method: 'POST',
    url: 'https://solutionsatt-atomic.telgoo5.com:22712/',
    headers: [['Content-Type', 'application/json']],
    body: atomicEnvelope('restoreSubscriber', { MSISDN: '<MSISDN>', reasonCode: 'CR' })
  },
  'atomic.deactivate': {
    method: 'POST',
    url: 'https://solutionsatt-atomic.telgoo5.com:22712/',
    headers: [['Content-Type', 'application/json']],
    body: atomicEnvelope('deactivateSubscriber', { MSISDN: '<MSISDN>', reasonCode: 'DD' })
  },
  'atomic.reconnect': {
    method: 'POST',
    url: 'https://solutionsatt-atomic.telgoo5.com:22712/',
    headers: [['Content-Type', 'application/json']],
    body: atomicEnvelope('reconnectSubscriber', { MSISDN: '<MSISDN>', reasonCode: '' })
  },
  'atomic.swapMsisdn': {
    method: 'POST',
    url: 'https://solutionsatt-atomic.telgoo5.com:22712/',
    headers: [['Content-Type', 'application/json']],
    body: atomicEnvelope('swapMSISDN', { MSISDN: '<MSISDN>', zipCode: '10001' })
  },
  'atomic.updateSubscriberInfo': {
    method: 'POST',
    url: 'https://solutionsatt-atomic.telgoo5.com:22712/',
    headers: [['Content-Type', 'application/json']],
    body: atomicEnvelope('UpdateSubscriberInfo', {
      MSISDN: '<MSISDN>',
      firstName: 'SUB', lastName: 'NINE',
      address: { streetNumber: '123', streetName: 'Main St', streetDirection: '', zipCode: '10001' }
    })
  },
  'atomic.resendOta': {
    method: 'POST',
    url: 'https://solutionsatt-atomic.telgoo5.com:22712/',
    headers: [['Content-Type', 'application/json']],
    body: atomicEnvelope('resendOtaProfile', { MSISDN: '<MSISDN>', sim: '<ICCID>' })
  },

  // ── Wing IoT ───────────────────────────────────────────────────────────
  'wing.getDevice': {
    method: 'GET',
    url: 'https://restapi19.att.com/rws/api/v1/devices/<ICCID>',
    headers: [['Authorization', 'Basic <base64(WING_IOT_USERNAME:WING_IOT_API_KEY)>'], ['Accept', 'application/json']],
    body: ''
  },
  'wing.activate': {
    method: 'PUT',
    url: 'https://restapi19.att.com/rws/api/v1/devices/<ICCID>',
    headers: [
      ['Authorization', 'Basic <base64(WING_IOT_USERNAME:WING_IOT_API_KEY)>'],
      ['Content-Type', 'application/json'],
      ['Accept', 'application/json']
    ],
    body: { communicationPlan: 'Wing Tel Inc - NON ABIR SMS MO/MT US', status: 'Activated' }
  },
  'wing.changePlanDialable': {
    method: 'PUT',
    url: 'https://restapi19.att.com/rws/api/v1/devices/<ICCID>',
    headers: [
      ['Authorization', 'Basic <base64(WING_IOT_USERNAME:WING_IOT_API_KEY)>'],
      ['Content-Type', 'application/json']
    ],
    body: { communicationPlan: 'Wing Tel Inc - DIALABLE SMS MO/MT US' }
  },
  'wing.changePlanNonDialable': {
    method: 'PUT',
    url: 'https://restapi19.att.com/rws/api/v1/devices/<ICCID>',
    headers: [
      ['Authorization', 'Basic <base64(WING_IOT_USERNAME:WING_IOT_API_KEY)>'],
      ['Content-Type', 'application/json']
    ],
    body: { communicationPlan: 'Wing Tel Inc - NON ABIR SMS MO/MT US' }
  },

  // ── Teltik ─────────────────────────────────────────────────────────────
  'teltik.allLines': {
    method: 'GET',
    url: 'https://api.smsgateway.xyz/v1/all-lines/?apikey=<TELTIK_API_KEY>',
    headers: [],
    body: ''
  },
  'teltik.getInfo': {
    method: 'GET',
    url: 'https://api.smsgateway.xyz/v1/get-info?apikey=<TELTIK_API_KEY>&mdn=<MDN>',
    headers: [],
    body: ''
  },
  'teltik.getPhoneNumber': {
    method: 'GET',
    url: 'https://api.smsgateway.xyz/v1/get-phone-number/?apikey=<TELTIK_API_KEY>&iccid=<ICCID>',
    headers: [],
    body: ''
  },
  'teltik.changeNumber': {
    method: 'GET',
    url: 'https://api.smsgateway.xyz/v1/change-number/?apikey=<TELTIK_API_KEY>&iccid=<ICCID>',
    headers: [],
    body: ''
  },
  'teltik.setForwardUrl': {
    method: 'POST',
    url: 'https://api.smsgateway.xyz/v1/forward-url?apikey=<TELTIK_API_KEY>',
    headers: [['Content-Type', 'application/json']],
    body: { forward_url: 'https://<your-worker>/lifecycle-webhook' }
  },

  // ── Helix ──────────────────────────────────────────────────────────────
  'helix.token': {
    method: 'POST',
    url: '<HX_TOKEN_URL>',
    headers: [['Content-Type', 'application/json']],
    body: {
      grant_type: 'password',
      client_id: '<HX_CLIENT_ID>',
      audience: '<HX_AUDIENCE>',
      username: '<HX_GRANT_USERNAME>',
      password: '<HX_GRANT_PASSWORD>'
    }
  },
  'helix.activate': {
    method: 'POST',
    url: '<HX_API_BASE>/api/mobility-activation/activate',
    headers: [['Authorization', 'Bearer <HX_TOKEN>'], ['Content-Type', 'application/json']],
    body: {
      clientId: 0,
      plan: { id: 0 },
      BAN: '<BAN>',
      FAN: '<FAN>',
      activationType: 'new_activation',
      subscriber: { firstName: 'SUB', lastName: 'NINE' },
      address: { address1: '123 Main St', city: 'New York', state: 'NY', zipCode: '10001' },
      service: { iccid: '<ICCID>', imei: '<IMEI>' }
    }
  },
  'helix.details': {
    method: 'POST',
    url: '<HX_API_BASE>/api/mobility-subscriber/details',
    headers: [['Authorization', 'Bearer <HX_TOKEN>'], ['Content-Type', 'application/json']],
    body: { mobilitySubscriptionId: '<SUB_ID>' }
  },
  'helix.suspend': {
    method: 'PATCH',
    url: '<HX_API_BASE>/api/mobility-subscriber/status',
    headers: [['Authorization', 'Bearer <HX_TOKEN>'], ['Content-Type', 'application/json']],
    body: [{ subscriberNumber: '<MDN>', subscriberState: 'Suspend', reasonCode: 'NPG', reasonCodeId: 0, mobilitySubscriptionId: '<SUB_ID>' }]
  },
  'helix.unsuspend': {
    method: 'PATCH',
    url: '<HX_API_BASE>/api/mobility-subscriber/status',
    headers: [['Authorization', 'Bearer <HX_TOKEN>'], ['Content-Type', 'application/json']],
    body: [{ subscriberNumber: '<MDN>', subscriberState: 'Unsuspend', reasonCode: 'CR', reasonCodeId: 0, mobilitySubscriptionId: '<SUB_ID>' }]
  },
  'helix.cancel': {
    method: 'PATCH',
    url: '<HX_API_BASE>/api/mobility-subscriber/status',
    headers: [['Authorization', 'Bearer <HX_TOKEN>'], ['Content-Type', 'application/json']],
    body: [{ subscriberNumber: '<MDN>', subscriberState: 'Cancel', reasonCode: 'DD', reasonCodeId: 0, mobilitySubscriptionId: '<SUB_ID>' }]
  },
  'helix.resumeOnCancel': {
    method: 'PATCH',
    url: '<HX_API_BASE>/api/mobility-subscriber/status',
    headers: [['Authorization', 'Bearer <HX_TOKEN>'], ['Content-Type', 'application/json']],
    body: [{ subscriberNumber: '<MDN>', subscriberState: 'Resume On Cancel', reasonCode: '', reasonCodeId: 0, mobilitySubscriptionId: '<SUB_ID>' }]
  },
  'helix.ctn': {
    method: 'PATCH',
    url: '<HX_API_BASE>/api/mobility-subscriber/ctn',
    headers: [['Authorization', 'Bearer <HX_TOKEN>'], ['Content-Type', 'application/json']],
    body: { mobilitySubscriptionId: '<SUB_ID>' }
  },
  'helix.resetOta': {
    method: 'PATCH',
    url: '<HX_API_BASE>/api/mobility-subscriber/reset-ota',
    headers: [['Authorization', 'Bearer <HX_TOKEN>'], ['Content-Type', 'application/json']],
    body: [{ ban: '<BAN>', subscriberNumber: '<MDN>', iccid: '<ICCID>' }]
  },
  'helix.plansByImei': {
    method: 'GET',
    url: '<HX_API_BASE>/api/plans-by-imei/<IMEI>?skuId=3&resellerId=<HX_ACTIVATION_CLIENT_ID>',
    headers: [['Authorization', 'Bearer <HX_TOKEN>']],
    body: ''
  },
  'helix.imeiPlan': {
    method: 'POST',
    url: '<HX_API_BASE>/api/mobility-sub-ops/imei-plan',
    headers: [['Authorization', 'Bearer <HX_TOKEN>'], ['Content-Type', 'application/json']],
    body: { mobilitySubscriptionId: '<SUB_ID>', imei: '<IMEI>', planId: 0 }
  },

  // ── Skyline Gateway ────────────────────────────────────────────────────
  'skyline.smsStat': {
    method: 'GET',
    url: 'http://<GATEWAY_HOST>:<PORT>/goip_get_sms_stat.html?version=1.1&username=<USER>&password=<PASS>&ports=all&type=3',
    headers: [],
    body: ''
  },
  'skyline.status': {
    method: 'GET',
    url: 'http://<GATEWAY_HOST>:<PORT>/goip_get_status.html?version=1.1&username=<USER>&password=<PASS>&ports=all&all_slots=1',
    headers: [],
    body: ''
  },
  'skyline.sendSms': {
    method: 'POST',
    url: 'http://<GATEWAY_HOST>:<PORT>/goip_post_sms.html?username=<USER>&password=<PASS>',
    headers: [['Content-Type', 'application/json']],
    body: {
      type: 'send-sms', task_num: 1,
      tasks: [{ tid: 1, port: '<PORT_NUM>', to: '<DEST_MDN>', sms: 'Hello', smstype: 0, coding: 0 }]
    }
  },
  'skyline.switchSim': {
    method: 'POST',
    url: 'http://<GATEWAY_HOST>:<PORT>/goip_send_cmd.html?username=<USER>&password=<PASS>',
    headers: [['Content-Type', 'application/json']],
    body: { type: 'command', op: 'switch', ports: '<PORT_NUM>' }
  },
  'skyline.setImei': {
    method: 'POST',
    url: 'http://<GATEWAY_HOST>:<PORT>/goip_send_cmd.html?username=<USER>&password=<PASS>&op=set',
    headers: [['Content-Type', 'text/plain']],
    body: 'sim_imei(<N>)=<IMEI>'
  },
  'skyline.saveConfig': {
    method: 'POST',
    url: 'http://<GATEWAY_HOST>:<PORT>/goip_send_cmd.html?username=<USER>&password=<PASS>',
    headers: [['Content-Type', 'application/json']],
    body: { type: 'command', op: 'save' }
  },
  'skyline.lock': {
    method: 'POST',
    url: 'http://<GATEWAY_HOST>:<PORT>/goip_send_cmd.html?username=<USER>&password=<PASS>',
    headers: [['Content-Type', 'application/json']],
    body: { type: 'command', op: 'lock', ports: '<PORT_NUM>' }
  },
  'skyline.unlock': {
    method: 'POST',
    url: 'http://<GATEWAY_HOST>:<PORT>/goip_send_cmd.html?username=<USER>&password=<PASS>',
    headers: [['Content-Type', 'application/json']],
    body: { type: 'command', op: 'unlock', ports: '<PORT_NUM>' }
  },
  'skyline.reboot': {
    method: 'POST',
    url: 'http://<GATEWAY_HOST>:<PORT>/goip_send_cmd.html?username=<USER>&password=<PASS>',
    headers: [['Content-Type', 'application/json']],
    body: { type: 'command', op: 'reboot', ports: '<PORT_NUM>' }
  },
  'skyline.reset': {
    method: 'POST',
    url: 'http://<GATEWAY_HOST>:<PORT>/goip_send_cmd.html?username=<USER>&password=<PASS>',
    headers: [['Content-Type', 'application/json']],
    body: { type: 'command', op: 'reset', ports: '<PORT_NUM>' }
  }
};

// Serialize presets as a JS object literal using JSON (safe — no backticks).
const presetsJson = JSON.stringify(presets);

const newBlock =
  '        var API_TESTER_PRESETS = ' + presetsJson + ';\n';

content = content.slice(0, sIdx) + newBlock + content.slice(replaceEnd);

// ── 3) Update applyApiPreset to pretty-print JSON bodies on apply ─────────
const OLD_APPLY =
  '        function applyApiPreset() {\n' +
  '            var val = document.getElementById(\'api-tester-preset\').value;\n' +
  '            var p = val ? API_TESTER_PRESETS[val] : null;\n' +
  '            if (!p) return;\n' +
  '            document.getElementById(\'api-tester-method\').value = p.method;\n' +
  '            document.getElementById(\'api-tester-url\').value = p.url;\n' +
  '            document.getElementById(\'api-tester-headers\').innerHTML = \'\';\n' +
  '            (p.headers || []).forEach(function(h) { addRelayHeader(h[0], h[1]); });\n' +
  '            document.getElementById(\'api-tester-body\').value = p.body;\n' +
  '        }';
const NEW_APPLY =
  '        function applyApiPreset() {\n' +
  '            var val = document.getElementById(\'api-tester-preset\').value;\n' +
  '            var p = val ? API_TESTER_PRESETS[val] : null;\n' +
  '            if (!p) return;\n' +
  '            document.getElementById(\'api-tester-method\').value = p.method;\n' +
  '            document.getElementById(\'api-tester-url\').value = p.url;\n' +
  '            document.getElementById(\'api-tester-headers\').innerHTML = \'\';\n' +
  '            (p.headers || []).forEach(function(h) { addRelayHeader(h[0], h[1]); });\n' +
  '            var body = (p.body === undefined || p.body === null) ? \'\' : p.body;\n' +
  '            if (typeof body === \'object\') { body = JSON.stringify(body, null, 2); }\n' +
  '            document.getElementById(\'api-tester-body\').value = body;\n' +
  '        }';
if (content.includes(OLD_APPLY)) {
  content = content.replace(OLD_APPLY, NEW_APPLY);
} else if (!content.includes('JSON.parse(body), null, 2')) {
  console.error('PATCH FAILED: applyApiPreset block not found.');
  process.exit(1);
}

// Convert back to CRLF
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied successfully.');
