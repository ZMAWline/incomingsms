# Helix HX-AX API Reference

**Last Updated:** 01/13/2025

## Overview

The Helix HX-AX API manages cellular SIM card activation and management for T-Mobile data plans. All API endpoints require bearer token authentication.

## Six Core Operations

| Step | Action | Purpose |
|------|--------|---------|
| 1 | Token Authentication | Retrieve bearer token using credentials |
| 2 | Activation | Activate a SIM using IMEI + plan |
| 3 | Query Sub ID | Get SIM and subscriber info |
| 4 | Service ZIP Change | Update the service ZIP code |
| 5 | MDN Change | Change MDN associated with ICCID |
| 6 | Cancel | Cancel service for the ICCID |

---

## 1. Token Authentication

**Endpoint:** `POST https://auth.helixsolo.app/oauth/token`

**Headers:**
- `Content-Type: application/json`

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
  "scope": "read:current_user update:current_user_metadata ...",
  "expires_in": 86400,
  "token_type": "Bearer"
}
```

**Important:** Credentials are shared separately. Use the token in all subsequent requests via `Authorization: Bearer YOUR_TOKEN` header.

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
  "BAN": "287355952378",
  "FAN": "63654144",
  "activationType": "new_activation",
  "subscriber": {
    "firstName": "SUB",
    "lastName": "NINE"
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
- `address1`, `city`, `state`, `zipCode` - Customer address
- `imei` - Device IMEI number
- `iccid` - SIM card ICCID

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
    "phoneNumber": "4695042393",
    "iccid": "89148000006998837205",
    "firstName": "SUB",
    "lastName": "NINE",
    "addressLine1": "5600 Tennyson Pkwy",
    "city": "Plano",
    "state": "TX",
    "zip": "75024",
    "planName": "Wing - Tiered",
    "status": "CANCELED",
    "activatedAt": "2025-07-17T15:56:40.101Z",
    "canceledAt": "2025-07-17T16:15:27.101Z"
  }
]
```

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

**Critical Note:** If assigning a new area code tied to a different ZIP code, complete the ZIP code change (Section 4) BEFORE initiating the MDN change.

---

## 6. Cancel

Cancel an active SIM subscription.

**Endpoint:** `PATCH https://api.helixsolo.app/api/mobility-subscriber/ctn`

**Headers:**
- `Content-Type: application/json`
- `Authorization: Bearer YOUR_TOKEN`

**Request:**
```json
{
  "mobilitySubscriptionId": SUBID,
  "subscriberNumber": "CURRENT_MDN",
  "reasonCode": "CAN",
  "reasonCodeId": 1,
  "subscriberState": "Cancel"
}
```

**Note:** The request must be an **object** (not an array), and `mobilitySubscriptionId` is required.

**Response:**
```json
{
  "subscriberNumber": "9452134302",
  "newSubscriberNumber": "9453384261",
  "changeStatus": "SUCCESS",
  "mobilitySubscriptionId": 89660
}
```

---

## Common Issues & Solutions

**Token Expired:** Tokens expire in 86400 seconds (24 hours). Re-authenticate when needed.

**Invalid IMEI/ICCID:** Verify format and that SIM hasn't been activated already.

**ZIP Code and MDN:** Always update ZIP first if changing area codes to different regions.

**Address Fields Required:** All address fields (address1, city, state, zipCode) must be provided.

---

## Support

Contact: dan@wingalpha.com
