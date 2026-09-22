// Shared calendar-fetching helpers used by both the daily summary and the
// upcoming-meeting reminder scripts.

import { google } from 'googleapis';
import { createDAVClient, propfind } from 'tsdav';
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
            end: allDay ? new Date(`${event.end.date}T00:00:00`) : new Date(event.end.dateTime),
            allDay,
            location: event.location || '',
            description: event.description || '',
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
    console.log(`CalDAV: found ${calendars.length} calendar(s)`);
    const events = [];

    for (const cal of calendars) {
        const calName = cal.displayName || cal.url;
        let objects = [];

        try {
            objects = await client.fetchCalendarObjects({
                calendar: cal,
                timeRange: { start: start.toISOString(), end: end.toISOString() },
            });
        } catch (err) {
            console.error(`CalDAV: time-range query failed for "${calName}":`, err.message);
        }

        if (objects.length === 0) {
            // Some CalDAV servers (observed with DingTalk) silently ignore the
            // time-range filter and return nothing instead of everything, so
            // fall back to fetching the whole calendar and filtering locally.
            try {
                objects = await client.fetchCalendarObjects({ calendar: cal });
                console.log(`CalDAV: "${calName}" unfiltered query returned ${objects.length} object(s)`);
            } catch (err) {
                console.error(`CalDAV: unfiltered query failed for "${calName}":`, err.message);
            }
        }

        if (objects.length === 0) {
            // Some servers reject any calendar-query REPORT outright. Fall
            // back to a plain WebDAV PROPFIND listing of the collection and
            // fetch each .ics resource directly (bypasses REPORT entirely).
            try {
                const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
                const responses = await propfind({
                    url: cal.url,
                    props: { 'd:getetag': {} },
                    depth: '1',
                    headers: { Authorization: authHeader },
                });
                console.log(
                    `CalDAV: PROPFIND on "${cal.url}" got ${responses.length} raw response(s): ${JSON.stringify(
                        responses.map((r) => ({ href: r.href, status: r.status || r.props?.status }))
                    )}`
                );
                const hrefs = responses
                    .map((r) => r.href)
                    .filter((href) => typeof href === 'string' && href !== cal.url && !href.endsWith('/'));
                console.log(`CalDAV: PROPFIND fallback found ${hrefs.length} .ics href(s) for "${calName}"`);
                if (hrefs.length > 0) {
                    objects = await client.fetchCalendarObjects({ calendar: cal, objectUrls: hrefs });
                }
            } catch (err) {
                console.error(`CalDAV: PROPFIND fallback failed for "${calName}":`, err.message);
            }
        }

        console.log(`CalDAV: "${calName}" final object count: ${objects.length}`);

        for (const obj of objects) {
            if (!obj.data) continue;
            const parsed = ical.parseICS(obj.data);
            for (const key of Object.keys(parsed)) {
                const ev = parsed[key];
                if (ev.type !== 'VEVENT' || !ev.start) continue;

                // Expands RRULE/EXDATE/RECURRENCE-ID properly, and also just
                // returns the single instance for non-recurring events.
                const instances = ical.expandRecurringEvent(ev, { from: start, to: end });
                for (const instance of instances) {
                    events.push({
                        title: instance.summary || ev.summary || '(無標題)',
                        start: instance.start,
                        end: instance.end,
                        allDay: instance.isFullDay,
                        location: (instance.event && instance.event.location) || ev.location || '',
                        description: (instance.event && instance.event.description) || ev.description || '',
                        source: label || '鼎加',
                    });
                }
            }
        }
    }

    return events;
}

const BACK_TO_BACK_BUFFER_MINUTES = 5;

// Compares timed (non-all-day) events pairwise and flags direct overlaps and
// tight back-to-back gaps, sorted so the earlier of each pair appears first.
export function detectConflicts(events) {
    const timed = events.filter((e) => !e.allDay).sort((a, b) => a.start - b.start);
    const conflicts = [];

    for (let i = 0; i < timed.length; i += 1) {
        for (let j = i + 1; j < timed.length; j += 1) {
            const a = timed[i];
            const b = timed[j];
            if (b.start >= a.end) break; // timed[j+...] start even later, no more overlaps with a

            conflicts.push({ type: 'overlap', a, b });
        }
    }

    for (let i = 0; i < timed.length - 1; i += 1) {
        const a = timed[i];
        const b = timed[i + 1];
        const gapMinutes = (b.start - a.end) / 60000;
        if (gapMinutes >= 0 && gapMinutes < BACK_TO_BACK_BUFFER_MINUTES) {
            conflicts.push({ type: 'tight-gap', a, b, gapMinutes: Math.round(gapMinutes) });
        }
    }

    return conflicts;
}

export function formatConflictLine(conflict, timeZone) {
    const fmt = (d) => d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone });
    if (conflict.type === 'overlap') {
        return `🔺 「${conflict.a.title}」（${fmt(conflict.a.start)}-${fmt(conflict.a.end)}）跟「${conflict.b.title}」（${fmt(conflict.b.start)}-${fmt(conflict.b.end)}）時間重疊，建議找代理人代開其中一場，或聯絡對方改時間`;
    }
    return `🔺 「${conflict.a.title}」結束後只有 ${conflict.gapMinutes} 分鐘就要開始「${conflict.b.title}」，中間幾乎沒有緩衝，建議提早出發或請對方稍等`;
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
