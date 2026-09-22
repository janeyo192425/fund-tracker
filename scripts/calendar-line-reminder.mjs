#!/usr/bin/env node
// Fetches today's Google Calendar events and pushes a summary to LINE.
// Required env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN,
//                     LINE_CHANNEL_ACCESS_TOKEN, LINE_USER_ID
// Optional env vars: GOOGLE_CALENDAR_ID (default "primary"), TIMEZONE (default "Asia/Taipei")

import { google } from 'googleapis';

const {
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REFRESH_TOKEN,
    GOOGLE_CALENDAR_ID = 'primary',
    TIMEZONE = 'Asia/Taipei',
    LINE_CHANNEL_ACCESS_TOKEN,
    LINE_USER_ID,
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

async function fetchTodaysEvents() {
    const oauth2Client = new google.auth.OAuth2(
        requireEnv('GOOGLE_CLIENT_ID', GOOGLE_CLIENT_ID),
        requireEnv('GOOGLE_CLIENT_SECRET', GOOGLE_CLIENT_SECRET)
    );
    oauth2Client.setCredentials({ refresh_token: requireEnv('GOOGLE_REFRESH_TOKEN', GOOGLE_REFRESH_TOKEN) });

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const { start, end, label } = todayRange(TIMEZONE);

    const { data } = await calendar.events.list({
        calendarId: GOOGLE_CALENDAR_ID,
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        timeZone: TIMEZONE,
        singleEvents: true,
        orderBy: 'startTime',
    });

    return { events: data.items ?? [], dateLabel: label };
}

function formatEventLine(event, timeZone) {
    const isAllDay = Boolean(event.start?.date && !event.start?.dateTime);
    const time = isAllDay
        ? '整天'
        : new Date(event.start.dateTime).toLocaleTimeString('zh-TW', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
              timeZone,
          });
    const location = event.location ? ` @ ${event.location}` : '';
    return `🔸 ${time} ${event.summary || '(無標題)'}${location}`;
}

function buildMessage(events, dateLabel, timeZone) {
    if (events.length === 0) {
        return `📅 ${dateLabel} 今天的行事曆\n\n今天沒有安排任何行程，好好休息一下吧！`;
    }
    const lines = events.map((event) => formatEventLine(event, timeZone));
    return `📅 ${dateLabel} 今天的行事曆（共 ${events.length} 項）\n\n${lines.join('\n')}`;
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
    const { events, dateLabel } = await fetchTodaysEvents();
    const message = buildMessage(events, dateLabel, TIMEZONE);
    await pushToLine(message);
    console.log(`Sent LINE reminder for ${dateLabel} (${events.length} event(s)).`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
