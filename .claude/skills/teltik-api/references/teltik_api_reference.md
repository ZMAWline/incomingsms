# Teltik SMS Gateway API — Full Reference

**Version:** 1.0.0
**Host:** `api.smsgateway.xyz`
**Scheme:** HTTPS
**Base Path:** `/`
**Contact:** shlomo@teltik.com

---

## Authentication

All endpoints require `apikey` as a query parameter.

```
?apikey=YOUR_API_KEY
```

- Invalid or missing key → **404 Not Found**
- Never pass apikey in the request body or headers

---

## Endpoints

---

### GET /v1/status
Returns API operational status.

**Parameters:**
| Name | In | Required | Type | Description |
|------|----|----------|------|-------------|
| apikey | query | yes | string | API key |

**Response 200:** API is operational

---

### GET /v1/get-info
Retrieve ICCID, gateway ID, and port for a given phone number.

**Parameters:**
| Name | In | Required | Type | Description |
|------|----|----------|------|-------------|
| apikey | query | yes | string | API key |
| mdn | query | yes | string | 10 or 11-digit phone number |

**Response 200:**
```json
{
  "iccid": "89148000001234567890",
  "gateway_id": "GW-001",
  "port": "3"
}
```

---

### GET /v1/all-lines/
List all lines assigned to the API key account.

**Parameters:**
| Name | In | Required | Type |
|------|----|----------|------|
| apikey | query | yes | string |

**Response 200:** Array of line objects with MDN and metadata.

---

### GET /v1/phone-lookup
Retrieve phone number record(s) by nickname, or list all records.

**Parameters:**
| Name | In | Required | Type | Description |
|------|----|----------|------|-------------|
| apikey | query | yes | string | API key |
| nickname | query | no | string | Filter by nickname; omit to list all |

**Response 200:** Array of MDNItem:
```json
[
  { "mdn": "12125551234", "nickname": "Gateway-01" }
]
```

---

### GET /v1/get-phone-number/
Get MDN (phone number) for a given ICCID.

**Parameters:**
| Name | In | Required | Type |
|------|----|----------|------|
| apikey | query | yes | string |
| iccid | query | yes | string |

**Response 200:**
```json
{ "mdn": "12125551234" }
```

---

### GET /v1/change-number/
Request a phone number change for an ICCID. Can optionally specify area code or ZIP.

**Parameters:**
| Name | In | Required | Type | Description |
|------|----|----------|------|-------------|
| apikey | query | yes | string | |
| iccid | query | yes | string | SIM ICCID |
| area | query | no | string | Desired area code |
| zip | query | no | string | ZIP code for number selection |

**Response 200:**
```json
{ "requestId": "abc123", "new_mdn": "12125559999" }
```

---

### GET /v1/change-number/{requestId}
Check the status of a number change request.

**Parameters:**
| Name | In | Required | Type |
|------|----|----------|------|
| apikey | query | yes | string |
| requestId | path | yes | string |

**Response 200:** Status of the change request.

---

### POST /v1/update-nickname
Update the nickname/alias for a phone number.

**Parameters:**
| Name | In | Required | Type |
|------|----|----------|------|
| apikey | query | yes | string |

**Request Body (application/json):**
```json
{
  "mdn": "12125551234",
  "nickname": "Gateway-07"
}
```

**Response 200:** Confirmation of update.

---

### GET /v1/reset-port
Initiate a gateway port reset for a given MDN. Triggers the SIM to re-register and receive an incoming SMS if needed.

**Parameters:**
| Name | In | Required | Type | Description |
|------|----|----------|------|-------------|
| apikey | query | yes | string | |
| mdn | query | yes | string | Phone number to reset |
| force_reset | query | no | boolean | Skip checks and force reset |
| skip_sms_lookup | query | no | boolean | Don't wait for SMS after reset |

**Response 200:**
```json
{
  "request_id": 4821,
  "status": "PENDING",
  "message": "Port reset initiated"
}
```

**Use `request_id` to poll `/v1/sms-lookup`.**

---

### GET /v1/reset-port-requests
Retrieve port reset request history.

**Parameters:**
| Name | In | Required | Type | Description |
|------|----|----------|------|-------------|
| apikey | query | yes | string | |
| limit | query | yes | integer | Max records to return |
| status | query | no | string | Filter by status |

**Response 200:** Array of ResetPortItem:
```json
[
  { "request_id": 4821, "status": "COMPLETED", "message": "..." }
]
```

---

### GET /v1/port-status
Check current port registration status.

**Parameters:**
| Name | In | Required | Type |
|------|----|----------|------|
| apikey | query | yes | string |

**Response 200:**
```json
{ "success": true, "status": "Registered" }
```

---

### GET /v1/reset-network
Reconnect device by resetting the network interface.

**Parameters:**
| Name | In | Required | Type |
|------|----|----------|------|
| apikey | query | yes | string |

**Response 200:** Confirmation.

---

### GET /v1/enable-slots
Activate specified gateway slots.

**Parameters:**
| Name | In | Required | Type | Description |
|------|----|----------|------|-------------|
| apikey | query | yes | string | |
| slots | query | yes | string | Slot identifiers to enable |
| prevent_slot_disable | query | no | boolean | Prevent other slots from being disabled |

**Response 200:** Confirmation.

---

### GET /v1/sms-lookup
Poll for SMS received after a port reset. **Can return 429 — implement retry with backoff.**

**Parameters:**
| Name | In | Required | Type | Description |
|------|----|----------|------|-------------|
| apikey | query | yes | string | |
| requestId | query | yes | integer | request_id from /v1/reset-port |

**Response 200:** SMSItem:
```json
{
  "mdn": "12125551234",
  "status": "MSG_RECEIVED",
  "timestamp": "2026-03-24T15:32:00Z",
  "sms": "Your code is 482910",
  "code": "482910"
}
```

**`status` values:**
| Value | Meaning |
|-------|---------|
| `WAITING_FOR_MSG` | Not yet received — keep polling |
| `MSG_RECEIVED` | SMS received — check `sms` and `code` fields |
| `TIMEOUT` | 120s threshold exceeded — no SMS came |
| `IN_QUEUE` | Awaiting processing — keep polling |
| `ERROR_PORT_RESET` | Error during reset — handle failure |
| `FLUSHED` | Removed from queue |

**Polling pattern:**
```js
// Poll every 4s, up to 30 attempts (~2 minutes)
for (let i = 0; i < 30; i++) {
  await sleep(4000);
  const res = await fetch(`...sms-lookup?apikey=...&requestId=${id}`);
  if (res.status === 429) continue; // rate limited, retry
  const item = await res.json();
  if (item.status === 'MSG_RECEIVED') return item;
  if (['TIMEOUT', 'ERROR_PORT_RESET', 'FLUSHED'].includes(item.status)) throw item;
}
```

---

### GET /v1/all-sms
Fetch all SMS with optional filters.

**Parameters:**
| Name | In | Required | Type | Description |
|------|----|----------|------|-------------|
| apikey | query | yes | string | |
| phonenumber | query | no | string | Filter by MDN |
| sender | query | no | string | Filter by sender name/number |
| limit | query | no | integer | Max records |
| format | query | no | string | Response format |

**Response 200:** Array of SMSItem.

---

### POST /v1/send-message
Send an SMS from one number to another.

**Parameters:**
| Name | In | Required | Type | Description |
|------|----|----------|------|-------------|
| apikey | query | yes | string | |
| skip_slot_active_check | query | no | boolean | Send even if slot not fully active |

**Request Body (application/json):**
```json
{
  "from": "12125551234",
  "to": "13105559876",
  "message": "Hello from Teltik!"
}
```

**Response 200:** Success/error.
**Response 425:** SIM unregistered — reset port first.

---

### GET /v1/send-wake-up-message
Send a self-directed wake-up message to trigger SIM registration.

**Parameters:**
| Name | In | Required | Type | Description |
|------|----|----------|------|-------------|
| apikey | query | yes | string | |
| force_reset | query | no | boolean | Force reset before sending |

**Response 200:** Confirmation.

---

### GET /v1/sim-swap/
Exchange SIM cards — replace old ICCID with new ICCID on the account.

**Parameters:**
| Name | In | Required | Type |
|------|----|----------|------|
| apikey | query | yes | string |
| oldICCID | query | yes | string |
| newICCID | query | yes | string |

**Response 200:** Confirmation of swap.

---

### GET /v1/flush-queue
Clear all queued requests for the account.

**Parameters:**
| Name | In | Required | Type |
|------|----|----------|------|
| apikey | query | yes | string |

**Response 200:** Confirmation.

---

### POST /v1/flush-cache/user
Clear cached data for the API key user.

**Parameters:**
| Name | In | Required | Type |
|------|----|----------|------|
| apikey | query | yes | string |

**Response 200:** Confirmation.

---

### GET /v1/forward-url
Retrieve primary and secondary webhook/forward URLs.

**Parameters:**
| Name | In | Required | Type |
|------|----|----------|------|
| apikey | query | yes | string |

**Response 200:**
```json
{
  "primary_url": "https://yourapp.com/webhook/sms",
  "secondary_url": "https://yourapp.com/webhook/sms-backup"
}
```

---

### POST /v1/forward-url
Update webhook URLs for SMS forwarding. At least one URL required.

**Parameters:**
| Name | In | Required | Type |
|------|----|----------|------|
| apikey | query | yes | string |

**Request Body (application/json):**
```json
{
  "primary_url": "https://yourapp.com/webhook/sms",
  "secondary_url": "https://yourapp.com/webhook/sms-backup"
}
```

**Response 200:** Confirmation.

---

## Data Models

### SMSItem
```json
{
  "mdn": "string",        // Phone number
  "status": "string",     // See status enum above
  "timestamp": "string",  // ISO 8601
  "sms": "string",        // Full SMS body
  "code": "string"        // Extracted OTP/code (if detected)
}
```

### ResetPortItem
```json
{
  "request_id": 0,        // integer
  "status": "string",
  "message": "string"
}
```

### PortStatusItem
```json
{
  "success": true,
  "status": "Registered"
}
```

### MDNItem
```json
{
  "mdn": "string",
  "nickname": "string"
}
```

---

## Error Response Format

Most errors return a JSON body:
```json
{
  "error": "Description of what went wrong"
}
```

---

## Complete JS Helper Class

```js
class TeltikAPI {
  constructor(apikey) {
    this.base = 'https://api.smsgateway.xyz';
    this.key = apikey;
  }

  async _get(path, params = {}) {
    const url = new URL(this.base + path);
    url.searchParams.set('apikey', this.key);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, v);
    }
    const res = await fetch(url);
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    return res.json();
  }

  async _post(path, body, params = {}) {
    const url = new URL(this.base + path);
    url.searchParams.set('apikey', this.key);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, v);
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    return res.json();
  }

  status()                        { return this._get('/v1/status'); }
  getInfo(mdn)                    { return this._get('/v1/get-info', { mdn }); }
  allLines()                      { return this._get('/v1/all-lines/'); }
  phoneLookup(nickname)           { return this._get('/v1/phone-lookup', { nickname }); }
  getPhoneNumber(iccid)           { return this._get('/v1/get-phone-number/', { iccid }); }
  changeNumber(iccid, area, zip)  { return this._get('/v1/change-number/', { iccid, area, zip }); }
  changeNumberStatus(requestId)   { return this._get(`/v1/change-number/${requestId}`); }
  updateNickname(mdn, nickname)   { return this._post('/v1/update-nickname', { mdn, nickname }); }
  resetPort(mdn, opts = {})       { return this._get('/v1/reset-port', { mdn, ...opts }); }
  resetPortRequests(limit, status){ return this._get('/v1/reset-port-requests', { limit, status }); }
  portStatus()                    { return this._get('/v1/port-status'); }
  resetNetwork()                  { return this._get('/v1/reset-network'); }
  enableSlots(slots, opts = {})   { return this._get('/v1/enable-slots', { slots, ...opts }); }
  smsLookup(requestId)            { return this._get('/v1/sms-lookup', { requestId }); }
  allSms(params = {})             { return this._get('/v1/all-sms', params); }
  sendMessage(from, to, message, opts = {}) {
    return this._post('/v1/send-message', { from, to, message }, opts);
  }
  sendWakeUp(force_reset)         { return this._get('/v1/send-wake-up-message', { force_reset }); }
  simSwap(oldICCID, newICCID)     { return this._get('/v1/sim-swap/', { oldICCID, newICCID }); }
  flushQueue()                    { return this._get('/v1/flush-queue'); }
  flushCache()                    { return this._post('/v1/flush-cache/user', {}); }
  getForwardUrl()                 { return this._get('/v1/forward-url'); }
  setForwardUrl(primary_url, secondary_url) {
    return this._post('/v1/forward-url', { primary_url, secondary_url });
  }

  // High-level: reset port and wait for SMS
  async resetAndWaitForSms(mdn, { maxAttempts = 30, intervalMs = 4000 } = {}) {
    const { request_id } = await this.resetPort(mdn);
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, intervalMs));
      let item;
      try {
        item = await this.smsLookup(request_id);
      } catch (e) {
        if (e.status === 429) continue; // rate limited
        throw e;
      }
      if (item.status === 'MSG_RECEIVED') return item;
      if (['TIMEOUT', 'ERROR_PORT_RESET', 'FLUSHED'].includes(item.status)) {
        throw Object.assign(new Error(`SMS lookup ended: ${item.status}`), { item });
      }
    }
    throw new Error('Max polling attempts exceeded');
  }
}

// Usage:
// const teltik = new TeltikAPI(process.env.TELTIK_API_KEY);
// const smsItem = await teltik.resetAndWaitForSms('12125551234');
// console.log(smsItem.code); // extracted OTP
```
