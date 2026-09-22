#!/usr/bin/env node
// Fetches a day's events from Google Calendar (and optionally a CalDAV
// calendar, e.g. DingTalk/鼎加), flags scheduling conflicts, and pushes a
// summary to LINE. Used both for the 07:00 "today" run and the 21:00
// "tomorrow" preview run (via DAY_OFFSET).
//
// Required env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN,
//                     LINE_CHANNEL_ACCESS_TOKEN, LINE_USER_ID
// Optional env vars: GOOGLE_CALENDAR_ID (default "primary"), TIMEZONE (default "Asia/Taipei")
//                     CALDAV_SERVER_URL, CALDAV_USERNAME, CALDAV_PASSWORD, CALDAV_LABEL (default "鼎加")
//                     DAY_OFFSET (default 0 = today, 1 = tomorrow)

import { fetchGoogleEvents, fetchCalDavEvents, pushToLine, detectConflicts, formatConflictLine } from './lib/calendar.mjs';

const {
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REFRESH_TOKEN,
    GOOGLE_CALENDAR_ID,
    TIMEZONE = 'Asia/Taipei',
    LINE_CHANNEL_ACCESS_TOKEN,
    LINE_USER_ID,
    CALDAV_SERVER_URL,
    CALDAV_USERNAME,
    CALDAV_PASSWORD,
    CALDAV_LABEL,
    DAY_OFFSET = '0',
} = process.env;

function dayRange(timeZone, dayOffset) {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone }));
    const day = now.getDate() + dayOffset;
    const start = new Date(now.getFullYear(), now.getMonth(), day, 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth(), day, 23, 59, 59);
    return { start, end, label: `${start.getFullYear()}/${start.getMonth() + 1}/${start.getDate()}` };
}

function formatEventLine(event, timeZone) {
    const time = event.allDay
        ? '整天'
        : event.start.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone });
    const location = event.location ? ` @ ${event.location}` : '';
    const tag = event.source === 'google' ? '' : `[${event.source}] `;
    return `🔸 ${time} ${tag}${event.title}${location}`;
}

function buildMessage({ events, dateLabel, timeZone, warnings, conflicts, isPreview }) {
    const headerVerb = isPreview ? '明天的行事曆預告' : '今天的行事曆';
    const conflictLines = conflicts.length
        ? `\n\n⚡ 行程衝突提醒\n${conflicts.map((c) => formatConflictLine(c, timeZone)).join('\n')}`
        : '';
    const warningLines = warnings.length ? `\n\n⚠️ ${warnings.join('\n⚠️ ')}` : '';

    if (events.length === 0) {
        return `📅 ${dateLabel} ${headerVerb}\n\n${isPreview ? '明天' : '今天'}沒有安排任何行程，好好休息一下吧！${warningLines}`;
    }

    const sorted = [...events].sort((a, b) => a.start - b.start);
    const lines = sorted.map((event) => formatEventLine(event, timeZone));
    return `📅 ${dateLabel} ${headerVerb}（共 ${events.length} 項）\n\n${lines.join('\n')}${conflictLines}${warningLines}`;
}

async function main() {
    const isPreview = DAY_OFFSET !== '0';
    const { start, end, label } = dayRange(TIMEZONE, Number(DAY_OFFSET));
    const warnings = [];

    const googleEvents = await fetchGoogleEvents({
        clientId: GOOGLE_CLIENT_ID,
        clientSecret: GOOGLE_CLIENT_SECRET,
        refreshToken: GOOGLE_REFRESH_TOKEN,
        calendarId: GOOGLE_CALENDAR_ID,
        timeZone: TIMEZONE,
        start,
        end,
    });

    let calDavEvents = [];
    try {
        calDavEvents = await fetchCalDavEvents({
            serverUrl: CALDAV_SERVER_URL,
            username: CALDAV_USERNAME,
            password: CALDAV_PASSWORD,
            label: CALDAV_LABEL,
            start,
            end,
        });
    } catch (err) {
        console.error('CalDAV fetch failed:', err);
        warnings.push(`${CALDAV_LABEL || '鼎加'}行事曆讀取失敗，本次只顯示 Google 日曆內容`);
    }

    const events = [...googleEvents, ...calDavEvents];
    const conflicts = detectConflicts(events);
    const message = buildMessage({ events, dateLabel: label, timeZone: TIMEZONE, warnings, conflicts, isPreview });
    await pushToLine({ token: LINE_CHANNEL_ACCESS_TOKEN, to: LINE_USER_ID, message });
    console.log(
        `Sent ${isPreview ? 'preview' : 'daily'} LINE reminder for ${label} (${events.length} event(s), ${conflicts.length} conflict(s), ${warnings.length} warning(s)).`
    );
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
