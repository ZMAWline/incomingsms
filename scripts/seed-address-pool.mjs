import { seedAddressPoolUsage } from '../src/shared/address-picker.mjs';

const env = {
  SUPABASE_URL:         process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
};
if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars before running.');
  process.exit(1);
}

const n = await seedAddressPoolUsage(env);
console.log(`Seeded/upserted ${n} address_pool_usage rows.`);
