-- INC-22 / INC-16f: operator escalation batches + vendor batch tickets.
--
-- One row per (tick_id, vendor, failure_type) batch. Dedup the worker
-- against re-emitting the same batch in the same 2h tick.
--
-- failure_type values per Plan v4 §H.3 (14 enumerated) plus 'vendor_batch'
-- for §H.4 toggle-gated vendor tickets.
--
-- paperclip_issue_id is text (Paperclip's INC-XX shape) — nullable so we can
-- queue a row even if the POST fails and retry on the next tick. status
-- tracks the post-side state separately from the DB queue side.

create table if not exists operator_escalations (
  id                  bigserial primary key,
  tick_id             text   not null,                 -- ISO timestamp of 2h tick boundary
  vendor              text   not null,                 -- 'atomic'|'wing_iot'|'helix'|'teltik' or 'unknown'
  failure_type        text   not null,                 -- §H.3 failure_type or 'vendor_batch'
  report_ids          bigint[] not null default '{}',  -- rental_reports.id list
  line_items          jsonb  not null default '[]',    -- per-line payload (operator-visible only)
  paperclip_issue_id  text,                            -- nullable — set after successful POST
  paperclip_parent_id text,
  status              text   not null default 'queued',-- 'queued'|'posted'|'post_failed'
  last_error          text,
  posted_at           timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists oe_dedup_key
  on operator_escalations (tick_id, vendor, failure_type);

create index if not exists oe_status_idx
  on operator_escalations (status, created_at desc)
  where status <> 'posted';
