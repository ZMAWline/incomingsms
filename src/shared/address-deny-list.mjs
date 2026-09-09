// Addresses the carrier has rejected. Never put these back in the pool.
//
// This exists because the pool is regenerated from OpenStreetMap, and OSM has
// no idea which of its addresses ATOMIC's validator dislikes. Without a deny
// list, `node scripts/build-address-pool.mjs` silently reintroduces every
// address we have ever deleted, and the same ports fail again.
//
// The runtime source of truth is the `address_pool` table — a deleted row is
// gone. This file is the build-time equivalent, so a regeneration cannot undo
// those deletions. `address_pool_deletions` is the audit trail both come from.
//
// To add one: take the address_id from address_pool_deletions and paste it in
// with the carrier's own words. Keep it sorted.

export const ADDRESS_DENY_LIST = [
  // Rejected on portinRequest, 2026-09-04. Each of these failed a real
  // customer port with an explicit address error.
  { id: 'al-36350-110-hinton-waters-avenue', reason: 'streetNumber Is Invalid' },
  { id: 'la-70344-5106-little-caillou-road', reason: 'streetName Is Invalid' },
  { id: 'nv-89081-3120-east-azure-avenue', reason: 'streetNumber Is Invalid' },
  { id: 'or-97550-212-west-main-street', reason: 'Invalid Zipcode' },
  { id: 'sc-29544-6700-juniper-bay-road', reason: 'streetName Is Invalid' },
  { id: 'sd-57226-125-3rd-avenue-south', reason: 'streetNumber Is Invalid' },
  { id: 'va-22039-5616-ox-road', reason: 'streetNumber Is Invalid' },
  { id: 'vt-05342-2939-route-100', reason: 'streetName Is Invalid' },

  // Rejected on UpdateSubscriberInfo (Apex PPU path). "City is blank" means
  // ATOMIC could not resolve the city for that street/ZIP pair.
  { id: 'az-85265-10005-east-osborn-road', reason: 'City is blank' },
  { id: 'ma-01286-815-blue-hill-avenue', reason: 'City is blank' },
  { id: 'or-97649-330-main-street', reason: 'City is blank' },
  { id: 'ri-02866-580-broad-street', reason: 'City is blank' },

  // ZIP not supported for a subscriber-number change.
  { id: 'ca-95486-21893-west-street', reason: 'swap zipCode not supported' },
  { id: 'id-83677-390-stibnite-rd', reason: 'swap zipCode not supported' },
  { id: 'id-83866-68244-highway-3-south', reason: 'swap zipCode not supported' },
  { id: 'nm-87943-451-grafton-road', reason: 'swap zipCode not supported' },
  { id: 'nv-89826-533-main-street', reason: 'swap zipCode not supported' },
  { id: 'ok-74728-9983-n-us-hwy-259', reason: 'swap zipCode not supported' },
  { id: 'wv-26291-72-snowshoe-drive', reason: 'swap zipCode not supported' },
  { id: 'wv-26376-234-wildcat-road', reason: 'swap zipCode not supported' },
];

export const DENIED_ADDRESS_IDS = new Set(ADDRESS_DENY_LIST.map(a => a.id));
