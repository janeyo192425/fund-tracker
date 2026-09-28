const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
process.env.LINE_CHANNEL_SECRET = 'test-secret';
process.env.LINE_USER_ID = 'owner';
const { lineWebhook } = require('./index.js');
function response() { return { code: 0, status(v) { this.code=v; return this; }, send(v) { this.body=v; return this; }, json(v) { this.body=v; return this; } }; }
function request(events, signature = true) {
  const rawBody = Buffer.from(JSON.stringify({ events }));
  return { method: 'POST', path: '/', body: { events }, rawBody, get: name => name === 'x-line-signature' && signature ? crypto.createHmac('sha256','test-secret').update(rawBody).digest('base64') : '' };
}
test('invalid LINE signature is rejected before any network access', async () => {
  const res=response(); await lineWebhook(request([], false), res); assert.equal(res.code,401);
});
test('LINE webhook verification accepts an empty signed event list', async () => {
  const res=response(); await lineWebhook(request([]), res); assert.equal(res.code,200);
});
test('non-owner cannot access Google Calendar or Gemini', async () => {
  const original=global.fetch; let calls=0;
  global.fetch=async url => { calls++; assert.equal(url,'https://api.line.me/v2/bot/message/reply'); return {ok:true}; };
  try {
    const res=response(); await lineWebhook(request([{type:'message', source:{type:'user',userId:'stranger'},message:{type:'text',text:'明天開會'},replyToken:'test'}]),res);
    assert.equal(res.code,200); assert.equal(calls,1);
  } finally { global.fetch=original; }
});
test('reminder endpoint requires authentication', async () => {
  process.env.SCHEDULER_EMAIL='scheduler@example.com'; process.env.SCHEDULER_AUDIENCE='https://example.com/reminders';
  const res=response(); await lineWebhook({method:'POST',path:'/reminders',get:()=>''},res); assert.equal(res.code,401);
});
