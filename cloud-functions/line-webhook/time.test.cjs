const { test } = require('node:test');
const assert = require('node:assert/strict');
const { eventTimes, instant, due } = require('./time.cjs');
const now = new Date('2026-09-28T00:00:00Z');
test('default duration crosses midnight into next date', () => {
  const result = eventTimes({ date: '2026-09-28', startTime: '23:30' }, now);
  assert.equal(result.end.toISOString(), '2026-09-28T16:30:00.000Z');
  assert.equal(result.lead, 30);
});
test('explicit overnight end rolls over', () => {
  const result = eventTimes({ date: '2026-09-28', startTime: '23:30', endTime: '01:00' }, now);
  assert.equal(result.end.toISOString(), '2026-09-28T17:00:00.000Z');
});
test('invalid and past dates cannot create events', () => {
  assert.throws(() => instant('2026-02-30', '12:00'));
  assert.throws(() => instant('2026-09-28', '25:00'));
  assert.throws(() => eventTimes({ date: '2026-09-27', startTime: '12:00' }, now));
  assert.throws(() => eventTimes({ date: '2026-09-28', startTime: '12:00', reminderMinutes: -1 }, now));
});
test('reminders catch delayed checks, skip sent, cancelled and all-day events', () => {
  const e = { start: { dateTime: '2026-09-28T10:00:00+08:00' } };
  assert.equal(due(e, +new Date('2026-09-28T09:29:00+08:00')), false);
  assert.equal(due(e, +new Date('2026-09-28T09:45:00+08:00')), true);
  assert.equal(due(e, +new Date('2026-09-28T10:06:00+08:00')), false);
  assert.equal(due({ ...e, status: 'cancelled' }, +new Date('2026-09-28T09:45:00+08:00')), false);
  assert.equal(due({ start: { date: '2026-09-28' } }, +now), false);
  assert.equal(due({ ...e, extendedProperties: { private: { lineRemindedStart: e.start.dateTime } } }, +new Date('2026-09-28T09:45:00+08:00')), false);
});
