# Incoming SMS - Cloudflare Workers

A collection of Cloudflare Workers for handling incoming SMS messages with SIM card management and routing capabilities.

## Workers

This project contains multiple Cloudflare Workers:

- **sms-ingest** - Main worker for receiving and processing incoming SMS messages
- **bulk-activator** - Handles bulk SIM activation operations
- **details-finalizer** - Finalizes SIM card details
- **mdn-rotator** - Manages phone number rotation for SIM cards
- **reseller-sync** - Synchronizes data with reseller systems

## Prerequisites

- Node.js (v18 or later)
- npm or yarn
- Cloudflare account with Workers enabled
- Wrangler CLI (Cloudflare Workers CLI tool)

## Setup for Development

1. **Install dependencies**
   ```bash
   npm install -g wrangler
   ```

2. **Configure environment variables**

   Copy the example environment file:
   ```bash
   cp .dev.vars.example .dev.vars
   ```

   Edit `.dev.vars` and add your configuration:
   - `SUPABASE_URL` - Your Supabase project URL
   - `SUPABASE_SERVICE_ROLE_KEY` - Your Supabase service role key
   - `GATEWAY_SECRET` - Secret key for SMS gateway authentication
   - `RESELLER_WEBHOOK_URL` - (Optional) Webhook URL for reseller notifications

3. **Authenticate with Cloudflare**
   ```bash
   wrangler login
   ```

## Development

To develop a specific worker locally:

```bash
# SMS Ingest Worker
cd src/sms-ingest
wrangler dev

# Or for other workers
cd src/bulk-activator
wrangler dev
```

The worker will be available at `http://localhost:8787`

## Deployment

To deploy a worker to Cloudflare:

```bash
cd src/[worker-name]
wrangler deploy
```

## Project Structure

```
src/
├── sms-ingest/          # Main SMS ingestion worker
│   ├── index.js
│   └── wrangler.toml
├── bulk-activator/      # Bulk SIM activation
│   ├── index.js
│   └── wrangler.toml
├── details-finalizer/   # SIM details finalization
│   ├── index.js
│   └── wrangler.toml
├── mdn-rotator/         # Phone number rotation
│   ├── index.js
│   └── wrangler.toml
└── reseller-sync/       # Reseller synchronization
    ├── index.js
    └── wrangler.toml
```

## SMS Ingest Authentication

The SMS ingest worker supports three authentication methods:

1. **Header**: `x-gateway-secret: <secret>`
2. **Query parameter**: `?secret=<secret>`
3. **Path**: `/s/<secret>` (recommended for gateways that append query params)

## Environment Variables

Each worker requires environment variables to be set either in `.dev.vars` for local development or in the Cloudflare dashboard for production.

Required variables:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `GATEWAY_SECRET`

Optional variables:
- `RESELLER_WEBHOOK_URL`

## License

[Add your license here]
