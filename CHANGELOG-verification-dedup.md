# Incoming SMS System - Current Status

**Last Updated:** 2026-02-04

---

## System Overview

A Cloudflare Workers-based system for managing SMS gateways and T-Mobile SIM card provisioning via the Helix API. Handles SMS ingestion, SIM activation, phone number rotation, and reseller webhook delivery.

---

## Workers (8 Total)

| Worker | Purpose | Status |
|--------|---------|--------|
| **sms-ingest** | Receives SMS from Skyline gateways | Production |
| **bulk-activator** | Activates SIMs from CSV/JSON | Production |
| **details-finalizer** | Finalizes provisioning, sends verification SMS | Production |
| **mdn-rotator** | Daily phone number rotation | Production |
| **phone-number-sync** | Syncs numbers from Helix to DB | Production |
| **reseller-sync** | Sends verified numbers to reseller webhooks | Production |
| **sim-canceller** | Cancels SIMs via Helix | Production |
| **dashboard** | Web UI for monitoring/control | Production |

---

## Recent Changes (Latest First)

### 2026-02-04 - Test Environment Setup
- Created `.dev.vars.test` with separate secrets for test environment
- All workers have `[env.test]` configuration in wrangler.toml
- Test workers use `-test` suffix (e.g., `sms-ingest-test`)

### 2026-02-03 - Dashboard Enhancements
- Added **Sub ID column** showing `mobility_subscription_id` in SIM table
- Added **Helix Query** feature (`/api/helix-query`) for direct API queries
- Fixed sim-canceller service binding issues

### 2026-02-02 - MDN Rotator Fixes
- Fixed `helix_api_logs` schema (correct column names)
- Added rotation tracking columns to sims table
- Improved error handling and logging

### 2026-02-01 - Skyline Integration for Verification
- **Replaced Helix SMS with Skyline API** for sending verification SMS
- Uses SK_HOST, SK_USERNAME, SK_PASSWORD environment variables
- Falls back to 'skipped' status if no sender SIM available

### 2026-01-31 - Helix API Logging
- Added `helix_api_logs` table for debugging API calls
- Logs full request/response for: activation, MDN change, subscriber details
- Added KV token caching to prevent Auth0 rate limiting (30-min TTL)

### 2026-01-30 - Webhook Deduplication & Verification
- Added `webhook_deliveries` table for tracking sent webhooks
- Implemented exponential backoff retry: 1s → 2s → 4s → 8s (max 4 attempts)
- Added SMS verification flow with 6-character codes
- Added `message_id` column to `inbound_sms` for deduplication

---

## Key Features

### Webhook System
- **Deduplication** via deterministic SHA-256 message IDs
- **Retry logic** with exponential backoff (4 attempts max)
- **Delivery tracking** in `webhook_deliveries` table
- **Event types**: `sms.received`, `number.online`, `number.verification_failed`

### SMS Verification Flow
1. Number assigned (via activation or rotation)
2. Generate 6-char verification code (e.g., `ABC123`)
3. Send SMS via Skyline gateway: `VERIFY ABC123`
4. sms-ingest detects verification code in reply
5. Mark as `verified` and send `number.online` webhook
6. If no reply within 2 minutes: mark as `failed`

**Note:** First SIM in system marked as `skipped` (no sender available)

### Helix API Integration
- Token-based OAuth2 authentication with auto-refresh
- Operations: Activation, MDN change, subscriber details query
- Full request/response logging to database
- Token caching in KV (30-minute TTL)

### Dashboard Features
- Real-time stats (total, active, provisioning SIMs, 24h messages)
- SIM status table with phone numbers, reseller, Sub ID, SMS count
- Recent SMS message log
- Worker control buttons (Activate, Finalize, Rotate, Sync, Cancel)
- Direct Helix API query interface
- Basic Auth protection

---

## Database Schema

### Core Tables
- **sims** - SIM cards with status, subscription ID, rotation tracking
- **sim_numbers** - Phone number history with verification status
- **inbound_sms** - Received SMS messages with deduplication
- **resellers** - Reseller companies
- **reseller_sims** - SIM-to-reseller assignments
- **reseller_webhooks** - Webhook endpoints per reseller
- **webhook_deliveries** - Webhook send tracking (deduplication)
- **helix_api_logs** - Helix API request/response logging

### Key Indexes
- `sims.iccid` (unique)
- `sim_numbers.verification_status`
- `inbound_sms.message_id` (unique)
- `webhook_deliveries.message_id` (unique)

---

## Environment Configuration

### Required Secrets
```
# Supabase
SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

# Worker Auth
GATEWAY_SECRET, FINALIZER_RUN_SECRET, ADMIN_RUN_SECRET
BULK_RUN_SECRET, SYNC_SECRET, CANCEL_SECRET, DASHBOARD_AUTH

# Helix API
HX_TOKEN_URL, HX_API_BASE, HX_CLIENT_ID, HX_AUDIENCE
HX_GRANT_USERNAME, HX_GRANT_PASSWORD

# Helix Activation
HX_ACTIVATION_CLIENT_ID, HX_PLAN_ID, HX_BAN, HX_FAN
HX_ADDRESS1, HX_CITY, HX_STATE, HX_ZIP

# Skyline Gateway (for verification SMS)
SK_HOST, SK_USERNAME, SK_PASSWORD, SK_PORT

# CSV Source
SHEET_CSV_URL
```

### Files
- `.dev.vars` - Production secrets
- `.dev.vars.test` - Test environment secrets
- `.dev.vars.example` - Template

---

## Known Limitations

1. **First SIM Bootstrap** - Cannot verify first SIM (no sender), marked as `skipped`
2. **Verification Timeout** - `/check-timeouts` endpoint not yet implemented
3. **One-way Sync** - phone-number-sync only pulls from Helix, no push
4. **No Automated Cleanup** - `webhook_deliveries` grows indefinitely (cleanup function exists but not scheduled)
5. **No Automated Tests** - Manual testing only via dashboard and limit parameters

---

## Deployment

```bash
# Deploy single worker
cd src/<worker-name> && wrangler deploy

# Deploy to test environment
cd src/<worker-name> && wrangler deploy --env test

# Deploy all workers (production)
for dir in src/*/; do (cd "$dir" && wrangler deploy); done
```

---

## Webhook Payload Examples

### number.online
```json
{
  "event_type": "number.online",
  "message_id": "number.online_<hash>",
  "data": {
    "sim_id": 123,
    "iccid": "8901...",
    "number": "+1234567890",
    "verified": true,
    "online": true
  }
}
```

### sms.received
```json
{
  "event_type": "sms.received",
  "message_id": "sms.received_<hash>",
  "data": {
    "to": "+1234567890",
    "from": "+0987654321",
    "body": "Your code is 123456",
    "received_at": "2026-02-04T12:00:00Z"
  }
}
```

---

## TODO / Incomplete

- [ ] Implement `/check-timeouts` endpoint in mdn-rotator for verification timeout handling
- [ ] Add cron trigger for timeout checks (every 2 minutes)
- [ ] Schedule automated cleanup of old `webhook_deliveries` records
- [ ] Add automated test suite (Jest/Vitest)
- [ ] CI/CD pipeline for deployments
