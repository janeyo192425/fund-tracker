const WEEKDAYS = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

function taipeiToday(now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map(part => [part.type, Number(part.value)]));
  return new Date(Date.UTC(value.year, value.month - 1, value.day));
}

function dateString(value) { return value.toISOString().slice(0, 10); }
function addDays(value, days) { return new Date(value.getTime() + days * 86400000); }

function nextMonthlyDate(day, time, now) {
  const base = taipeiToday(now);
  for (let offset = 0; offset < 13; offset++) {
    const candidate = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + offset, day));
    if (candidate.getUTCDate() !== day) continue;
    const date = dateString(candidate);
    if (new Date(`${date}T${time}:00+08:00`) > now) return date;
  }
  return null;
}

function parseDate(text, now) {
  const base = taipeiToday(now);
  let match = text.match(/(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
  if (match) {
    const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
    return { token: match[0], date: dateString(date) };
  }
  match = text.match(/(\d{1,2})[\/-](\d{1,2})(?:日|號)?/);
  if (match) {
    let date = new Date(Date.UTC(base.getUTCFullYear(), +match[1] - 1, +match[2]));
    if (date < base) date = new Date(Date.UTC(base.getUTCFullYear() + 1, +match[1] - 1, +match[2]));
    return { token: match[0], date: dateString(date) };
  }
  match = text.match(/(大後天|後天|明天|今天)/);
  if (match) return { token: match[0], date: dateString(addDays(base, { 今天: 0, 明天: 1, 後天: 2, 大後天: 3 }[match[0]])) };
  match = text.match(/(下(?:個)?(?:禮拜|星期|週)|這(?:個)?(?:禮拜|星期|週)|本週|週|星期|禮拜)([日天一二三四五六])/);
  if (match) {
    const mondayOffset = (base.getUTCDay() + 6) % 7;
    const targetOffset = (WEEKDAYS[match[2]] + 6) % 7;
    let days = targetOffset - mondayOffset + (match[1].startsWith('下') ? 7 : 0);
    if (days < 0) days += 7;
    return { token: match[0], date: dateString(addDays(base, days)) };
  }
  return null;
}

function parseTime(text) {
  const match = text.match(/(凌晨|清晨|早上|上午|中午|下午|傍晚|晚上)?\s*([01]?\d|2[0-3])\s*(?:[:：]\s*([0-5]\d)|點\s*(半|[0-5]?\d\s*分?)?)/);
  if (!match) return null;
  let hour = Number(match[2]);
  const minute = match[4]?.includes('半') ? 30 : Number(match[3] || match[4]?.match(/\d+/)?.[0] || 0);
  if (['下午', '傍晚', '晚上'].includes(match[1]) && hour < 12) hour += 12;
  if (['凌晨', '清晨', '早上', '上午'].includes(match[1]) && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return { token: match[0], time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
}

function parseLocal(text, now = new Date()) {
  const monthly = text.match(/每(?:個)?月(?:的)?\s*(\d{1,2})\s*(?:號|日)/);
  if (monthly) {
    const day = Number(monthly[1]);
    const time = parseTime(text);
    if (day < 1 || day > 31 || !time) return { valid: false, question: '請提供每月幾號、時間和提醒內容。' };
    const date = nextMonthlyDate(day, time.time, now);
    const leadMatch = text.match(/提前\s*(\d{1,4})\s*(分鐘|分|小時|時)\s*提醒/);
    const reminderMinutes = leadMatch ? Number(leadMatch[1]) * (leadMatch[2].includes('小時') || leadMatch[2] === '時' ? 60 : 1) : 0;
    const title = text.replace(monthly[0], ' ').replace(time.token, ' ')
      .replace(/提前\s*\d{1,4}\s*(?:分鐘|分|小時|時)\s*提醒/g, ' ')
      .replace(/^(?:\s*都)?\s*(?:請)?\s*(?:幫我)?\s*(?:設定)?\s*(?:提醒我?|記得提醒我?)?/, '')
      .replace(/\s+/g, ' ').trim();
    if (!title) return { valid: false, question: '每月要提醒什麼事？請把日期、時間和內容寫在同一則訊息。' };
    return { valid: true, title: title.slice(0, 240), date, startTime: time.time,
      endTime: '', endDate: '', location: '', reminderMinutes,
      recurrence: `RRULE:FREQ=MONTHLY;BYMONTHDAY=${day}` };
  }
  const date = parseDate(text, now);
  const time = parseTime(text);
  if (!date || !time) return { valid: false, question: '請在同一則訊息提供日期、時間和提醒內容，例如：「這週六中午12:30提醒我帶行李箱」。' };
  const leadMatch = text.match(/提前\s*(\d{1,4})\s*(分鐘|分|小時|時)\s*提醒/);
  const exactReminder = /提醒我|提醒一下|到時提醒/.test(text) && !leadMatch;
  const reminderMinutes = leadMatch ? Number(leadMatch[1]) * (leadMatch[2].includes('小時') || leadMatch[2] === '時' ? 60 : 1) : exactReminder ? 0 : 30;
  let title = text.replace(date.token, ' ').replace(time.token, ' ')
    .replace(/提前\s*\d{1,4}\s*(?:分鐘|分|小時|時)\s*提醒/g, ' ')
    .replace(/(?:請)?提醒我|提醒一下|到時提醒|加入行事曆/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ').trim()
    .replace(/^[，,：:、\s]+|[，,：:、\s]+$/g, '');
  if (!title) return { valid: false, question: '要提醒你什麼事？請把內容、日期和時間寫在同一則訊息。' };
  return { valid: true, title: title.slice(0, 240), date: date.date, startTime: time.time, endTime: '', endDate: '', location: '', reminderMinutes };
}

module.exports = { parseLocal };
