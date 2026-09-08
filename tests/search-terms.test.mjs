import test from 'node:test';
import assert from 'node:assert/strict';
import { splitSearchTerms } from '../src/shared/search-terms.mjs';

test('empty and blank input yields no terms', () => {
  assert.deepEqual(splitSearchTerms(''), []);
  assert.deepEqual(splitSearchTerms('   '), []);
  assert.deepEqual(splitSearchTerms(null), []);
  assert.deepEqual(splitSearchTerms(undefined), []);
});

test('a single term is returned as-is', () => {
  assert.deepEqual(splitSearchTerms('5551234567'), ['5551234567']);
});

test('commas, semicolons, newlines and tabs each split', () => {
  assert.deepEqual(splitSearchTerms('5551234567,5559876543'), ['5551234567', '5559876543']);
  assert.deepEqual(splitSearchTerms('5551234567;5559876543'), ['5551234567', '5559876543']);
  assert.deepEqual(splitSearchTerms('5551234567\n5559876543'), ['5551234567', '5559876543']);
  assert.deepEqual(splitSearchTerms('5551234567\t5559876543'), ['5551234567', '5559876543']);
});

// The regression this module was written for: typed or mobile-pasted number
// lists arrive space-separated and used to be treated as one term.
test('space-separated phone numbers split into one term each', () => {
  assert.deepEqual(
    splitSearchTerms('5551234567 5559876543 5555550000'),
    ['5551234567', '5559876543', '5555550000'],
  );
});

test('space-separated ICCIDs split into one term each', () => {
  assert.deepEqual(
    splitSearchTerms('89014103271234567890 89014103271234567891'),
    ['89014103271234567890', '89014103271234567891'],
  );
});

test('E.164 numbers keep their leading plus and still split', () => {
  assert.deepEqual(splitSearchTerms('+15551234567 +15559876543'), ['+15551234567', '+15559876543']);
});

// The other half of the contract: splitting on spaces must not break body search.
test('free text with spaces stays a single term', () => {
  assert.deepEqual(splitSearchTerms('your verification code'), ['your verification code']);
});

test('a mixed list of text and numbers is not split on spaces', () => {
  assert.deepEqual(splitSearchTerms('code 5551234567'), ['code 5551234567']);
});

test('short numeric tokens are not treated as an identifier list', () => {
  // "1 2 3" is far more likely to be prose than three ids.
  assert.deepEqual(splitSearchTerms('1 2 3'), ['1 2 3']);
});

test('comma-separated free text still splits per comma', () => {
  assert.deepEqual(splitSearchTerms('hello there, world'), ['hello there', 'world']);
});

test('punctuation is stripped but digits survive', () => {
  assert.deepEqual(splitSearchTerms('(555) 123-4567'), ['555 123-4567']);
});

test('empty fragments between separators are dropped', () => {
  assert.deepEqual(splitSearchTerms('5551234567,,,5559876543'), ['5551234567', '5559876543']);
  assert.deepEqual(splitSearchTerms(',5551234567,'), ['5551234567']);
});

test('term count is capped, default 10', () => {
  const many = Array.from({ length: 25 }, (_, i) => String(5550000000 + i)).join(',');
  assert.equal(splitSearchTerms(many).length, 10);
  assert.equal(splitSearchTerms(many, 3).length, 3);
  assert.deepEqual(splitSearchTerms(many, 3), ['5550000000', '5550000001', '5550000002']);
});

test('the cap applies to space-separated lists too', () => {
  const many = Array.from({ length: 25 }, (_, i) => String(5550000000 + i)).join(' ');
  assert.equal(splitSearchTerms(many).length, 10);
});
