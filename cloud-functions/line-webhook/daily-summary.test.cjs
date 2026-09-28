const test = require('node:test');
const assert = require('node:assert/strict');
const { taipeiDate, shouldSendDailySummary, dayRange, retryKey, formatMessage } = require('./daily-summary.cjs');

test('morning summary checks the 07:00–07:09 Taipei window', () => {
  assert.equal(shouldSendDailySummary(new Date('2026-09-28T22:59:00Z')), false);
  assert.equal(shouldSendDailySummary(new Date('2026-09-28T23:00:00Z')), true);
  assert.equal(shouldSendDailySummary(new Date('2026-09-28T23:09:59Z')), true);
  assert.equal(shouldSendDailySummary(new Date('2026-09-28T23:10:00Z')), false);
});

test('date range and retry key stay stable for the Taipei day', () => {
  const now = new Date('2026-09-28T23:01:00Z');
  const date = taipeiDate(now);
  assert.equal(date, '2026-09-29');
  assert.equal(dayRange(date).start.toISOString(), '2026-09-28T16:00:00.000Z');
  assert.equal(dayRange(date).end.toISOString(), '2026-09-29T16:00:00.000Z');
  assert.equal(retryKey(date), retryKey(date));
  assert.notEqual(retryKey(date), retryKey('2026-09-30'));
});

test('morning message contains all sources and conflict warnings', () => {
  const message = formatMessage('2026-09-29', [
    { title: 'Google 會議', source: 'google', start: new Date('2026-09-29T01:00:00Z'), location: '' },
    { title: '釘釘會議', source: '釘釘', start: new Date('2026-09-29T01:30:00Z'), location: '辦公室' },
  ], [{ type: 'overlap' }], () => '兩場時間重疊');
  assert.match(message, /Google 會議/);
  assert.match(message, /釘釘會議/);
  assert.match(message, /兩場時間重疊/);
});
