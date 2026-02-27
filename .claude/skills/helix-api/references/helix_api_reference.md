# Helix SOLO API Mobility Reference

**Last Updated:** 2026-02-27 (from SOLO API Mobility Docs v1.4)

## Overview

The Helix SOLO Mobility API manages AT&T SIM card activation and subscriber management. All endpoints require a bearer token in the `Authorization` header.

**Base URL:** `https://api.helixsolo.app`
**Auth URL:** `https://auth.helixsolo.app/oauth/token`

---

## Authentication

**Endpoint:** `POST https://auth.helixsolo.app/oauth/token`

**Request:**
```json
{
  "grant_type": "password",
  "client_id": "YOUR_CLIENT_ID",
  "audience": "https://dev-z8ucfxd1iqdj7bzm.us.auth0.com/api/v2/",
  "username": "YOUR_USERNAME",
  "password": "YOUR_PASSWORD"
}
```

**Response:**
```json
{
  "access_token": "eyJhbGciOiJSUzI1NiIs...",
  "expires_in": 86400,
  "token_type": "Bearer"
}
```

Token expires in 86400 seconds (24 hours). All API calls need `Authorization: Bearer YOUR_TOKEN`.

---

## 4.1 Check IMEI Eligibility

Validate whether an IMEI can be activated on a given plan/carrier.

**Endpoint:** `GET https://api.helixsolo.app/api/plans-by-imei/{imei}?skuId={skuId}&resellerId={resellerId}`

- `skuId=3` for AT&T
- `skuId=11` for Verizon

**Example:** `GET /api/plans-by-imei/356415593499551?skuId=3&resellerId=91`

**Response (200):**
```json
{
  "imei_type_id": "63",
  "imei_type": "S7",
  "sim_type": "DSDS (4FF/eSIM)",
  "manufacturer": "Sample Manufacturer",
  "model": "Sample Model 2023",
  "network_type": "5G",
  "isImeiValid": true,
  "plans": [
    { "plan_id": 123, "name": "Sample Plan", "soloPlanCode": "MESP1T" }
  ]
}
```

**Response (406):** IMEI not found.

---

## 4.2 Single Unit Activation

Activate a single SIM card.

**Endpoint:** `POST https://api.helixsolo.app/api/mobility-activation/activate`

**Request:**
```json
{
  "resellerId": 101,
  "plan": { "id": 123 },
  "FAN": "98765432",
  "BAN": "987654321000",
  "activationType": "new_activation",
  "subscriber": {
    "firstName": "Jane",
    "lastName": "Smith"
  },
  "address": {
    "address1": "456 Elm Street",
    "city": "Springfield",
    "state": "IL",
    "zipCode": "62701"
  },
  "service": {
    "imei": "358765098765432",
    "iccid": "89014104334567890123",
    "subscriberNumber": "5551234567"
  },
  "partnerTransactionId": "TR1234"
}
```

**Field notes:**
- `resellerId` / `clientId` — interchangeable
- `plan.id` — required; no `type` field (removed in v1.2)
- `BAN` — optional; auto-generated if omitted
- `service.subscriberNumber` — optional; include to reserve a specific CTN
- `partnerTransactionId` — optional; must have a value for webhooks to fire

**Response (201):**
```json
{ "mobilitySubscriptionId": 4000 }
```

**Response (400):** ICCID already has an active subscription.

---

## 4.3 Retry/Update Activation

Retry a failed activation, optionally changing IMEI, ICCID, plan, or subscriber details.

**Endpoint:** `PATCH https://api.helixsolo.app/api/mobility-activation/activate/retry/:mobilitySubscriptionId`

**Request:**
```json
{
  "firstName": "Test",
  "lastName": "User",
  "address": {
    "address1": "123 Example St",
    "city": "Sample City",
    "state": "XY",
    "zipCode": "12345"
  },
  "iccid": "12345678901234567890",
  "imei": "123456789012345",
  "plan": { "id": 999 },
  "esim": false
}
```

**Field notes:**
- All fields are optional except `firstName`, `lastName`, and address fields
- `esim: true` required for eSIM activations
- Only works when subscription status is `ACTIVATION_FAILED`

**Response (200):** Full subscriber object with `mobility_subscription_id`, address fields, `iccid`, `billing_imei`, `activationId`.

**Response (400):** `"Subscription operation status should be ACTIVATION_FAILED."`

---

## 4.4 Update Mobility Subscriber Details

Update subscriber name and/or address.

**Endpoint:** `PATCH https://api.helixsolo.app/api/mobility-subscriber/details`

**Request (array):**
```json
[
  {
    "subscriberNumber": "1234567890",
    "firstName": "John",
    "lastName": "Smith",
    "address": {
      "address1": "123 Maple Ave",
      "address2": "Apt 4B",
      "city": "Springfield",
      "state": "IL",
      "zipCode": "62704"
    },
    "streetName": "Maple",
    "streetType": "Ave",
    "streetNumber": "123"
  }
]
```

**Response (200):** Array with `status: "fulfilled"` and updated subscriber details.

---

## 4.5 Get Status Change Reason Codes

Get all reason codes for status changes.

**Endpoint:** `GET https://api.helixsolo.app/api/mobility-subscriber/reason-codes`

**Response (200):** Array of reason code objects. Key codes:

| reasonCodeId | reason | reasonCode | subscriberState |
|---|---|---|---|
| 1 | Cancel No Reason | CAN | Cancel |
| 3 | Lost Stolen | LOS | Cancel |
| 18 | Customer Request | CR | Resume On Cancel |
| 19 | Procedural | PR | Resume On Cancel |
| 20 | Bring Back Live | BBL | Resume On Cancel |
| 22 | Customer Request | CR | Suspend |
| 23 | High Use Suspend | NPG | Suspend |
| 25 | Stolen | STLN | Suspend |
| 35 | Customer Request | CR | Unsuspend |
| 36 | Procedural | PR | Unsuspend |

---

## 4.6 Change Subscriber Status

Change subscriber status (suspend, unsuspend, cancel, resume).

**Endpoint:** `PATCH https://api.helixsolo.app/api/mobility-subscriber/status`

Request body is an **array** of status change objects.

### Suspend
```json
[{ "subscriberNumber": "4693186358", "reasonCodeId": 22, "subscriberState": "Suspend", "reasonCode": "CR" }]
```

### Unsuspend (Restore)
```json
[{ "subscriberNumber": "4693186358", "reasonCodeId": 35, "subscriberState": "Unsuspend", "reasonCode": "CR" }]
```

### Cancel
```json
[{ "subscriberNumber": "4693186358", "reasonCodeId": 1, "subscriberState": "Cancel", "reasonCode": "CAN" }]
```

### Resume On Cancel
```json
[{ "subscriberNumber": "4693186358", "reasonCodeId": 20, "subscriberState": "Resume On Cancel", "reasonCode": "BBL" }]
```

**Response (200):**
```json
{
  "fulfilled": [{ "status": "Active", "subscriberNumber": "1234567890", "reasonCodeId": 1, "subscriberState": "Cancel" }],
  "rejected": []
}
```

**Status Change Quick Reference:**

| Action | subscriberState | reasonCode | reasonCodeId |
|--------|-----------------|------------|--------------|
| Suspend | `Suspend` | `CR` | `22` |
| Restore | `Unsuspend` | `CR` | `35` |
| Cancel | `Cancel` | `CAN` | `1` |
| Resume (From Cancel) | `Resume On Cancel` | `BBL` | `20` |

---

## 4.7 Get Mobility Subscriber Details

Get detailed subscriber information.

**Endpoint:** `POST https://api.helixsolo.app/api/mobility-subscriber/details`

**Request:** Either `subscriberNumber` or `mobilitySubscriptionId` (or both):
```json
[{ "subscriberNumber": "1234567890", "mobilitySubscriptionId": 1001 }]
```

**Bulk request:** Array with multiple entries.

**Response (201):** Array of subscriber objects:
```json
[{
  "mobilitySubscriptionId": "1001",
  "phoneNumber": "1234567890",
  "oldPhoneNumber": null,
  "firstName": "John",
  "lastName": "Smith",
  "addressLine1": "123 Maple Ave",
  "addressLine2": "Apt 4B",
  "zip": "62704",
  "city": "Springfield",
  "state": "IL",
  "iccid": "89014103219876543210",
  "billingImei": "356415123456789",
  "fan": "98765432",
  "attBan": "123456789012",
  "attBanPasscode": "123456",
  "planId": "101",
  "planName": "5GB Data Plan",
  "operationType": "new_activation",
  "activatedAt": "2024-11-14T20:11:30.000Z",
  "status": "ACTIVATED",
  "statusReason": "",
  "startBillingDate": "2024-10-24T00:00:00.000Z",
  "endBillingDate": "2024-11-24T00:00:00.000Z",
  "suspendedAt": null,
  "canceledAt": null
}]
```

**Key response fields:**
- `status` — `ACTIVATED`, `SUSPENDED`, `CANCELED` (also seen as `ACTIVE` in real responses)
- `attBan` — BAN needed for OTA Refresh
- `mobilitySubscriptionId` — the SOLO unique identifier (Customer ID in UI)

---

## 4.8 Change Subscriber's IMEI

Update the IMEI on a subscription.

**Endpoint:** `PATCH https://api.helixsolo.app/api/mobility-sub-ops/imei-plan`

**Request (array):**
```json
[{ "mobilitySubscriptionId": 1001, "imei": "356415123456789" }]
```

**Response (200):**
```json
{
  "successful": [{ "mobilitySubscriptionId": "1001", "billingImei": "356415123456789", "planId": "101", "planType": "custom" }],
  "failed": []
}
```

---

## 4.9 Change Subscriber's ICCID

Swap the SIM card (change ICCID) on a subscription.

**Endpoint:** `PATCH https://api.helixsolo.app/api/mobility-subscriber/iccid`

**Request (array):**
```json
[{ "subscriberNumber": "1234567890", "iccid": "89014103219876543210" }]
```

**Response (200):**
```json
{
  "successful": [{ "message": "Line with phone number 1234567890 was updated with ICCID 89014103219876543210", "mobilitySubscriptionId": "1001", "phoneNumber": "1234567890" }],
  "failed": []
}
```

---

## 4.10 Change Subscriber's Plan

Change the plan (and optionally IMEI) on a subscription. Verify plan+IMEI compatibility first using 4.1.

**Endpoint:** `PATCH https://api.helixsolo.app/api/mobility-sub-ops/imei-plan`

**Request (array):**
```json
[{ "mobilitySubscriptionId": 5000, "imei": "356789123456789", "plan": { "id": 68 } }]
```

To change plan only (keep same IMEI), still include the current IMEI.

**Response (200):**
```json
{
  "successful": [{ "mobilitySubscriptionId": "5000", "billingImei": "356789123456789", "planId": "68" }],
  "failed": []
}
```

**Note:** Same endpoint as 4.8 (IMEI change) — include `plan` to also change plan, or omit to only change IMEI.

---

## 4.11 Send OTA Update (Reset OTA)

Trigger OTA refresh for a subscriber's network profile.

**Endpoint:** `PATCH https://api.helixsolo.app/api/mobility-subscriber/reset-ota`

**Request (array):**
```json
[{ "ban": "123456789012", "subscriberNumber": "1234567890", "iccid": "89014103219876543210" }]
```

- `ban` — get from 4.7 response field `attBan`

**Response (200):**
```json
{
  "fulfilled": [{
    "status": "Active",
    "subscriberNumber": "1234567890",
    "serviceCharacteristic": [
      { "name": "subscriberStatus", "value": "Active" },
      { "name": "BLIMEI", "value": "356415123456789" },
      { "name": "sim", "value": "89014103219876543210" }
    ]
  }],
  "rejected": []
}
```

---

## 4.12 Reset Subscriber's Voicemail Password

**Endpoint:** `PATCH https://api.helixsolo.app/api/mobility-subscriber/reset-voicemail`

**Request (array):**
```json
[{ "ban": "123456789012", "subscriberNumber": "1234567890", "newPin": "5678" }]
```

- `newPin` — 4–12 digit number
- `ban` — must be exactly 12 characters

**Response (200):** Same structure as OTA refresh (fulfilled/rejected).

---

## 4.13 Bulk Activation

Activate multiple SIMs in one call.

**Endpoint:** `POST https://api.helixsolo.app/api/mobility-sub-ops/subscription`

**Request (array):** Each element is a standard activation object (same fields as 4.2).

**Response (201):**
```json
{ "successful": [{ "data": { ...activation_data... } }], "failed": [] }
```

---

## 4.14 Bulk BAN Pin Change

Change PIN codes for multiple BANs.

**Endpoint:** `PATCH https://api.helixsolo.app/api/mobility-account/ban/pin/bulk`

**Request:**
```json
{ "banIds": ["123456789012", "987654321098"] }
```

**Response (200):** Array of `{ "ban": "...", "passcode": "..." }` objects.

---

## 4.15 Add Note to Subscriber

**Endpoint:** `POST https://api.helixsolo.app/api/notes/add`

**Request:**
```json
{ "message": "Note text here", "internalOnly": true, "mobilitySubscriptionId": 1001 }
```

- `internalOnly: true` — only visible to your org
- `internalOnly: false` — visible to clients/resellers below you

**Response (200):**
```json
{ "status": "Note successfully added.", "details": { "id": 101, "message": "...", "internalOnly": true, "date": "..." } }
```

---

## 4.16 Update Subscriber's CTN (MDN Change)

Change the phone number (CTN) assigned to a subscription.

**Endpoint:** `PATCH https://api.helixsolo.app/api/mobility-subscriber/ctn`

**Request:**
```json
{ "mobilitySubscriptionId": 1001 }
```

**Response (200):**
```json
{
  "subscriberNumber": "9876543210",
  "newSubscriberNumber": "1234567890",
  "changeStatus": "SUCCESS",
  "mobilitySubscriptionId": 1001
}
```

**CRITICAL:** If changing to a number with a different area code ZIP, update the ZIP/address first using 4.4, then call this endpoint.

---

## 5. Get Mobility Subscribers (Paginated List)

Get a paginated list of all subscribers.

**Endpoint:** `POST https://api.helixsolo.app/api/mobility-subscriber/subscribers/search`

**Request:**
```json
{
  "pageNumber": 0,
  "pageSize": 25,
  "statuses": ["ACTIVATED", "CANCELED", "SUSPENDED"],
  "canceledAfter": "2025-08-01"
}
```

**Field notes:**
- All fields optional
- `pageNumber` — 0-indexed, default 0
- `pageSize` — default 25
- `statuses` — filter by status; default includes all three
- `canceledAfter` — ISO date; defaults to 45 days ago; max 6 months ago

**Response (200):**
```json
{
  "items": [
    {
      "mobilitySubscriptionId": "4056",
      "subscriber": {
        "number": "7327998621",
        "status": "ACTIVATED",
        "billingImei": "350765878789449",
        "iccid": "89014102334595823365",
        "eid": null,
        "planId": "1113",
        "org": { "id": "489", "type": "reseller" }
      }
    }
  ],
  "pagination": { "page": 1, "size": 25, "lastPage": true }
}
```

When `lastPage: true`, there are no more pages.

---

## Common Workflows

### Basic SIM Activation
1. Get token
2. (Optional) Check IMEI eligibility via 4.1
3. POST to 4.2 with IMEI, ICCID, subscriber info, address
4. Save returned `mobilitySubscriptionId`

### Fix Failed Activation
1. Get current subscription state via 4.7
2. If status is `ACTIVATION_FAILED`, use 4.3 to retry with corrected IMEI/ICCID/plan

### MDN Rotation (phone number change)
1. Get subscriber details via 4.7 to confirm current state
2. If new number has different area code: update address/ZIP via 4.4 first
3. Call 4.16 with `mobilitySubscriptionId` to assign new number

### OTA Refresh
1. Get subscriber details via 4.7 to get `attBan`, `phoneNumber`, `iccid`
2. Call 4.11 with `ban`, `subscriberNumber`, `iccid`

### Swap SIM Card (new physical SIM, same number)
1. Call 4.9 with `subscriberNumber` and new `iccid`

### Change Plan
1. Verify new plan is compatible with IMEI via 4.1
2. Call 4.10 with `mobilitySubscriptionId`, current IMEI, and new `plan.id`

---

## Common Issues & Solutions

| Error | Cause | Fix |
|-------|-------|-----|
| Token expired | 24-hour limit hit | Re-authenticate |
| IMEI not found (406) | Invalid IMEI or wrong skuId | Check format; verify with 4.1 |
| ICCID already active | Duplicate activation attempt | Query 4.7 first |
| Activation retry failed | Status is not ACTIVATION_FAILED | Can only retry failed activations |
| Status change rejected | Wrong reasonCodeId | Use 4.5 to get valid codes |
| OTA rejected | Wrong BAN | Get `attBan` from 4.7 response |
| MDN change failed | ZIP mismatch for new area code | Update address via 4.4 first |
| Voicemail reset 400 | BAN must be exactly 12 chars | Pad or verify BAN length |

---

## Support

Contact: dan@wingalpha.com
