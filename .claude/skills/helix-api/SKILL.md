---
name: helix-api-expert
description: Expert knowledge of the Helix HX-AX API for managing T-Mobile SIM card activation, activation workflows, and subscriber management. Use when working with SIM activation requests, troubleshooting API issues, writing activation scripts, changing subscriber details, or building workflows that interact with the Helix platform. Helps explain API endpoints, write request payloads, debug responses, and guide through multi-step operations.
---

# Helix API Expert Skill

Expert in the Helix SOLO Mobility API (v1.4) for AT&T SIM card activation and subscriber management.

## What This Skill Covers

16 endpoint groups across two major sections:

**Section 4 — AT&T Mobility Endpoints:**
1. **Check IMEI Eligibility** (4.1) — Validate IMEI for a plan/carrier before activating
2. **Single Unit Activation** (4.2) — Activate one SIM with IMEI, ICCID, subscriber info
3. **Retry/Update Activation** (4.3) — Retry a failed activation, change IMEI/ICCID/plan
4. **Update Subscriber Details** (4.4) — Change name and/or address
5. **Get Reason Codes** (4.5) — Retrieve all status change reason codes
6. **Change Subscriber Status** (4.6) — Suspend, Unsuspend, Cancel, Resume On Cancel
7. **Get Subscriber Details** (4.7) — Look up full subscriber info by phone or subscription ID
8. **Change IMEI** (4.8) — Update the device IMEI on a subscription
9. **Change ICCID** (4.9) — Swap the physical SIM card
10. **Change Plan** (4.10) — Switch to a different rate plan (checks IMEI compatibility)
11. **Send OTA Update** (4.11) — Trigger over-the-air refresh of network profile
12. **Reset Voicemail Password** (4.12) — Change the voicemail PIN
13. **Bulk Activation** (4.13) — Activate multiple SIMs in one call
14. **Bulk BAN Pin Change** (4.14) — Update PINs for multiple billing accounts
15. **Add Note** (4.15) — Attach a note to a subscriber record
16. **Update CTN/MDN** (4.16) — Change the phone number on a subscription

**Section 5 — Get Mobility Subscribers:**
- Paginated list of all subscribers with status filtering and cancellation date filter

## Quick Reference

**Base URLs:**
- Auth: `https://auth.helixsolo.app/oauth/token`
- API: `https://api.helixsolo.app/api/`

**Authorization:** `Authorization: Bearer YOUR_TOKEN` (24-hour tokens)

**Common identifiers:**
- `mobilitySubscriptionId` — SOLO unique ID for a subscription (returned from activation; called "Customer ID" in UI)
- `subscriberNumber` — The 10-digit phone number (MDN/CTN)
- `iccid` — SIM card identifier
- `imei` — Device identifier
- `attBan` — AT&T Billing Account Number (from 4.7 response; needed for OTA refresh)

For complete endpoint documentation, request/response formats, and examples, see [helix_api_reference.md](references/helix_api_reference.md).

## Key Workflows

### Basic SIM Activation
1. Get token
2. (Optional) Check IMEI eligibility via 4.1
3. POST to 4.2 with IMEI, ICCID, subscriber info, address
4. Save returned `mobilitySubscriptionId`

### Retry Failed Activation
1. Subscription must be in `ACTIVATION_FAILED` status
2. PATCH to 4.3 with `mobilitySubscriptionId` in URL + corrected fields in body

### MDN Change (Phone Number Rotation)
⚠️ **Order matters if changing area codes:**
1. Update address/ZIP via 4.4 first
2. Then call 4.16 with `mobilitySubscriptionId`

### OTA Refresh
1. Get subscriber details via 4.7 → note `attBan`, `phoneNumber`, `iccid`
2. PATCH 4.11 with `{ ban, subscriberNumber, iccid }`

### Swap Physical SIM
- PATCH 4.9 with `subscriberNumber` + new `iccid`

### Change Plan
1. Verify compatibility: GET 4.1 with IMEI
2. PATCH 4.10 with `mobilitySubscriptionId`, IMEI, `plan.id`

## Subscriber Status Quick Reference

| Action | subscriberState | reasonCode | reasonCodeId |
|--------|-----------------|------------|--------------|
| Suspend | `Suspend` | `CR` | `22` |
| Restore | `Unsuspend` | `CR` | `35` |
| Cancel | `Cancel` | `CAN` | `1` |
| Resume (From Cancel) | `Resume On Cancel` | `BBL` | `20` |

## Example: Activation

```bash
# 1. Get token
curl -X POST https://auth.helixsolo.app/oauth/token \
  -H "Content-Type: application/json" \
  -d '{"grant_type":"password","client_id":"YOUR_CLIENT_ID","audience":"https://dev-z8ucfxd1iqdj7bzm.us.auth0.com/api/v2/","username":"YOUR_USERNAME","password":"YOUR_PASSWORD"}'

# 2. Activate SIM
curl -X POST https://api.helixsolo.app/api/mobility-activation/activate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "resellerId": 230,
    "plan": {"id": 985},
    "FAN": "63654144",
    "activationType": "new_activation",
    "subscriber": {"firstName": "John", "lastName": "Doe"},
    "address": {"address1": "123 Main St", "city": "Dallas", "state": "TX", "zipCode": "75001"},
    "service": {"imei": "123456789012345", "iccid": "89148000006998837205"}
  }'
```

## Common Troubleshooting

| Error | Fix |
|-------|-----|
| Token expired | Re-authenticate (24h limit) |
| IMEI not found (406) | Check format; verify with 4.1 |
| ICCID already active | Query 4.7 first to confirm state |
| Activation retry failed | Status must be `ACTIVATION_FAILED` |
| OTA rejected | Get correct `attBan` from 4.7 |
| MDN change failed | Update ZIP via 4.4 first if new area code |
| Status change rejected | Use 4.5 to get valid reason codes |
| Voicemail reset 400 | BAN must be exactly 12 characters |

## How I Can Help

- Explain any endpoint and write properly formatted request payloads
- Debug API errors and responses
- Write activation/management scripts in any language
- Guide through complex multi-step workflows
- Build batch processing logic for bulk operations
