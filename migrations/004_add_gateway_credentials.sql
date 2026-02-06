-- ============================================
-- MIGRATION 004: Add Gateway Credentials
-- Store Skyline API credentials per gateway
-- ============================================

-- Add credential columns to gateways table
ALTER TABLE public.gateways
ADD COLUMN IF NOT EXISTS host text,
ADD COLUMN IF NOT EXISTS api_port integer DEFAULT 80,
ADD COLUMN IF NOT EXISTS username text,
ADD COLUMN IF NOT EXISTS password text;

-- ============================================
-- USAGE NOTES:
--
-- Update a gateway with credentials:
--   UPDATE gateways
--   SET host = '192.168.1.67',
--       api_port = 80,
--       username = 'root',
--       password = 'your_password'
--   WHERE code = '64-1';
--
-- The dashboard will use these credentials when
-- sending test SMS through a specific gateway.
-- ============================================
