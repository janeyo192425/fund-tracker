#!/usr/bin/env node
// Friday-evening recap: how many events this week covered, plus a
// day-by-day preview of next week (with conflict flags) from Google
// Calendar and the optional CalDAV calendar.
//
// Required/optional env vars: same as calendar-line-reminder.mjs

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
} = process.env;

const WEEKDAY_LABELS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

function dateLabel(d) {
    return `${d.getMonth() + 1}/${d.getDate()}（${WEEKDAY_LABELS[d.getDay()]}）`;
}

function getWeekBounds(timeZone) {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone }));
    const dow = now.getDay();
    const diffToMonday = dow === 0 ? -6 : 1 - dow;
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffToMonday, 0, 0, 0);
    const nextMonday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7, 0, 0, 0);
    const nextSunday = new Date(nextMonday.getFullYear(), nextMonday.getMonth(), nextMonday.getDate() + 6, 23, 59, 59);
    return { pastStart: monday, pastEnd: now, nextStart: nextMonday, nextEnd: nextSunday };
}

async function fetchAllEvents(start, end, warnings) {
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

    return [...googleEvents, ...calDavEvents];
}

function groupByDay(events) {
    const groups = new Map();
    for (const event of [...events].sort((a, b) => a.start - b.start)) {
        const key = event.start.toDateString();
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(event);
    }
    return groups;
}

function formatEventLine(event, timeZone) {
    const time = event.allDay
        ? '整天'
        : event.start.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone });
    const location = event.location ? ` @ ${event.location}` : '';
    const tag = event.source === 'google' ? '' : `[${event.source}] `;
    return `  🔸 ${time} ${tag}${event.title}${location}`;
}

function buildMessage({ pastEvents, pastStart, pastEnd, nextEvents, nextStart, nextEnd, conflicts, warnings }) {
    const pastRange = `${dateLabel(pastStart)} ~ ${dateLabel(pastEnd)}`;
    const nextRange = `${dateLabel(nextStart)} ~ ${dateLabel(nextEnd)}`;

    const pastSection = `📊 本週回顧（${pastRange}）\n共 ${pastEvents.length} 場行程`;

    let nextSection;
    if (nextEvents.length === 0) {
        nextSection = `📅 下週預告（${nextRange}）\n\n目前還沒有安排任何行程`;
    } else {
        const groups = groupByDay(nextEvents);
        const dayBlocks = [...groups.entries()].map(([, dayEvents]) => {
            const heading = dateLabel(dayEvents[0].start);
            const lines = dayEvents.map((e) => formatEventLine(e, TIMEZONE)).join('\n');
            return `${heading}\n${lines}`;
        });
        nextSection = `📅 下週預告（${nextRange}，共 ${nextEvents.length} 場）\n\n${dayBlocks.join('\n\n')}`;
    }

    const conflictSection = conflicts.length
        ? `\n\n⚡ 下週衝突提醒\n${conflicts.map((c) => formatConflictLine(c, TIMEZONE)).join('\n')}`
        : '';
    const warningLines = warnings.length ? `\n\n⚠️ ${warnings.join('\n⚠️ ')}` : '';

    return `${pastSection}\n\n${nextSection}${conflictSection}${warningLines}`;
}

async function main() {
    const { pastStart, pastEnd, nextStart, nextEnd } = getWeekBounds(TIMEZONE);
    const warnings = [];

    const pastEvents = await fetchAllEvents(pastStart, pastEnd, warnings);
    const nextEvents = await fetchAllEvents(nextStart, nextEnd, warnings);
    const conflicts = detectConflicts(nextEvents);

    const message = buildMessage({ pastEvents, pastStart, pastEnd, nextEvents, nextStart, nextEnd, conflicts, warnings });
    await pushToLine({ token: LINE_CHANNEL_ACCESS_TOKEN, to: LINE_USER_ID, message });
    console.log(
        `Sent weekly review (${pastEvents.length} past event(s), ${nextEvents.length} next-week event(s), ${conflicts.length} conflict(s)).`
    );
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
