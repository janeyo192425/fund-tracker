const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseLocal } = require('./parse-local.cjs');

const monday = new Date('2026-09-28T02:41:00Z');

test('direct Saturday reminder fires at 12:30 and keeps the packing list', () => {
  const parsed = parseLocal('這禮拜六提醒我12:30\n要給媽咪的東西1.行李箱2.昨天帶的保溫袋3.行充', monday);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.date, '2026-10-03');
  assert.equal(parsed.startTime, '12:30');
  assert.equal(parsed.reminderMinutes, 0);
  assert.match(parsed.title, /行李箱/);
  assert.match(parsed.title, /昨天帶的保溫袋/);
  assert.match(parsed.title, /行充/);
});

test('appointment with explicit lead retains advance reminder', () => {
  const parsed = parseLocal('明天下午3點看牙醫，提前30分鐘提醒', monday);
  assert.equal(parsed.date, '2026-09-29');
  assert.equal(parsed.startTime, '15:00');
  assert.equal(parsed.reminderMinutes, 30);
  assert.equal(parsed.title, '看牙醫');
});

test('missing date asks for a complete message', () => {
  assert.equal(parseLocal('12:30提醒我帶行李箱', monday).valid, false);
});
