#!/usr/bin/env node
// Fetches today's events from Google Calendar (and optionally a CalDAV
// calendar, e.g. DingTalk/鼎加) and pushes a daily summary to LINE.
//
// Required env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN,
//                     LINE_CHANNEL_ACCESS_TOKEN, LINE_USER_ID
// Optional env vars: GOOGLE_CALENDAR_ID (default "primary"), TIMEZONE (default "Asia/Taipei")
//                     CALDAV_SERVER_URL, CALDAV_USERNAME, CALDAV_PASSWORD, CALDAV_LABEL (default "鼎加")
//                     — when the three CALDAV_* credentials are all set, that calendar's
//                       events are merged in; otherwise it's skipped.

import { fetchGoogleEvents, fetchCalDavEvents, pushToLine } from './lib/calendar.mjs';

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
} = process.env;

function todayRange(timeZone) {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone }));
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    return { start, end, label: `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}` };
}

function formatEventLine(event, timeZone) {
    const time = event.allDay
        ? '整天'
        : event.start.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone });
    const location = event.location ? ` @ ${event.location}` : '';
    const tag = event.source === 'google' ? '' : `[${event.source}] `;
    return `🔸 ${time} ${tag}${event.title}${location}`;
}

function buildMessage(events, dateLabel, timeZone, warnings) {
    const warningLines = warnings.length ? `\n\n⚠️ ${warnings.join('\n⚠️ ')}` : '';

    if (events.length === 0) {
        return `📅 ${dateLabel} 今天的行事曆\n\n今天沒有安排任何行程，好好休息一下吧！${warningLines}`;
    }

    const sorted = [...events].sort((a, b) => a.start - b.start);
    const lines = sorted.map((event) => formatEventLine(event, timeZone));
    return `📅 ${dateLabel} 今天的行事曆（共 ${events.length} 項）\n\n${lines.join('\n')}${warningLines}`;
}

async function main() {
    const { start, end, label } = todayRange(TIMEZONE);
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
    const message = buildMessage(events, label, TIMEZONE, warnings);
    await pushToLine({ token: LINE_CHANNEL_ACCESS_TOKEN, to: LINE_USER_ID, message });
    console.log(`Sent daily LINE reminder for ${label} (${events.length} event(s), ${warnings.length} warning(s)).`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
