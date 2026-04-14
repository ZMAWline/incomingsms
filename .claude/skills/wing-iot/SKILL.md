---
name: wing-iot
description: Expert knowledge of the AT&T IoT API (Wing Tel) for managing IoT SIM activations and MDN changes. Use when working with Wing IoT SIMs, activating devices, checking device status, or changing between dialable and non-dialable MDNs. Simpler API than ATOMIC - uses Basic Auth and REST endpoints.
---

# AT&T IoT API Expert Skill (Wing Tel)

Expert in the AT&T IoT REST API for Wing Tel IoT SIM management.

## What This Skill Covers

3 core operations:

| Operation | Method | Endpoint | Purpose |
|-----------|--------|----------|---------|
| Activate Device | PUT | `/api/v1/devices/{iccid}` | Activate SIM with dialable MDN |
| Get Device | GET | `/api/v1/devices/{iccid}` | Check device status and MDN |
| Change MDN | PUT | `/api/v1/devices/{iccid}` | Switch dialable ↔ non-dialable |

## Quick Reference

**Base URL:** `https://restapi19.att.com/rws/api/`

**Authentication:** Basic Auth
- Username: `SUBNINE`
- API Key: `6ffc48b7-a9dc-424c-bd91-cbad3aeefc5b`

```bash
Authorization: Basic $(echo -n "SUBNINE:6ffc48b7-a9dc-424c-bd91-cbad3aeefc5b" | base64)
```

**Communication Plans:**
| Plan | MDN Type |
|------|----------|
| `Wing Tel Inc - NON ABIR SMS MO/MT US` | Dialable (normal phone number) |
| `Wing Tel Inc - ABIR 25Mbps SMS MO/MT US` | Non-dialable (IoT format) |

## Critical Rules

1. **All SIMs MUST be pre-provisioned by Wing Tel before use**
2. Check unknown SIMs with GET first — if `customer` is blank and plan is correct, SIM is ready
3. Always verify activation with GET after PUT

## Request Examples

### 1. Activate Device (Dialable MDN)

```bash
curl -X PUT "https://restapi19.att.com/rws/api/api/v1/devices/{iccid}" \
  -H "Authorization: Basic U1VCTklORTo2ZmZjNDhiNy1hOWRjLTQyNGMtYmQ5MS1jYmFkM2FlZWZjNWI=" \
  -H "Content-Type: application/json" \
  -d '{
    "communicationPlan": "Wing Tel Inc - NON ABIR SMS MO/MT US",
    "status": "Activated"
  }'
```

### 2. Get Device Status

```bash
curl -X GET "https://restapi19.att.com/rws/api/api/v1/devices/{iccid}" \
  -H "Authorization: Basic U1VCTklORTo2ZmZjNDhiNy1hOWRjLTQyNGMtYmQ5MS1jYmFkM2FlZWZjNWI="
```

**Verify:**
- `status` should be `"Activated"`
- `communicationPlan` should match expected plan

### 3. Change MDN to Non-Dialable

```bash
curl -X PUT "https://restapi19.att.com/rws/api/api/v1/devices/{iccid}" \
  -H "Authorization: Basic U1VCTklORTo2ZmZjNDhiNy1hOWRjLTQyNGMtYmQ5MS1jYmFkM2FlZWZjNWI=" \
  -H "Content-Type: application/json" \
  -d '{
    "communicationPlan": "Wing Tel Inc - ABIR 25Mbps SMS MO/MT US"
  }'
```

Then GET to confirm MDN changed to non-dialable format.

### 4. Change MDN Back to Dialable

```bash
curl -X PUT "https://restapi19.att.com/rws/api/api/v1/devices/{iccid}" \
  -H "Authorization: Basic U1VCTklORTo2ZmZjNDhiNy1hOWRjLTQyNGMtYmQ5MS1jYmFkM2FlZWZjNWI=" \
  -H "Content-Type: application/json" \
  -d '{
    "communicationPlan": "Wing Tel Inc - NON ABIR SMS MO/MT US"
  }'
```

Then GET to confirm MDN changed to dialable format.

## MDN Rotation Workflow

To get a new MDN on an IoT SIM:

1. **PUT** with non-dialable plan (`ABIR 25Mbps`)
2. **GET** to confirm non-dialable MDN
3. **PUT** with dialable plan (`NON ABIR`)
4. **GET** to confirm new dialable MDN

## Check If SIM Is Pre-Provisioned

```bash
curl -X GET "https://restapi19.att.com/rws/api/api/v1/devices/{iccid}" \
  -H "Authorization: Basic U1VCTklORTo2ZmZjNDhiNy1hOWRjLTQyNGMtYmQ5MS1jYmFkM2FlZWZjNWI="
```

**Ready to use if:**
- `customer` is `""` (blank)
- `communicationPlan` is `"Wing Tel Inc - NON ABIR SMS MO/MT US"`

## Comparison with ATOMIC API

| Feature | Wing IoT | ATOMIC |
|---------|----------|--------|
| Auth | Basic Auth (header) | Credentials in request body |
| Endpoint style | REST (GET/PUT) | Single POST with requestType |
| Activation | Just ICCID needed | ICCID + IMEI + name + address |
| MDN change | Plan swap | swapMSISDN with ZIP |
| Status change | N/A | Suspend/Restore/Deactivate |
| OTA refresh | N/A | resendOtaProfile |

## How I Can Help

- Write properly formatted IoT API requests
- Debug activation and MDN change issues
- Build MDN rotation scripts
- Check SIM provisioning status
- Integrate IoT API calls into workers
