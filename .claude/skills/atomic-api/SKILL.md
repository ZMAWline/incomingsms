---
name: atomic-api
description: Expert knowledge of the AT&T ATOMIC API for managing AT&T SIM card activation, subscriber management, and lifecycle operations. Use when working with AT&T SIM activations, subscriber inquiries, status changes (suspend/restore/deactivate/reconnect), MDN swaps, OTA refreshes, or troubleshooting API issues. Replaces helix-api for AT&T operations.
---

# AT&T ATOMIC API Expert Skill

Expert in the AT&T ATOMIC Wholesale API for AT&T SIM card activation and subscriber management via Wing Alpha / EB.

## What This Skill Covers

6 API operations on a single endpoint:

| # | Operation | requestType | Purpose |
|---|-----------|-------------|---------|
| 1 | Activate New Subscriber | `Activate` | Activate SIM + IMEI + address + plan |
| 2 | Subscriber Inquiry | `subsriberInquiry` | Look up subscriber by MSISDN or SIM |
| 3 | Suspend | `suspendSubscriber` | Temporarily suspend service |
| 3 | Restore | `restoreSubscriber` | Restore a suspended subscriber |
| 3 | Deactivate | `deactivateSubscriber` | Permanently cancel/deactivate |
| 3 | Reconnect | `reconnectSubscriber` | Reconnect a deactivated subscriber |
| 4 | Swap MSISDN | `swapMSISDN` | Change MDN based on ZIP code |
| 5 | Update Subscriber Info | `UpdateSubscriberInfo` | Update name/address on subscriber |
| 6 | Resend OTA Profile | `resendOtaProfile` | Trigger OTA network refresh |

## Quick Reference

**Endpoint:** `POST https://solutionsatt-atomic.telgoo5.com:22712`

**Authentication:** Credentials in `session` block of every request (no OAuth):
```json
"session": {
  "userName": "ezbiz",
  "token": "EZ(3928_*=wH)le",
  "pin": "EZ32726"
}
```

**Request Wrapper:** All requests use `wholeSaleApi` envelope:
```json
{"wholeSaleApi": {
  "session": { ... },
  "wholeSaleRequest": { ... }
}}
```

**Mandatory Plan Code:** Always use `ATTNOVOICE` for activations.

**Common Identifiers:**
- `MSISDN` — 10-digit phone number (MDN)
- `sim` — SIM card ICCID
- `imei` — Device IMEI
- `BAN` — Billing Account Number (returned from activation/inquiry)

## Key Workflows

### Activation Sequence
1. **Activate** — POST with SIM, IMEI, name, address, `plan: "ATTNOVOICE"`
2. **Subscriber Inquiry** — Verify activation, get assigned MDN and BAN

### MDN Change Sequence (Area Code Change)
1. **Subscriber Inquiry** — Verify current address
2. **Update Subscriber Info** — Update PPU address to target ZIP
3. **Swap MSISDN** — Change MDN (new area code based on current ZIP)
4. **Subscriber Inquiry** — Verify new MDN

### Status Change Reference

| Action | requestType | reasonCode |
|--------|-------------|------------|
| Suspend | `suspendSubscriber` | `NPG` |
| Restore | `restoreSubscriber` | `CR` |
| Deactivate | `deactivateSubscriber` | `DD` |
| Reconnect | `reconnectSubscriber` | (blank) |

## Request Examples

### 1. Activate New Subscriber
```json
{"wholeSaleApi": {
  "session": {
    "userName": "ezbiz",
    "token": "EZ(3928_*=wH)le",
    "pin": "EZ32726"
  },
  "wholeSaleRequest": {
    "requestType": "Activate",
    "partnerTransactionId": "TransID123",
    "imei": "YOUR_IMEI",
    "sim": "YOUR_SIM",
    "eSim": "N",
    "EID": "",
    "BAN": "",
    "firstName": "FIRST_NAME",
    "lastName": "LAST_NAME",
    "streetNumber": "YOUR_STREET_NUMBER",
    "streetDirection": "",
    "streetName": "YOUR_STREET_NAME",
    "zip": "YOUR_ZIP",
    "plan": "ATTNOVOICE",
    "portMdn": ""
  }
}}
```

**Response:**
```json
{
  "wholeSaleApi": {
    "session": {"userName": "ezbiz", "timestamp": "..."},
    "wholeSaleResponse": {
      "requestType": "Activate",
      "statusCode": "00",
      "description": "Sending Request To ATT.",
      "Result": {
        "MSISDN": "ASSIGNED_MDN",
        "status": "Reserved",
        "BAN": "ASSIGNED_BAN"
      }
    }
  }
}
```

### 2. Subscriber Inquiry
```json
{"wholeSaleApi": {
  "session": {
    "userName": "ezbiz",
    "token": "EZ(3928_*=wH)le",
    "pin": "EZ32726"
  },
  "wholeSaleRequest": {
    "requestType": "subsriberInquiry",
    "MSISDN": "YOUR_MDN",
    "sim": "YOUR_SIM"
  }
}}
```
Returns: attStatus, BAN, activationDate, plan info, device info (BLIMEI/NWIMEI), address, SOC codes.

### 3. Suspend Subscriber
```json
{"wholeSaleApi": {
  "session": {
    "userName": "ezbiz",
    "token": "EZ(3928_*=wH)le",
    "pin": "EZ32726"
  },
  "wholeSaleRequest": {
    "requestType": "suspendSubscriber",
    "MSISDN": "YOUR_MDN",
    "reasonCode": "NPG"
  }
}}
```

### 4. Restore Subscriber
```json
{"wholeSaleApi": {
  "session": {
    "userName": "ezbiz",
    "token": "EZ(3928_*=wH)le",
    "pin": "EZ32726"
  },
  "wholeSaleRequest": {
    "requestType": "restoreSubscriber",
    "MSISDN": "YOUR_MDN",
    "reasonCode": "CR"
  }
}}
```

### 5. Deactivate Subscriber
```json
{"wholeSaleApi": {
  "session": {
    "userName": "ezbiz",
    "token": "EZ(3928_*=wH)le",
    "pin": "EZ32726"
  },
  "wholeSaleRequest": {
    "requestType": "deactivateSubscriber",
    "MSISDN": "YOUR_MDN",
    "reasonCode": "DD"
  }
}}
```

### 6. Reconnect Subscriber
```json
{"wholeSaleApi": {
  "session": {
    "userName": "ezbiz",
    "token": "EZ(3928_*=wH)le",
    "pin": "EZ32726"
  },
  "wholeSaleRequest": {
    "requestType": "reconnectSubscriber",
    "MSISDN": "YOUR_MDN",
    "reasonCode": ""
  }
}}
```

### 7. Swap MSISDN (MDN Change)
```json
{"wholeSaleApi": {
  "session": {
    "userName": "ezbiz",
    "token": "EZ(3928_*=wH)le",
    "pin": "EZ32726"
  },
  "wholeSaleRequest": {
    "requestType": "swapMSISDN",
    "MSISDN": "CURRENT_MDN",
    "zipCode": "TARGET_ZIP_CODE"
  }
}}
```
**Note:** New MDN area code is based on the ZIP currently associated with the MDN. Update address first via UpdateSubscriberInfo if targeting a specific area code.

### 8. Update Subscriber Information
```json
{"wholeSaleApi": {
  "session": {
    "userName": "ezbiz",
    "token": "EZ(3928_*=wH)le",
    "pin": "EZ32726"
  },
  "wholeSaleRequest": {
    "requestType": "UpdateSubscriberInfo",
    "MSISDN": "YOUR_MDN",
    "firstName": "NEW_FIRST_NAME",
    "lastName": "NEW_LAST_NAME",
    "address": {
      "streetNumber": "YOUR_STREET_NUMBER",
      "streetName": "YOUR_STREET_NAME",
      "streetDirection": "",
      "zipCode": "YOUR_ZIP"
    }
  }
}}
```

### 9. Resend OTA Profile
```json
{"wholeSaleApi": {
  "session": {
    "userName": "ezbiz",
    "token": "EZ(3928_*=wH)le",
    "pin": "EZ32726"
  },
  "wholeSaleRequest": {
    "requestType": "resendOtaProfile",
    "MSISDN": "YOUR_MDN",
    "sim": "YOUR_SIM"
  }
}}
```

## Critical Enforcement Rules

1. **Only use assigned credentials** (ezbiz / EZ32726)
2. **Always use plan code `ATTNOVOICE`** for activations
3. **Always verify MDN after activation** using Subscriber Inquiry
4. **Use correct reasonCode** for each status change action (see table above)
5. **For area code changes:** Update address first, then swap MSISDN

## Helix to ATOMIC Migration Notes

| Helix Concept | ATOMIC Equivalent |
|---------------|-------------------|
| OAuth Bearer token | Session credentials in every request |
| `subscriberNumber` | `MSISDN` |
| `iccid` | `sim` |
| `mobilitySubscriptionId` | Use `MSISDN` directly |
| `attBan` | `BAN` (in responses) |
| Multiple endpoints | Single endpoint, different `requestType` |
| 4.6 Change Status | Separate requestTypes per action |
| 4.16 Update CTN/MDN | `swapMSISDN` |
| 4.4 Update Subscriber | `UpdateSubscriberInfo` |
| 4.11 Send OTA | `resendOtaProfile` |

## Support

For API issues contact: dan@wingalpha.com

## How I Can Help

- Write properly formatted ATOMIC API requests
- Debug API errors and responses
- Guide through activation and MDN change workflows
- Migrate Helix-based scripts to ATOMIC
- Build status change automation
