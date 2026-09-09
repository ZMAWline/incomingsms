import { NAME_POOL } from './name-pool.mjs';
import { ADDRESS_POOL } from './address-pool.mjs';

export const ACTIVATION_CSV_HEADERS = ['iccid', 'imei', 'reseller_id', 'vendor', 'port_in', 'port_mdn', 'port_account_number', 'port_pin', 'port_first_name', 'port_last_name', 'port_street_number', 'port_street_name', 'port_zip', 'port_old_first_name', 'port_old_last_name'];

// Required subscriber (new account holder) + old_service_provider (losing-carrier
// account holder) fields per the Atomic Wholesale API portinRequest reference.
// old_service_provider has no address block — only billing account + name — so we
// don't collect an "old" street/zip; collecting fields the carrier never receives
// would be misleading to operators.
const REQUIRED_PORT_FIELDS = [
  'port_first_name',
  'port_last_name',
  'port_street_number',
  'port_street_name',
  'port_zip',
  'port_old_first_name',
  'port_old_last_name',
];

const TRUTHY = new Set(['1', 'true', 'yes', 'y', 'port', 'port_in', 'on']);
const FALSY = new Set(['', '0', 'false', 'no', 'n', 'new', 'new_number', 'off']);

// Default port-in behavior: an operator should never have to hand-type a
// subscriber name/address just to submit a port-in. When a row's port
// subscriber/old-carrier fields are left entirely blank, validateActivationSim
// fills them from these fake-identity/address pools automatically (called once
// PER ROW so a bulk port-in batch gets a distinct random identity per line —
// never the same name repeated across a batch). Only name/address fields are
// touched; port_mdn/port_account_number/port_pin/iccid/imei/reseller_id are
// never generated here.
// `excludeAddressIds` is the set of addresses ATOMIC has already rejected,
// read from address_pool_usage.verify_failed_at by the caller (which has the
// Supabase credentials; this module stays pure).
//
// Why it matters: on 2026-09-08, eight port-ins failed with "streetName Is
// Invalid" / "streetNumber Is Invalid" / "Invalid Zipcode" — and every one of
// those addresses was ALREADY quarantined in the DB, flagged earlier by the
// Apex PPU path. Port-ins kept drawing them because this function only ever
// read the in-code array. Passing the set closes that gap.
//
// The returned port_address_id lets the caller quarantine the address if the
// carrier rejects it, so port-in failures feed the same table.
export function pickRandomPortIdentity(excludeAddressIds) {
  const subIdx = Math.floor(Math.random() * NAME_POOL.length);
  let oldIdx = Math.floor(Math.random() * NAME_POOL.length);
  if (NAME_POOL.length > 1 && oldIdx === subIdx) {
    oldIdx = (oldIdx + 1) % NAME_POOL.length;
  }
  const name = NAME_POOL[subIdx];
  const oldName = NAME_POOL[oldIdx];

  const excluded = excludeAddressIds instanceof Set ? excludeAddressIds : new Set(excludeAddressIds || []);
  // Fall back to the full pool rather than throwing if exclusions would empty
  // it — a port submitted with a questionable address beats no port at all,
  // and the carrier is the final arbiter either way.
  const usable = excluded.size ? ADDRESS_POOL.filter(a => !excluded.has(a.id)) : ADDRESS_POOL;
  const pool = usable.length > 0 ? usable : ADDRESS_POOL;
  const address = pool[Math.floor(Math.random() * pool.length)];

  return {
    port_first_name: name.firstName,
    port_last_name: name.lastName,
    port_street_number: address.streetNumber,
    port_street_name: address.streetName,
    port_zip: address.zipCode,
    port_old_first_name: oldName.firstName,
    port_old_last_name: oldName.lastName,
    port_address_id: address.id,
  };
}

// Carrier rejections that mean "this address is bad", as opposed to a transient
// fault or a problem with the losing-carrier account details. Matched against
// the portinRequest description so the caller can quarantine the address and
// redraw instead of failing the port.
//
// Observed verbatim in PROD carrier_api_logs 2026-09-08:
//   Error!!streetName Is Invalid / Error!!streetNumber Is Invalid /
//   Invalid Zipcode. / ...UpdateSubscriberInfo failed: City is blank.
const ADDRESS_REJECTION_RX = /street\s*Name\s*Is\s*Invalid|street\s*Number\s*Is\s*Invalid|Invalid\s*Zipcode|City is blank/i;

export function isAddressRejection(description) {
  return ADDRESS_REJECTION_RX.test(String(description || ''));
}

export function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', inQuotes = false;
  for (let i = 0; i < String(text || '').length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else {
        cur += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (c !== '\r') cur += c;
    }
  }
  row.push(cur);
  rows.push(row);
  return rows.filter(r => r.some(v => String(v).trim() !== ''));
}

export function normalizePhone10(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

export function parseBooleanFlag(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (TRUTHY.has(v)) return true;
  if (FALSY.has(v)) return false;
  return false;
}

function normalizeHeader(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function requireHeader(header, name, errors) {
  const idx = header.indexOf(name);
  if (idx < 0) errors.push(`CSV missing required header: ${name}`);
  return idx;
}

function valueAt(row, header, name) {
  const idx = header.indexOf(name);
  return idx >= 0 ? String(row[idx] || '').trim() : '';
}

export function validateActivationSim(input, options = {}) {
  const rowNumber = options.rowNumber || null;
  const prefix = rowNumber ? `Row ${rowNumber}: ` : '';
  const defaultVendor = options.defaultVendor || 'atomic';
  // A batch-wide reseller_id (from the dashboard's "activate to reseller"
  // dropdown) always wins over any per-row value — the dropdown applies to
  // every row in the submitted batch. When absent, fall back to the row's
  // own reseller_id for backward compatibility with older CSV/paste formats
  // and direct API callers that still send it per row.
  const resellerIdSource = (options.resellerId !== undefined && options.resellerId !== null && String(options.resellerId).trim() !== '')
    ? options.resellerId
    : (input?.reseller_id ?? input?.resellerId ?? '');
  const sim = {
    iccid: String(input?.iccid || '').trim(),
    imei: String(input?.imei || '').trim(),
    reseller_id: Number.parseInt(String(resellerIdSource).trim(), 10),
    vendor: String(input?.vendor || defaultVendor || 'atomic').trim() || 'atomic',
    port_in: parseBooleanFlag(input?.port_in ?? input?.portIn),
    port_mdn: '',
    port_account_number: '',
    port_pin: '',
    port_first_name: '',
    port_last_name: '',
    port_street_number: '',
    port_street_name: '',
    port_zip: '',
    port_old_first_name: '',
    port_old_last_name: '',
  };
  const errors = [];

  if (!/^\d{19,20}$/.test(sim.iccid)) errors.push(prefix + 'Invalid ICCID (expected 19-20 digits)');
  if (sim.vendor !== 'wing_iot' && !/^\d{15}$/.test(sim.imei)) errors.push(prefix + 'Invalid IMEI (expected 15 digits)');
  if (!Number.isFinite(sim.reseller_id)) errors.push(prefix + 'Invalid reseller_id (must be a number)');

  if (sim.port_in) {
    if (sim.vendor !== 'atomic') errors.push(prefix + 'Port-in is currently supported only for ATOMIC activations');
    const normalized = normalizePhone10(input?.port_mdn ?? input?.portMdn);
    if (!/^\d{10}$/.test(normalized)) {
      errors.push(prefix + 'port_mdn is required for port-in and must normalize to 10 digits');
    } else {
      sim.port_mdn = normalized;
    }
    const portAccountNumber = String(input?.port_account_number ?? input?.portAccountNumber ?? '').trim();
    if (!portAccountNumber) {
      errors.push(prefix + 'port_account_number is required for port-in');
    } else {
      sim.port_account_number = portAccountNumber;
    }
    const portPin = String(input?.port_pin ?? input?.portPin ?? input?.port_passcode ?? input?.portPasscode ?? '').trim();
    if (!portPin) {
      errors.push(prefix + 'port_pin is required for port-in');
    } else {
      sim.port_pin = portPin;
    }
    // subscriber.* (new account holder) + old_service_provider.* (losing-carrier
    // account holder) — required by the carrier's portinRequest. Default
    // behavior: when the caller supplies none of these fields (the dashboard's
    // "use custom subscriber info" toggle is off, or a bulk paste/CSV row simply
    // has no name/address columns), auto-fill a random identity per row instead
    // of erroring — see pickRandomPortIdentity. If ANY field is supplied, treat
    // it as an explicit custom-info submission and require every field, with a
    // specific per-field error rather than silently falling back to a new-number
    // Activate submission.
    const anyPortFieldProvided = REQUIRED_PORT_FIELDS.some(key => {
      const camel = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      return String(input?.[key] ?? input?.[camel] ?? '').trim() !== '';
    });
    if (!anyPortFieldProvided) {
      Object.assign(sim, pickRandomPortIdentity(options?.excludeAddressIds));
    } else {
      for (const key of REQUIRED_PORT_FIELDS) {
        const camel = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
        const val = String(input?.[key] ?? input?.[camel] ?? '').trim();
        if (!val) {
          errors.push(prefix + key + ' is required for port-in');
        } else {
          sim[key] = val;
        }
      }
    }
  }

  return { ok: errors.length === 0, sim, errors };
}

export function parseActivationCsv(text, options = {}) {
  const rows = parseCsv(text);
  if (rows.length === 0) return { rows: [], valid: [], invalid: [{ row: 1, errors: ['CSV is empty'] }], errors: ['CSV is empty'] };
  const header = rows[0].map(normalizeHeader);
  const headerErrors = [];
  // reseller_id is no longer a required CSV column — a batch-wide reseller can
  // be supplied via options.resellerId (the dashboard's reseller dropdown) and
  // applied to every row. The column is still read/parsed when present, for
  // backward compatibility with older sheets/API callers.
  for (const name of ['iccid', 'imei']) requireHeader(header, name, headerErrors);
  if (headerErrors.length) return { rows: [], valid: [], invalid: [{ row: 1, errors: headerErrors }], errors: headerErrors };

  const valid = [];
  const invalid = [];
  const defaultVendor = options.defaultVendor || 'atomic';
  rows.slice(1).forEach((raw, idx) => {
    const rowNumber = idx + 2;
    const row = raw.slice(0, header.length);
    while (row.length < header.length) row.push('');
    const candidate = {
      iccid: valueAt(row, header, 'iccid'),
      imei: valueAt(row, header, 'imei'),
      reseller_id: valueAt(row, header, 'reseller_id'),
      vendor: valueAt(row, header, 'vendor') || defaultVendor,
      port_in: valueAt(row, header, 'port_in'),
      port_mdn: valueAt(row, header, 'port_mdn'),
      port_account_number: valueAt(row, header, 'port_account_number'),
      port_pin: valueAt(row, header, 'port_pin'),
      port_first_name: valueAt(row, header, 'port_first_name'),
      port_last_name: valueAt(row, header, 'port_last_name'),
      port_street_number: valueAt(row, header, 'port_street_number'),
      port_street_name: valueAt(row, header, 'port_street_name'),
      port_zip: valueAt(row, header, 'port_zip'),
      port_old_first_name: valueAt(row, header, 'port_old_first_name'),
      port_old_last_name: valueAt(row, header, 'port_old_last_name'),
    };
    const result = validateActivationSim(candidate, { rowNumber, defaultVendor, resellerId: options.resellerId });
    if (result.ok) valid.push({ row: rowNumber, sim: result.sim });
    else invalid.push({ row: rowNumber, errors: result.errors, raw: candidate });
  });
  return { rows: rows.slice(1), valid, invalid, errors: invalid.flatMap(r => r.errors) };
}

export function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function buildActivationCsvTemplate() {
  const rows = [
    ACTIVATION_CSV_HEADERS,
    ['89014103271467425631', '123456789012345', '1', 'atomic', 'false', '', '', '', '', '', '', '', '', '', ''],
    ['89014103271467425632', '123456789012346', '1', 'atomic', 'true', '2125550199', 'ACCT12345', '1234', 'John', 'Doe', '123', 'Main St', '75001', 'Jane', 'Smith'],
  ];
  return rows.map(row => row.map(csvEscape).join(',')).join('\n') + '\n';
}

export function buildAtomicActivateRequest({ session, iccid, imei, address, portMdn = '', partnerTransactionId }) {
  return {
    wholeSaleApi: {
      session,
      wholeSaleRequest: {
        requestType: 'Activate',
        partnerTransactionId: partnerTransactionId || `act_${Date.now()}`,
        imei,
        sim: iccid,
        eSim: 'N',
        EID: '',
        BAN: '',
        firstName: 'SUB',
        lastName: 'NINE',
        streetNumber: address.streetNumber,
        streetDirection: address.streetDirection || '',
        streetName: address.streetName,
        zip: address.zipCode,
        plan: 'EBNOVOICE',
        portMdn: portMdn || '',
      },
    },
  };
}

// Atomic Wholesale API `portinRequest` — a SEPARATE operation from `Activate`.
// Field names/shape per the atomic-wholesale-api skill (subscriber = new account
// holder taking the line; old_service_provider = losing-carrier account holder —
// they are independent blocks and are not required to match). `planCode` (not
// `plan`, which is only the Activate field name) and top-level `BAN` are the
// carrier's documented required keys; BAN is sent blank on the same precedent as
// Activate's BAN (assigned by the carrier, not supplied by us) — unconfirmed by
// the carrier for this specific operation, flagged for live-test review.
export function buildAtomicPortInRequest({
  session,
  iccid,
  imei,
  portMdn,
  portAccountNumber,
  portPin,
  firstName,
  lastName,
  streetNumber,
  streetName,
  zip,
  oldFirstName,
  oldLastName,
  partnerTransactionId,
}) {
  return {
    wholeSaleApi: {
      session,
      wholeSaleRequest: {
        requestType: 'portinRequest',
        partnerTransactionId: partnerTransactionId || `port_${Date.now()}`,
        MSISDN: portMdn,
        sim: iccid,
        eSim: 'N',
        BAN: '',
        imei,
        planCode: 'EBNOVOICE',
        subscriber: {
          firstName,
          lastName,
          streetNumber,
          streetType: '',
          streetDirection: '',
          streetName,
          zipCode: zip,
        },
        old_service_provider: {
          billingAccountNumber: portAccountNumber,
          billingAccountPassword: portPin,
          firstName: oldFirstName,
          lastName: oldLastName,
        },
      },
    },
  };
}

// Inverse of buildAtomicPortInRequest: recovers the original inputs from a
// logged portinRequest body. Used by bulk-activator's /retry-portin to replay
// a failed port-in, because the losing-carrier account number and PIN are
// never stored on `sims` — the request body in carrier_api_logs is the only
// record of them.
//
// Keep this next to the builder. If the builder's payload shape changes, this
// must change with it, and the round-trip test in
// tests/activation-bulk.test.mjs is what catches the drift.
//
// partnerTransactionId is intentionally not returned: it identifies a single
// attempt, and the builder mints a fresh one per call.
export function parseAtomicPortInRequest(requestBody) {
  const wsr = requestBody?.wholeSaleApi?.wholeSaleRequest;
  if (!wsr || wsr.requestType !== 'portinRequest') return null;
  const subscriber = wsr.subscriber || {};
  const oldProvider = wsr.old_service_provider || {};
  return {
    iccid: wsr.sim || '',
    imei: wsr.imei || '',
    portMdn: wsr.MSISDN || '',
    portAccountNumber: oldProvider.billingAccountNumber || '',
    portPin: oldProvider.billingAccountPassword || '',
    firstName: subscriber.firstName || '',
    lastName: subscriber.lastName || '',
    streetNumber: subscriber.streetNumber || '',
    streetName: subscriber.streetName || '',
    zip: subscriber.zipCode || '',
    oldFirstName: oldProvider.firstName || '',
    oldLastName: oldProvider.lastName || '',
  };
}

// Atomic Wholesale API `portinStatus` — read-only status lookup for a port-in
// already submitted via portinRequest. Per the atomic-wholesale-api skill,
// MSISDN is the ONLY required (and only supported) field for this
// requestType; it must never carry port account number/PIN or subscriber
// fields, which belong only to portinRequest/portinUpdate.
export function buildAtomicPortInStatusRequest({ session, msisdn }) {
  return {
    wholeSaleApi: {
      session,
      wholeSaleRequest: {
        requestType: 'portinStatus',
        MSISDN: msisdn,
      },
    },
  };
}
