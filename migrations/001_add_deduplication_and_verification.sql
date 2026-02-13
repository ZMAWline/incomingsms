-- Migration: Add deduplication and SMS verification support
-- Run this in Supabase SQL Editor

-- =====================================================
-- 1. WEBHOOK DELIVERIES TABLE (for deduplication)
-- =====================================================
-- Tracks every webhook sent to prevent duplicates

CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id TEXT NOT NULL UNIQUE,  -- Deterministic ID based on message content
    event_type TEXT NOT NULL,          -- 'sms.received', 'number.online', etc.
    reseller_id BIGINT REFERENCES resellers(id),  -- FIXED: Use BIGINT to match resellers.id
    webhook_url TEXT NOT NULL,
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'delivered', 'failed'
    attempts INTEGER DEFAULT 0,
    last_attempt_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast duplicate lookups
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_message_id ON webhook_deliveries(message_id);

-- Index for cleanup of old records
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_created_at ON webhook_deliveries(created_at);

-- =====================================================
-- 2. ADD message_id TO INBOUND_SMS TABLE
-- =====================================================
-- Unique identifier for each SMS message

ALTER TABLE inbound_sms
ADD COLUMN IF NOT EXISTS message_id TEXT;

-- Index for deduplication checks
CREATE INDEX IF NOT EXISTS idx_inbound_sms_message_id ON inbound_sms(message_id);

-- =====================================================
-- 3. SMS VERIFICATION COLUMNS ON SIM_NUMBERS
-- =====================================================
-- Track verification status for each phone number assignment

ALTER TABLE sim_numbers
ADD COLUMN IF NOT EXISTS verification_code TEXT,
ADD COLUMN IF NOT EXISTS verification_sent_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS verification_status TEXT DEFAULT 'pending';
-- verification_status: 'pending', 'sent', 'verified', 'failed', 'skipped'

-- Index for finding numbers pending verification
CREATE INDEX IF NOT EXISTS idx_sim_numbers_verification_status
ON sim_numbers(verification_status)
WHERE verification_status IN ('pending', 'sent');

-- =====================================================
-- 4. CLEANUP FUNCTION (optional - run periodically)
-- =====================================================
-- Delete webhook delivery records older than 7 days

CREATE OR REPLACE FUNCTION cleanup_old_webhook_deliveries()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM webhook_deliveries
    WHERE created_at < NOW() - INTERVAL '7 days';
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- 5. VERIFICATION TIMEOUT FUNCTION (optional)
-- =====================================================
-- Mark numbers as failed if verification times out (run via cron)

CREATE OR REPLACE FUNCTION mark_verification_timeouts(timeout_minutes INTEGER DEFAULT 2)
RETURNS INTEGER AS $$
DECLARE
    updated_count INTEGER;
BEGIN
    UPDATE sim_numbers
    SET verification_status = 'failed'
    WHERE verification_status = 'sent'
      AND verification_sent_at < NOW() - (timeout_minutes || ' minutes')::INTERVAL
      AND verified_at IS NULL;
    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RETURN updated_count;
END;
$$ LANGUAGE plpgsql;
