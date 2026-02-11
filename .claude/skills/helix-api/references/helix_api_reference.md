# Helix HX-AX API Reference

**Last Updated:** 02/09/2026

## Overview

The Helix HX-AX API manages cellular SIM card activation and management for T-Mobile data plans. All API endpoints require bearer token authentication.

## Seven Core Operations

| Step | Action | Purpose |
|------|--------|---------|
| 1 | Token Authentication | Retrieve bearer token using credentials |
| 2 | Activation | Activate a SIM using IMEI + plan |
| 3 | Query Sub ID | Get SIM and subscriber info |
| 4 | Service ZIP Change | Update the service ZIP code |
| 5 | MDN Change | Change MDN associated with ICCID |
| 6 | Change Subscriber Status | Suspend / Restore / Cancel service |
| 7 | OTA Refresh | Trigger an OTA refresh/reset for a subscriber |

---

## 1. Token Authentication

**Endpoint:** `POST https://auth.helixsolo.app/oauth/token`

**Headers:**
- `Content-Type: application/json`

**Request:**
```json
{
  "grant_type": "password",
  "client_id": "4cor0JEQHxfwTdlAkGdCfUWiX8Q2sXzk",
  "audience": "https://dev-z8ucfxd1iqdj7bzm.us.auth0.com/api/v2/",
  "username": "svc-api9",
  "password": "Wing1212@!"
}
```

**Response:**
```json
{
  "access_token": "eyJhbGciOiJSUzI1NiIs...",
  "scope": "read:current_user update:current_user_metadata ...",
  "expires_in": 86400,
  "token_type": "Bearer"
}
```

**Important:** Use the token in all subsequent requests via `Authorization: Bearer YOUR_TOKEN` header. Tokens expire in 24 hours.

---

## 2. Activation

Activate a new SIM card with subscriber information and address.

**Endpoint:** `POST https://api.helixsolo.app/api/mobility-activation/activate`

**Headers:**
- `Content-Type: application/json`
- `Authorization: Bearer YOUR_TOKEN`

**Request:**
```json
{
  "clientId": 230,
  "plan": {
    "id": 985
  },
  "FAN": "63654144",
  "activationType": "new_activation",
  "subscriber": {
    "firstName": "FIRST_NAME",
    "lastName": "LAST_NAME"
  },
  "address": {
    "address1": "ADDRESS_LINE_1",
    "city": "CITY",
    "state": "STATE_CODE",
    "zipCode": "ZIP_CODE"
  },
  "service": {
    "imei": "YOUR_IMEI",
    "iccid": "YOUR_ICCID"
  }
}
```

**Response:**
```json
{
  "mobilitySubscriptionId": 38106
}
```

**Fields to Update:**
- `address1`, `city`, `state`, `zipCode` - Service address
- `imei` - Device IMEI number (15 digits)
- `iccid` - SIM card ICCID (19-20 digits)
- `firstName`, `lastName` - Subscriber name

---

## 3. Query Sub ID

Fetch subscriber and SIM card details by subscription ID.

**Endpoint:** `POST https://api.helixsolo.app/api/mobility-subscriber/details`

**Headers:**
- `Content-Type: application/json`
- `Authorization: Bearer YOUR_TOKEN`

**Request:**
```json
{
  "mobilitySubscriptionId": SUBID
}
```

**Response (Example):**
```json
[
  {
    "mobilitySubscriptionId": "40033",
    "mobilitySubscriptionDetailsId": "40033",
    "skuId": "11",
    "phoneNumber": "4695042393",
    "oldPhoneNumber": "6468474546",
    "firstName": "SUB",
    "lastName": "NINE",
    "addressLine1": "5600 Tennyson Pkwy",
    "addressLine2": null,
    "streetName": "TENNYSON",
    "streetType": "Pkwy",
    "streetDirection": "",
    "streetNumber": "5600",
    "zip": "75024",
    "city": "Plano",
    "state": "TX",
    "iccid": "89148000006998837205",
    "eid": null,
    "billingImei": "355826084427185",
    "esimActivationCode": null,
    "syncDate": null,
    "fan": "V26496855",
    "attBan": null,
    "attBanPasscode": null,
    "planId": "739",
    "planName": "Wing - Tiered",
    "operationType": "new_activation",
    "activatedAt": "2025-07-17T15:56:40.101Z",
    "status": "ACTIVE",
    "statusReason": "SUCCESSFULLY PROCESSED THE REQUEST",
    "resellerId": null,
    "clientId": "189",
    "networkType": "LTE",
    "businessEntityName": "SUB1",
    "scheduledStatus": null,
    "scheduledDate": null,
    "startBillingDate": "2025-07-05T00:00:00.000Z",
    "endBillingDate": "2025-08-05T00:00:00.000Z",
    "suspendedAt": null,
    "canceledAt": null
  }
]
```

**Key Response Fields:**
- `status` - Current status: `ACTIVE`, `SUSPENDED`, `CANCELED`
- `statusReason` - Detailed status message
- `phoneNumber` - Current MDN
- `oldPhoneNumber` - Previous MDN (if changed)

---

## 4. Service ZIP Code Change

Update the ZIP code (and address) associated with an active SIM.

**Endpoint:** `PATCH https://api.helixsolo.app/api/mobility-subscriber/details`

**Headers:**
- `Content-Type: application/json`
- `Authorization: Bearer YOUR_TOKEN`

**Request:**
```json
[
  {
    "subscriberNumber": "MDN",
    "address": {
      "address1": "ADDRESS_LINE_1",
      "city": "CITY",
      "state": "STATE_CODE",
      "zipCode": "ZIP_CODE"
    }
  }
]
```

**Response:**
```json
[
  {
    "status": "fulfilled",
    "value": {
      "mobility_subscription_id": "38105",
      "subscriberNumber": "9726546901",
      "address_line_1": "5600 Tennyson Pkwy",
      "address_line_2": null,
      "street_number": "5600",
      "street_name": "TENNYSON",
      "street_type": "Pkwy",
      "street_direction": "",
      "zip": "75024",
      "city": "Plano",
      "state": "TX"
    }
  }
]
```

---

## 5. MDN Change

Change the phone number assigned to a SIM.

**Endpoint:** `PATCH https://api.helixsolo.app/api/mobility-subscriber/ctn`

**Headers:**
- `Content-Type: application/json`
- `Authorization: Bearer YOUR_TOKEN`

**Request:**
```json
{
  "mobilitySubscriptionId": SUBID
}
```

**Response:**
```json
{
  "subscriberNumber": "6462309413",
  "newSubscriberNumber": "9726546901",
  "changeStatus": "SUCCESS",
  "mobilitySubscriptionId": 38105
}
```

**CRITICAL NOTE:** If assigning a new area code tied to a different ZIP code, complete the ZIP code change (Section 4) **BEFORE** initiating the MDN change.

---

## 6. Change Subscriber Status (Suspend / Restore / Cancel)

Use this endpoint to change the current status of a subscriber. Supports three lifecycle actions.

**Endpoint:** `PATCH https://api.helixsolo.app/api/mobility-subscriber/ctn`

**Headers:**
- `Content-Type: application/json`
- `Authorization: Bearer YOUR_TOKEN`

### Suspend

Temporarily suspend service.

**Request:**
```json
[
  {
    "subscriberNumber": "CURRENT_MDN",
    "reasonCode": "CR",
    "reasonCodeId": 22,
    "subscriberState": "Suspend"
  }
]
```

### Restore (Unsuspend)

Reactivate a previously suspended subscriber.

**Request:**
```json
[
  {
    "subscriberNumber": "CURRENT_MDN",
    "reasonCode": "CR",
    "reasonCodeId": 35,
    "subscriberState": "Unsuspend"
  }
]
```

### Cancel

Permanently disconnect service.

**Request:**
```json
[
  {
    "subscriberNumber": "CURRENT_MDN",
    "reasonCode": "CAN",
    "reasonCodeId": 1,
    "subscriberState": "Cancel"
  }
]
```

**Response (Cancel Example):**
```json
{
  "fulfilled": [
    {
      "?xml": {
        "@_version": "1.0",
        "@_encoding": "UTF-8"
      },
      "resellerOrderResponse": {
        "messageHeader": {
          "vendorId": "HELIX",
          "requestType": "ORDER",
          "orderType": "MNTMLND",
          "referenceNumber": "ChangeState_1752773879360",
          "returnURL": "http://vz-api.helixsolo.app/api/mobility-verizon/returnURL"
        },
        "orderResponse": {
          "returnCode": "00",
          "returnMessage": "SUCCESSFULLY PROCESSED THE REQUEST"
        }
      },
      "reasonCodeId": 1,
      "subscriberState": "Cancel",
      "subscriberNumber": "4697997136"
    }
  ],
  "rejected": []
}
```

### Resume (From Cancel)

Reactivate a previously canceled subscriber.

**Request:**
```json
[
  {
    "subscriberNumber": "CURRENT_MDN",
    "reasonCode": "BBL",
    "reasonCodeId": 20,
    "subscriberState": "Resume On Cancel"
  }
]
```

**Response:**
```json
{
  "fulfilled": [
    {
      "category": {
        "id": "12",
        "name": "Mobility Services"
      },
      "effectiveDate": "immediately",
      "href": "/mobility/service/6468842752",
      "name": "",
      "status": "Active",
      "subscriberNumber": "6468842752",
      "reasonCodeId": 20,
      "subscriberState": "Resume On Cancel"
    }
  ],
  "rejected": []
}
```

### Status Change Reference

| Action | subscriberState | reasonCode | reasonCodeId |
|--------|-----------------|------------|--------------|
| Suspend | `Suspend` | `CR` | `22` |
| Restore | `Unsuspend` | `CR` | `35` |
| Cancel | `Cancel` | `CAN` | `1` |
| Resume (From Cancel) | `Resume On Cancel` | `BBL` | `20` |

---

## 7. OTA Refresh (Reset OTA)

Trigger an OTA refresh/reset for a subscriber. Useful when the device/SIM needs a network profile refresh.

**Endpoint:** `PATCH https://api.helixsolo.app/api/mobility-subscriber/reset-ota`

**Headers:**
- `Content-Type: application/json`
- `Authorization: Bearer YOUR_TOKEN`

**Request:**
```json
[
  {
    "ban": "BAN_NUMBER",
    "subscriberNumber": "CURRENT_MDN",
    "iccid": "ICCID"
  }
]
```

**Fields to Update:**
- `ban` - The BAN (billing account number). Obtain from Query Sub ID response under `attBan`.
- `subscriberNumber` - Current MDN of the subscriber
- `iccid` - SIM card ICCID

**Response:**
```json
{
  "fulfilled": [
    {
      "category": {
        "id": "12",
        "name": "Mobility Services"
      },
      "href": "/mobility/service/6468842752",
      "name": "",
      "serviceCharacteristic": [
        { "name": "subscriberStatus", "value": "S" },
        { "name": "statusEffectiveDate", "value": "2026-01-19Z" },
        { "name": "statusReasonCode", "value": "DLC" },
        { "name": "subscriberActivationDate", "value": "2026-01-16Z" }
      ],
      "serviceSpecification": {
        "href": "/catalogManagement/serviceSpecification/apexMobilityPlan",
        "id": "apexMobilityPlan"
      },
      "status": "Suspended",
      "subscriberNumber": "6468842752"
    }
  ],
  "rejected": []
}
```

**NOTE:** The `ban` (BAN) required for this call can be obtained from the **Query Sub ID** response — use the value returned under `attBan`.

---

## Common Issues & Solutions

**Token Expired:** Tokens expire in 86400 seconds (24 hours). Re-authenticate when needed.

**Invalid IMEI/ICCID:** Verify format and that SIM hasn't been activated already.

**ZIP Code and MDN:** Always update ZIP first if changing area codes to different regions.

**Address Fields Required:** All address fields (address1, city, state, zipCode) must be provided.

**Status Change Failed:** Ensure `subscriberNumber` is the current MDN and use the correct `reasonCodeId` for the action.

---

## Support

Contact: dan@wingalpha.com
