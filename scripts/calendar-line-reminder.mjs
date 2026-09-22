#!/usr/bin/env node
// Fetches today's events from Google Calendar (and optionally a CalDAV
// calendar, e.g. DingTalk/鼎加) and pushes a summary to LINE.
//
// Required env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN,
//                     LINE_CHANNEL_ACCESS_TOKEN, LINE_USER_ID
// Optional env vars: GOOGLE_CALENDAR_ID (default "primary"), TIMEZONE (default "Asia/Taipei")
//                     CALDAV_SERVER_URL, CALDAV_USERNAME, CALDAV_PASSWORD, CALDAV_LABEL (default "鼎加")
//                     — when the three CALDAV_* credentials are all set, that calendar's
//                       events are merged in; otherwise it's skipped.

import { google } from 'googleapis';
import { createDAVClient } from 'tsdav';
import ical from 'node-ical';

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

function requireEnv(name, value) {
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
}

function todayRange(timeZone) {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone }));
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    return { start, end, label: `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}` };
}

async function fetchGoogleEvents(start, end) {
    const oauth2Client = new google.auth.OAuth2(
        requireEnv('GOOGLE_CLIENT_ID', GOOGLE_CLIENT_ID),
        requireEnv('GOOGLE_CLIENT_SECRET', GOOGLE_CLIENT_SECRET)
    );
    oauth2Client.setCredentials({ refresh_token: requireEnv('GOOGLE_REFRESH_TOKEN', GOOGLE_REFRESH_TOKEN) });

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const { data } = await calendar.events.list({
        calendarId: GOOGLE_CALENDAR_ID || 'primary',
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        timeZone: TIMEZONE,
        singleEvents: true,
        orderBy: 'startTime',
    });

    return (data.items ?? []).map((event) => {
        const allDay = Boolean(event.start?.date && !event.start?.dateTime);
        return {
            title: event.summary || '(無標題)',
            start: allDay ? new Date(`${event.start.date}T00:00:00`) : new Date(event.start.dateTime),
            allDay,
            location: event.location || '',
            source: 'google',
        };
    });
}

async function fetchCalDavEvents(start, end) {
    if (!CALDAV_SERVER_URL || !CALDAV_USERNAME || !CALDAV_PASSWORD) return [];

    const serverUrl = /^https?:\/\//.test(CALDAV_SERVER_URL) ? CALDAV_SERVER_URL : `https://${CALDAV_SERVER_URL}`;
    const label = CALDAV_LABEL || '鼎加';

    const client = await createDAVClient({
        serverUrl,
        credentials: { username: CALDAV_USERNAME, password: CALDAV_PASSWORD },
        authMethod: 'Basic',
        defaultAccountType: 'caldav',
    });

    const calendars = await client.fetchCalendars();
    const events = [];

    for (const cal of calendars) {
        const objects = await client.fetchCalendarObjects({
            calendar: cal,
            timeRange: { start: start.toISOString(), end: end.toISOString() },
        });

        for (const obj of objects) {
            if (!obj.data) continue;
            const parsed = ical.parseICS(obj.data);
            for (const key of Object.keys(parsed)) {
                const ev = parsed[key];
                if (ev.type !== 'VEVENT' || !ev.start) continue;
                if (ev.start < start || ev.start > end) continue;
                events.push({
                    title: ev.summary || '(無標題)',
                    start: ev.start,
                    allDay: ev.datetype === 'date',
                    location: ev.location || '',
                    source: label,
                });
            }
        }
    }

    return events;
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

async function pushToLine(message) {
    const token = requireEnv('LINE_CHANNEL_ACCESS_TOKEN', LINE_CHANNEL_ACCESS_TOKEN);
    const to = requireEnv('LINE_USER_ID', LINE_USER_ID);

    const response = await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ to, messages: [{ type: 'text', text: message }] }),
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`LINE push failed (${response.status}): ${body}`);
    }
}

async function main() {
    const { start, end, label } = todayRange(TIMEZONE);
    const warnings = [];

    const googleEvents = await fetchGoogleEvents(start, end);

    let calDavEvents = [];
    try {
        calDavEvents = await fetchCalDavEvents(start, end);
    } catch (err) {
        console.error('CalDAV fetch failed:', err);
        warnings.push(`${CALDAV_LABEL || '鼎加'}行事曆讀取失敗，本次只顯示 Google 日曆內容`);
    }

    const events = [...googleEvents, ...calDavEvents];
    const message = buildMessage(events, label, TIMEZONE, warnings);
    await pushToLine(message);
    console.log(`Sent LINE reminder for ${label} (${events.length} event(s), ${warnings.length} warning(s)).`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
