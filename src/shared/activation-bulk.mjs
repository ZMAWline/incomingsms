export const ACTIVATION_CSV_HEADERS = ['iccid', 'imei', 'reseller_id', 'vendor', 'port_in', 'port_mdn', 'port_account_number', 'port_pin'];

const TRUTHY = new Set(['1', 'true', 'yes', 'y', 'port', 'port_in', 'on']);
const FALSY = new Set(['', '0', 'false', 'no', 'n', 'new', 'new_number', 'off']);

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
  const sim = {
    iccid: String(input?.iccid || '').trim(),
    imei: String(input?.imei || '').trim(),
    reseller_id: Number.parseInt(String(input?.reseller_id ?? input?.resellerId ?? '').trim(), 10),
    vendor: String(input?.vendor || defaultVendor || 'atomic').trim() || 'atomic',
    port_in: parseBooleanFlag(input?.port_in ?? input?.portIn),
    port_mdn: '',
    port_account_number: '',
    port_pin: '',
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
  }

  return { ok: errors.length === 0, sim, errors };
}

export function parseActivationCsv(text, options = {}) {
  const rows = parseCsv(text);
  if (rows.length === 0) return { rows: [], valid: [], invalid: [{ row: 1, errors: ['CSV is empty'] }], errors: ['CSV is empty'] };
  const header = rows[0].map(normalizeHeader);
  const headerErrors = [];
  for (const name of ['iccid', 'imei', 'reseller_id']) requireHeader(header, name, headerErrors);
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
    };
    const result = validateActivationSim(candidate, { rowNumber, defaultVendor });
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
    ['89014103271467425631', '123456789012345', '1', 'atomic', 'false', '', '', ''],
    ['89014103271467425632', '123456789012346', '1', 'atomic', 'true', '2125550199', 'ACCT12345', '1234'],
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
