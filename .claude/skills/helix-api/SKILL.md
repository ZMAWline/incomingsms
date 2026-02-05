---
name: helix-api-expert
description: Expert knowledge of the Helix HX-AX API for managing T-Mobile SIM card activation, activation workflows, and subscriber management. Use when working with SIM activation requests, troubleshooting API issues, writing activation scripts, changing subscriber details, or building workflows that interact with the Helix platform. Helps explain API endpoints, write request payloads, debug responses, and guide through multi-step operations.
---

# Helix API Expert Skill

This skill makes you an expert in the Helix HX-AX API for managing cellular SIM cards and T-Mobile data plans.

## What This Skill Covers

The Helix API handles six core operations:

1. **Token Authentication** - Get bearer tokens for API access (24-hour validity)
2. **SIM Activation** - Activate new SIM cards with IMEI, ICCID, subscriber info
3. **Query Subscriber** - Look up SIM and subscriber details by mobilitySubscriptionId
4. **ZIP Code Updates** - Change service address/ZIP (required before MDN change for new area codes)
5. **MDN Changes** - Change phone numbers assigned to SIMs
6. **Subscriber Status** - Suspend, Restore (Unsuspend), or Cancel service

## When to Use This Skill

Use this skill when you need to:

- **Understand an API endpoint** - How to format requests, what fields are required, expected responses
- **Write activation scripts** - Build Python, Bash, or other code to activate SIMs automatically
- **Debug API errors** - Understand response codes, troubleshoot failed requests
- **Execute multi-step workflows** - Like changing ZIP code before changing MDN (order matters!)
- **Explain the API** - Break down how authentication works, what each endpoint does
- **Build automation** - Create batches of SIM activations or management scripts

## Quick Reference

**Base URLs:**
- Authentication: `https://auth.helixsolo.app/oauth/token`
- API: `https://api.helixsolo.app/api/`

**Authentication:** All requests need `Authorization: Bearer YOUR_TOKEN` header after getting a token.

**Common Fields:**
- `mobilitySubscriptionId` - The unique ID for a SIM subscription (returned from activation)
- `MDN` / `subscriberNumber` - The phone number assigned to the SIM
- `ICCID` - The SIM card's integrated circuit card identifier
- `IMEI` - The device's international mobile equipment identity

## Detailed API Reference

For complete endpoint documentation, request/response formats, and field descriptions, see [helix_api_reference.md](references/helix_api_reference.md).

### Key Workflows

#### Basic SIM Activation Flow
1. Get a token (valid 24 hours)
2. Call Activation endpoint with IMEI, ICCID, subscriber info, and address
3. Save the `mobilitySubscriptionId` returned
4. Use that ID to query, update, or cancel the subscription later

#### Changing Phone Number with New Area Code
⚠️ **Important order:**
1. Update ZIP code first (Section 4)
2. Then change MDN/phone number (Section 5)

If you skip this order, the phone number assignment may fail.

#### Finding Subscription Details
1. Use Query Sub ID endpoint
2. Provide the `mobilitySubscriptionId`
3. Response includes all subscriber data, current phone number, status, etc.

## Example: Simple Activation Request

```bash
# 1. Get token
curl -X POST https://auth.helixsolo.app/oauth/token \
  -H "Content-Type: application/json" \
  -d '{
    "grant_type": "password",
    "client_id": "YOUR_CLIENT_ID",
    "audience": "https://dev-z8ucfxd1iqdj7bzm.us.auth0.com/api/v2/",
    "username": "YOUR_USERNAME",
    "password": "YOUR_PASSWORD"
  }'

# 2. Activate SIM (use token from step 1)
curl -X POST https://api.helixsolo.app/api/mobility-activation/activate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "clientId": 230,
    "plan": {"id": 985},
    "BAN": "287355952378",
    "FAN": "63654144",
    "activationType": "new_activation",
    "subscriber": {
      "firstName": "John",
      "lastName": "Doe"
    },
    "address": {
      "address1": "123 Main St",
      "city": "Dallas",
      "state": "TX",
      "zipCode": "75001"
    },
    "service": {
      "imei": "123456789012345",
      "iccid": "89148000006998837205"
    }
  }'
```

## Common Troubleshooting

**"Invalid token"** → Token expired (24 hour limit). Get a new one.

**"IMEI not found"** → Check format is correct, SIM may already be activated.

**"Address required"** → All fields (address1, city, state, zipCode) must be included.

**"MDN change failed"** → Did you update the ZIP code first if changing area codes?

**Status change failed** → Use correct reasonCodeId: Suspend=22, Restore=35, Cancel=1

## Subscriber Status Changes

| Action | subscriberState | reasonCodeId |
|--------|-----------------|--------------|
| Suspend | `Suspend` | `22` |
| Restore | `Unsuspend` | `35` |
| Cancel | `Cancel` | `1` |

## How I Can Help

Tell me what you're trying to do with Helix, and I can:
- Explain how a specific endpoint works
- Write code/scripts to activate or manage SIMs
- Debug API errors and responses
- Guide you through complex workflows
- Build batch activation scripts
