// Dashboard routes that only reach a legacy vendor (Wing IoT, Helix, SkyLine,
// Kasa). While the vendor is switched off (LEGACY_VENDORS, see
// src/shared/legacy-vendors.mjs) they answer 409 instead of calling out; the
// handlers in index.js stay intact.
import { legacyVendorEnabled, legacyVendorDisabledResponse } from '../shared/legacy-vendors.mjs';

const LEGACY_ROUTES = {
  '/api/wing-check': ['wing'],
  '/api/helix-query': ['helix'],
  '/api/helix-query-bulk': ['helix'],
  '/api/check-imei': ['helix'],
  '/api/check-imeis': ['helix'],
  '/api/imei-pool/fix-incompatible': ['helix', 'skyline'],
  '/api/imei-sweep': ['helix', 'skyline'],
  '/api/trigger-blimei-sweep': ['skyline'],
  '/api/sync-gateway-slots': ['skyline'],
  '/api/imei-gateway-sync': ['skyline'],
};

export function legacyVendorsForRoute(pathname) {
  if (pathname.startsWith('/api/kasa/')) return ['kasa'];
  return LEGACY_ROUTES[pathname] || [];
}

// The 409 Response when the route needs a switched-off legacy vendor, else null.
export function legacyRouteResponse(env, pathname, corsHeaders) {
  for (const vendor of legacyVendorsForRoute(pathname)) {
    if (!legacyVendorEnabled(env, vendor)) return legacyVendorDisabledResponse(vendor, 'dashboard', corsHeaders);
  }
  return null;
}
