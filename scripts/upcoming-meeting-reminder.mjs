#!/usr/bin/env node
// Checks for events starting soon (Google Calendar + optional CalDAV) and
// pushes a LINE alert shortly before they begin. Meant to run on a short
// interval (e.g. every 5 minutes) via a scheduled GitHub Action.
//
// Required env vars: same as calendar-line-reminder.mjs
// Optional env vars: also LEAD_MINUTES (default 15) and INTERVAL_MINUTES (default 5,
//                     should match the cron interval this script runs on).

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
    LEAD_MINUTES = '15',
    INTERVAL_MINUTES = '5',
} = process.env;

const leadMinutes = Number(LEAD_MINUTES);
const intervalMinutes = Number(INTERVAL_MINUTES);

function todayRange(timeZone) {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone }));
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    return { start, end };
}

function formatUpcomingLine(event, minutesLeft, timeZone) {
    const time = event.start.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone });
    const location = event.location ? ` @ ${event.location}` : '';
    const tag = event.source === 'google' ? '' : `[${event.source}] `;
    return `🔸 ${time}（${minutesLeft} 分鐘後）${tag}${event.title}${location}`;
}

async function main() {
    const now = new Date();
    const { start, end } = todayRange(TIMEZONE);

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
        console.error('CalDAV fetch failed (skipping for this check):', err);
    }

    const events = [...googleEvents, ...calDavEvents].filter((event) => !event.allDay);

    const upcoming = events
        .map((event) => ({ event, minutesLeft: Math.round((event.start - now) / 60000) }))
        .filter(({ minutesLeft }) => minutesLeft > leadMinutes - intervalMinutes && minutesLeft <= leadMinutes)
        .sort((a, b) => a.event.start - b.event.start);

    if (upcoming.length === 0) {
        console.log('No upcoming events in the reminder window; nothing sent.');
        return;
    }

    const lines = upcoming.map(({ event, minutesLeft }) => formatUpcomingLine(event, minutesLeft, TIMEZONE));
    const message = `⏰ 即將開始的行程\n\n${lines.join('\n')}`;

    await pushToLine({ token: LINE_CHANNEL_ACCESS_TOKEN, to: LINE_USER_ID, message });
    console.log(`Sent upcoming-meeting reminder for ${upcoming.length} event(s).`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
