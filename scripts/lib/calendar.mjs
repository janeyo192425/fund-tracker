// Shared calendar-fetching helpers used by both the daily summary and the
// upcoming-meeting reminder scripts.

import { google } from 'googleapis';
import { createDAVClient } from 'tsdav';
import ical from 'node-ical';

export function requireEnv(name, value) {
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
}

export async function fetchGoogleEvents({ clientId, clientSecret, refreshToken, calendarId, timeZone, start, end }) {
    const oauth2Client = new google.auth.OAuth2(
        requireEnv('GOOGLE_CLIENT_ID', clientId),
        requireEnv('GOOGLE_CLIENT_SECRET', clientSecret)
    );
    oauth2Client.setCredentials({ refresh_token: requireEnv('GOOGLE_REFRESH_TOKEN', refreshToken) });

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const { data } = await calendar.events.list({
        calendarId: calendarId || 'primary',
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        timeZone,
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

export async function fetchCalDavEvents({ serverUrl, username, password, label, start, end }) {
    if (!serverUrl || !username || !password) return [];

    const normalizedUrl = /^https?:\/\//.test(serverUrl) ? serverUrl : `https://${serverUrl}`;

    const client = await createDAVClient({
        serverUrl: normalizedUrl,
        credentials: { username, password },
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
                    source: label || '鼎加',
                });
            }
        }
    }

    return events;
}

export async function pushToLine({ token, to, message }) {
    const response = await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${requireEnv('LINE_CHANNEL_ACCESS_TOKEN', token)}`,
        },
        body: JSON.stringify({ to: requireEnv('LINE_USER_ID', to), messages: [{ type: 'text', text: message }] }),
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`LINE push failed (${response.status}): ${body}`);
    }
}
