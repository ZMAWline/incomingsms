---
name: sim-triage
description: Diagnose a broken, suspended, or misbehaving SIM. Queries all relevant tables in one pass and returns a structured report. Use when: a SIM is suspended, not receiving notifications, not rotating, stuck in provisioning, has activation errors, or a reseller reports a line is down. Triggers on: "SIM X is broken", "why is SIM X suspended", "diagnose SIM", "SIM not working", "line down", "reseller says SIM X isn't getting notifications".
---

# SIM Triage Skill

When this skill is invoked, identify the SIM from the user's message (by ID, ICCID, phone number, or description), then run the full diagnostic below.

## Step 1 — Resolve the SIM

If the user gave a SIM ID, use it directly. If they gave an ICCID, number, or description, run:

```sql
SELECT id, iccid, imei, status, gateway_id, port, mobility_subscription_id,
       att_ban, activated_at, last_mdn_rotated_at, last_notified_at,
       last_activation_error, last_rotation_error, reseller_id
FROM sims
WHERE iccid = '<iccid>'
   OR id = <id>
LIMIT 1;
```

Use `mcp__supabase__execute_sql` for all queries.

## Step 2 — Get Current Phone Number

```sql
SELECT number, verification_status, created_at
FROM sim_numbers
WHERE sim_id = <sim_id>
ORDER BY created_at DESC
LIMIT 3;
```

## Step 3 — Recent Helix API Activity

```sql
SELECT action, created_at,
       response_body->>'errorMessage' as error_msg,
       response_status,
       response_ok
FROM helix_api_logs
WHERE sim_id = <sim_id>
ORDER BY created_at DESC
LIMIT 10;
```

## Step 4 — Webhook Delivery Status

```sql
SELECT number, event_date, status, attempts, last_attempted_at, error_message
FROM webhook_deliveries
WHERE sim_id = <sim_id>
ORDER BY last_attempted_at DESC
LIMIT 5;
```

## Step 5 — Reseller Webhook Config

```sql
SELECT r.id, r.name, r.webhook_url
FROM resellers r
JOIN sims s ON s.reseller_id = r.id
WHERE s.id = <sim_id>;
```

## Step 6 — IMEI Pool Status

```sql
SELECT imei, status, gateway_id, port, slot
FROM imei_pool
WHERE sim_id = <sim_id>;
```

## Step 7 — Compile Diagnosis

Output a structured report with these sections:

```
## SIM Triage Report — SIM <id>

### Identity
- Status: <status>
- ICCID: <iccid>
- IMEI: <imei>
- Current number: <number> (as of <date>)
- Gateway: <gateway_id> Port: <port>
- Reseller: <name> | Webhook: <url or NONE>
- ATT BAN: <att_ban>
- Mobility Sub ID: <id or NONE>

### Timeline
- Activated: <activated_at or never>
- Last rotated: <last_mdn_rotated_at or never>
- Last notified: <last_notified_at or never>

### Errors
- Last activation error: <error or none>
- Last rotation error: <error or none>

### Recent Helix Activity
<list last 5 actions with timestamps and any error messages>

### Webhook Deliveries (last 5)
<list with status, date, error if any>

### IMEI Pool
<pool entry status or "no pool entry">

### Diagnosis
<1-3 sentences: what is wrong and why>

### Recommended Actions
<bullet list of specific next steps>
```

## Common Diagnosis Patterns

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `status=suspended`, recent `suspend` in Helix logs | AT&T suspended due to stale IMEI | Fix SIM (change_imei action) |
| `status=helix_timeout`, OTA log shows "does not belong to user" | IMEI not on AT&T network | Use Fix SIM to get new IMEI + re-provision |
| `status=data_mismatch`, OTA log shows "sim number does not match" | Number mismatch in AT&T records | OTA refresh, then retry |
| `status=provisioning` for >30 min | details-finalizer hasn't run yet, or sub_id missing | Check `mobility_subscription_id`; if null, activation may have failed |
| `last_notified_at` is old, reseller not receiving | Webhook delivery failed; dedup blocking re-send | Check webhook_deliveries; use force=true reseller sync |
| No webhook_deliveries rows | No reseller assigned or no webhook_url | Assign reseller + set webhook URL |
| `last_rotation_error` set | MDN rotation failed | Check Helix logs for error; manual rotate may be needed |
| IMEI pool entry is `retired` | IMEI was retired; no replacement allocated | Allocate new IMEI from pool via Fix SIM |
