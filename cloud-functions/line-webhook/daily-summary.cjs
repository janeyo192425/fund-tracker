const crypto = require('node:crypto');

const TIME_ZONE = 'Asia/Taipei';

function taipeiDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function shouldSendDailySummary(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return Number(value.hour) === 7 && Number(value.minute) < 10;
}

function dayRange(date) {
  const start = new Date(`${date}T00:00:00+08:00`);
  return { start, end: new Date(start.getTime() + 86400000) };
}

function retryKey(date) {
  const h = crypto.createHash('sha256').update(`daily-summary:${date}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function formatMessage(date, events, conflicts, formatConflictLine, warnings = []) {
  const time = value => value.toLocaleTimeString('zh-TW', {
    timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const lines = [...events].sort((a, b) => a.start - b.start).map(event => {
    const label = event.allDay ? '全天' : time(event.start);
    const source = event.source === 'google' ? '' : `[${event.source}] `;
    return `• ${label} ${source}${event.title}${event.location ? ` @ ${event.location}` : ''}`;
  });
  let message = `📅 ${date.replaceAll('-', '/')} 今日行程（共 ${events.length} 項）\n\n${lines.length ? lines.join('\n') : '今天沒有安排行程。'}`;
  if (conflicts.length) message += `\n\n⚡ 行程衝突提醒\n${conflicts.map(c => formatConflictLine(c, TIME_ZONE)).join('\n')}`;
  if (warnings.length) message += `\n\n⚠️ ${warnings.join('\n⚠️ ')}`;
  return message.slice(0, 4900);
}

async function runDailySummary(now = new Date(), env = process.env) {
  if (!shouldSendDailySummary(now)) return { skipped: 'outside morning hour' };
  if (!env.CALDAV_SERVER_URL || !env.CALDAV_USERNAME || !env.CALDAV_PASSWORD) {
    return { skipped: 'CalDAV credentials not configured' };
  }
  const date = taipeiDate(now);
  const { start, end } = dayRange(date);
  const { fetchGoogleEvents, fetchCalDavEvents, detectConflicts, formatConflictLine } = await import('./calendar.mjs');
  const google = await fetchGoogleEvents({
    clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET,
    refreshToken: env.GOOGLE_REFRESH_TOKEN, calendarId: env.GOOGLE_CALENDAR_ID,
    timeZone: TIME_ZONE, start, end,
  });
  const caldav = await fetchCalDavEvents({
    serverUrl: env.CALDAV_SERVER_URL, username: env.CALDAV_USERNAME,
    password: env.CALDAV_PASSWORD, label: env.CALDAV_LABEL, start, end,
  });
  const events = [...google, ...caldav];
  const conflicts = detectConflicts(events);
  const message = formatMessage(date, events, conflicts, formatConflictLine);
  const response = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST', signal: AbortSignal.timeout(20000),
    headers: {
      Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
      'Content-Type': 'application/json', 'X-Line-Retry-Key': retryKey(date),
    },
    body: JSON.stringify({ to: env.LINE_USER_ID, messages: [{ type: 'text', text: message }] }),
  });
  if (!response.ok && !(response.status === 409 && response.headers.get('x-line-accepted-request-id'))) {
    throw new Error(`Daily LINE push failed: ${response.status}`);
  }
  return { date, events: events.length, conflicts: conflicts.length, sent: response.ok, duplicate: response.status === 409 };
}

module.exports = { taipeiDate, shouldSendDailySummary, dayRange, retryKey, formatMessage, runDailySummary };
