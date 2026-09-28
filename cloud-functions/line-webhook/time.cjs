const ZONE = 'Asia/Taipei';
function localDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
function instant(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time || '')) throw new Error('請提供有效的日期與時間。');
  const value = new Date(`${date}T${time}:00+08:00`);
  if (!Number.isFinite(+value) || localDate(value) !== date) throw new Error('日期不存在，請再確認一次。');
  return value;
}
function eventTimes(parsed, now = new Date()) {
  const start = instant(parsed.date, parsed.startTime);
  const end = parsed.endTime ? instant(parsed.endDate || parsed.date, parsed.endTime) : new Date(+start + 3600000);
  if (parsed.endTime && !parsed.endDate && end < start) end.setTime(+end + 86400000);
  if (end <= start) throw new Error('結束時間必須晚於開始時間。');
  if (start <= now) throw new Error('這個時間已經過了，請提供未來的日期與時間。');
  const lead = parsed.reminderMinutes == null ? 30 : parsed.reminderMinutes;
  if (!Number.isInteger(lead) || lead < 0 || lead > 10080) throw new Error('提醒時間請設定為提前 0 到 10080 分鐘。');
  return { start, end, lead };
}
function due(event, now) {
  if (!event.start?.dateTime || event.status === 'cancelled') return false;
  const start = +new Date(event.start.dateTime);
  const p = event.extendedProperties?.private || {};
  const lead = Number(p.lineLeadMinutes ?? 30);
  if (!Number.isFinite(lead) || lead < 0 || lead > 10080) return false;
  // Allow a short catch-up interval, but never send stale reminders hours later.
  return now >= start - lead * 60000 && now <= start + 5 * 60000 && p.lineRemindedStart !== event.start.dateTime;
}
module.exports = { localDate, instant, eventTimes, due, ZONE };
