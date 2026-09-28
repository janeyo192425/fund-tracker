const crypto = require('node:crypto');
const { due } = require('./time.cjs');
const env = process.env;
function retryKey(value) {
  const h = crypto.createHash('sha256').update(value).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;
}
async function runReminders(token) {
  if (!env.LINE_USER_ID || env.REMINDERS_ENABLED !== 'true') throw new Error('Reminders are not configured');
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID || 'primary')}/events`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const now = Date.now(); let pageToken, sent = 0;
  do {
    const query = new URLSearchParams({ timeMin: new Date(now - 300000).toISOString(), timeMax: new Date(now + 8 * 86400000).toISOString(), singleEvents: 'true', maxResults: '250' });
    if (pageToken) query.set('pageToken', pageToken);
    const r = await fetch(`${base}?${query}`, { headers, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`Calendar list failed: ${r.status}`);
    const data = await r.json(); pageToken = data.nextPageToken;
    for (const event of data.items || []) {
      if (!due(event, now)) continue;
      const privateProps = event.extendedProperties?.private || {};
      if (privateProps.lineOwner && privateProps.lineOwner !== env.LINE_USER_ID) continue;
      const start = event.start.dateTime, minutes = Math.ceil((+new Date(start) - now) / 60000);
      const time = new Date(start).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
      const push = await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST', signal: AbortSignal.timeout(20000),
        headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`, 'Content-Type': 'application/json', 'X-Line-Retry-Key': retryKey(`${env.GOOGLE_CALENDAR_ID || 'primary'}:${event.id}:${start}`) },
        body: JSON.stringify({ to: env.LINE_USER_ID, messages: [{ type: 'text', text: `⏰ ${minutes > 0 ? `再過 ${minutes} 分鐘` : '活動已開始'}\n${event.summary || '未命名活動'}\n${time}${event.location ? '\n📍 ' + event.location : ''}`.slice(0,4900) }] }),
      });
      if (!push.ok && !(push.status === 409 && push.headers.get('x-line-accepted-request-id'))) throw new Error(`LINE push failed: ${push.status}`);
      const patch = await fetch(`${base}/${encodeURIComponent(event.id)}`, {
        method: 'PATCH', headers, signal: AbortSignal.timeout(20000),
        body: JSON.stringify({ extendedProperties: { private: { ...privateProps, lineRemindedStart: start } } }),
      });
      if (!patch.ok) throw new Error(`Calendar reminder marker failed: ${patch.status}`);
      sent++;
    }
  } while (pageToken);
  return { sent };
}
module.exports = { runReminders, retryKey };
