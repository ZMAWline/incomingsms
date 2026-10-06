// @ts-check
// Validate operator input before any pricing write reaches the database.
import { LEDGER_VENDORS } from '../request.mjs';

export class BillingInputError extends Error {}

/** @param {unknown} value */
export function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** @param {unknown} start @param {unknown} end */
export function isDateRange(start, end) {
  return typeof start === 'string' && typeof end === 'string'
    && isCalendarDate(start) && isCalendarDate(end) && start <= end;
}

/** @param {unknown} value @param {string} label */
export function nonnegativeNumber(value, label) {
  if ((typeof value !== 'number' && typeof value !== 'string')
      || (typeof value === 'string' && !value.trim())) {
    throw new BillingInputError(label + ' must be a non-negative number');
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new BillingInputError(label + ' must be a non-negative number');
  return number;
}

/** @typedef {{min_count: number, max_count: number | null, rate: number}} Tier */

/** @param {unknown} input @returns {Tier[]} */
export function sanitizeTiers(input) {
  if (!Array.isArray(input) || !input.length) throw new BillingInputError('tiers must be a non-empty array');
  const tiers = input.map((item, index) => {
    if (!item || typeof item !== 'object') throw new BillingInputError('tier ' + index + ' must be an object');
    const min = nonnegativeNumber(item.min_count, 'min_count');
    const max = item.max_count == null || item.max_count === '' ? null : nonnegativeNumber(item.max_count, 'max_count');
    if (!Number.isSafeInteger(min)) throw new BillingInputError('min_count must be a whole number');
    if (max !== null && (!Number.isSafeInteger(max) || max < min)) throw new BillingInputError('max_count must be a whole number >= min_count or null');
    return { min_count: min, max_count: max, rate: nonnegativeNumber(item.rate, 'rate') };
  }).sort((a, b) => a.min_count - b.min_count);
  for (let i = 1; i < tiers.length; i++) {
    const previous = tiers[i - 1];
    if (previous.max_count === null || tiers[i].min_count <= previous.max_count) {
      throw new BillingInputError('pricing tiers must not overlap');
    }
  }
  return tiers;
}

/** @param {unknown} value @returns {string | null} */
export function validateVendor(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !LEDGER_VENDORS.includes(value)) throw new BillingInputError('invalid vendor');
  return value;
}

/** @param {unknown} start @param {unknown} end */
export function validateEffectiveDates(start, end) {
  if (start != null && !isCalendarDate(start)) throw new BillingInputError('effective_from must be a real date (YYYY-MM-DD)');
  if (end != null && !isCalendarDate(end)) throw new BillingInputError('effective_to must be a real date (YYYY-MM-DD)');
  if (typeof start === 'string' && typeof end === 'string' && end < start) throw new BillingInputError('effective_to must not precede effective_from');
}
