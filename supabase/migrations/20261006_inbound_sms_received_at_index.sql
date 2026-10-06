-- Index for time-range reads of inbound_sms.
--
-- inbound_sms had no index on received_at, so every "SMS since <time>" read
-- scanned the whole table. The dashboard's /api/stats asks for the 24-hour
-- count on every load (PostgREST count=exact on received_at=gte.), and on
-- PROD 2026-10-06 that was a sequential scan of ~100k rows taking 7.1 s,
-- mostly disk reads; pg_stat_statements shows it at 2.7 s mean over 13.4k
-- calls. The same shape is used by the bad-rental remediator, otp-portal,
-- storefront, reseller-portal and shared/rentals.js.
--
-- Additive only. Plain CREATE INDEX on ~100k rows blocks inbound_sms inserts
-- for about a second; the SMS ingest path waits rather than fails.

create index if not exists idx_inbound_sms_received_at
  on public.inbound_sms (received_at desc);
