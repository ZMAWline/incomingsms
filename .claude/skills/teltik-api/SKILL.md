---
name: teltik-api
description: Expert knowledge of the Teltik SMS Gateway API (api.smsgateway.xyz) for managing phone lines, sending/receiving SMS, resetting ports, swapping SIMs, and configuring webhooks. Use when working with Teltik lines, querying received SMS, triggering port resets, looking up phone numbers by ICCID, sending messages, or configuring forward URLs. Auth via apikey query parameter. Contact: shlomo@teltik.com
---

# Teltik SMS API Expert Skill

Expert in the Teltik SMS Gateway REST API v1.0.0 (`https://api.smsgateway.xyz`).

## What This Skill Covers

1. **Status & Info** — API health check, line info (ICCID/gateway/port) by MDN, list all lines
2. **Phone Number Management** — lookup by nickname, get number by ICCID, change number, update nickname
3. **Port & Network Operations** — reset port, check reset history, check port status, reset network, enable slots
4. **SMS Operations** — poll SMS after port reset, fetch all SMS with filters, send SMS, send wake-up message
5. **SIM Management** — swap SIM (old ICCID → new ICCID)
6. **Queue & Cache** — flush request queue, flush user cache
7. **Webhook Configuration** — get/set primary and secondary forward URLs for SMS delivery

## Authentication

**All endpoints:** `apikey` as a query parameter (string, required).
- Invalid key → 404 Not Found

```
GET https://api.smsgateway.xyz/v1/status?apikey=YOUR_API_KEY
```

## Base URL

```
https://api.smsgateway.xyz
```

## Quick Reference: All Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/v1/status` | API health check |
| GET | `/v1/get-info` | Get ICCID/gateway/port for MDN |
| GET | `/v1/all-lines/` | List all lines on account |
| GET | `/v1/phone-lookup` | Find number by nickname |
| GET | `/v1/get-phone-number/` | Get MDN by ICCID |
| GET | `/v1/change-number/` | Change phone number for ICCID |
| GET | `/v1/change-number/{requestId}` | Check number change status |
| POST | `/v1/update-nickname` | Set nickname for an MDN |
| GET | `/v1/reset-port` | Trigger port reset |
| GET | `/v1/reset-port-requests` | Get port reset history |
| GET | `/v1/port-status` | Check port registration status |
| GET | `/v1/reset-network` | Reset network connection |
| GET | `/v1/enable-slots` | Activate gateway slots |
| GET | `/v1/sms-lookup` | Poll SMS by reset request ID |
| GET | `/v1/all-sms` | Fetch all SMS with filters |
| POST | `/v1/send-message` | Send SMS |
| GET | `/v1/send-wake-up-message` | Send self-directed wake-up SMS |
| GET | `/v1/sim-swap/` | Swap SIM (old → new ICCID) |
| GET | `/v1/flush-queue` | Clear queued requests |
| POST | `/v1/flush-cache/user` | Clear API key cache |
| GET | `/v1/forward-url` | Get webhook URLs |
| POST | `/v1/forward-url` | Set webhook URLs |

## Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 400 | Invalid/missing parameters |
| 403 | Access denied |
| 404 | Not found or invalid API key |
| 425 | SIM unregistered — port reset required |
| 429 | Rate limit exceeded — retry with backoff |
| 500 | Server error |

## SMSItem Status Values

| Status | Meaning |
|--------|---------|
| `WAITING_FOR_MSG` | Not yet received |
| `MSG_RECEIVED` | Successfully obtained |
| `TIMEOUT` | 120s threshold exceeded |
| `IN_QUEUE` | Awaiting processing |
| `ERROR_PORT_RESET` | Error during reset |
| `FLUSHED` | Removed from queue |

## Key Workflow: Port Reset + SMS Intercept

```
1. GET /v1/reset-port?apikey=...&mdn=...
   → returns { request_id, status, message }

2. Poll GET /v1/sms-lookup?apikey=...&requestId=<request_id>
   → watch status field:
     "MSG_RECEIVED" → sms/code fields have the message
     "TIMEOUT"      → 120s elapsed, no SMS received
     "WAITING_FOR_MSG" / "IN_QUEUE" → keep polling
   → handle 429 with exponential backoff
```

## Example: Check API Status

```js
const res = await fetch(`https://api.smsgateway.xyz/v1/status?apikey=${APIKEY}`);
const data = await res.json();
```

## Example: Get Info for a Line

```js
const res = await fetch(
  `https://api.smsgateway.xyz/v1/get-info?apikey=${APIKEY}&mdn=12125551234`
);
// Returns: { iccid, gateway_id, port }
```

## Example: List All Lines

```js
const res = await fetch(`https://api.smsgateway.xyz/v1/all-lines/?apikey=${APIKEY}`);
const lines = await res.json();
// Array of line objects
```

## Example: Reset Port + Poll SMS

```js
async function resetAndWait(apikey, mdn, maxAttempts = 30, intervalMs = 4000) {
  // 1. Trigger reset
  const resetRes = await fetch(
    `https://api.smsgateway.xyz/v1/reset-port?apikey=${apikey}&mdn=${mdn}`
  );
  const { request_id } = await resetRes.json();

  // 2. Poll for SMS
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, intervalMs));
    const pollRes = await fetch(
      `https://api.smsgateway.xyz/v1/sms-lookup?apikey=${apikey}&requestId=${request_id}`
    );
    if (pollRes.status === 429) continue; // rate limited, retry
    const item = await pollRes.json();
    if (item.status === 'MSG_RECEIVED') return item.sms; // or item.code
    if (item.status === 'TIMEOUT') throw new Error('SMS timeout');
    if (item.status === 'ERROR_PORT_RESET') throw new Error('Port reset error');
  }
  throw new Error('Max polling attempts exceeded');
}
```

## Example: Send SMS

```js
const res = await fetch(
  `https://api.smsgateway.xyz/v1/send-message?apikey=${APIKEY}`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: '12125551234', to: '13105559876', message: 'Hello!' })
  }
);
```

## Example: Fetch All SMS (Filtered)

```js
const url = new URL('https://api.smsgateway.xyz/v1/all-sms');
url.searchParams.set('apikey', APIKEY);
url.searchParams.set('phonenumber', '12125551234'); // optional
url.searchParams.set('sender', 'Teltik');           // optional
url.searchParams.set('limit', '50');                // optional
const res = await fetch(url);
const smsArray = await res.json();
```

## Example: Change Number

```js
// Trigger change
const res = await fetch(
  `https://api.smsgateway.xyz/v1/change-number/?apikey=${APIKEY}&iccid=89148000001234&area=212`
);
const { requestId } = await res.json();

// Check status
const status = await fetch(
  `https://api.smsgateway.xyz/v1/change-number/${requestId}?apikey=${APIKEY}`
);
```

## Example: SIM Swap

```js
const res = await fetch(
  `https://api.smsgateway.xyz/v1/sim-swap/?apikey=${APIKEY}&oldICCID=89148000001234&newICCID=89148000005678`
);
```

## Example: Set Webhook URL

```js
const res = await fetch(
  `https://api.smsgateway.xyz/v1/forward-url?apikey=${APIKEY}`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      primary_url: 'https://yourapp.com/webhook/sms',
      secondary_url: 'https://yourapp.com/webhook/sms-backup'  // optional
    })
  }
);
```

## Example: Update Nickname

```js
const res = await fetch(
  `https://api.smsgateway.xyz/v1/update-nickname?apikey=${APIKEY}`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mdn: '12125551234', nickname: 'Gateway-07' })
  }
);
```

## Common Gotchas

- **`/v1/sms-lookup` can return 429** — always wrap polling in retry logic
- **Port reset is async** — never assume SMS arrives immediately; poll with backoff
- **SIM unregistered (425)** — must reset port before SMS operations work
- **apikey in query string** — not in headers; every request needs it
- **`/v1/all-lines/` has trailing slash** — include it to avoid redirect
- **Number change is async** — check `/v1/change-number/{requestId}` for completion

For full field-level specs and additional examples, see [references/teltik_api_reference.md](references/teltik_api_reference.md).
