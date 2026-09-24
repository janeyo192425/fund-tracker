// Google Cloud Function (2nd gen, HTTP trigger) that receives LINE Messaging
// API webhook events. When the user sends a text message describing a
// calendar event, it asks Gemini to parse it into structured fields and
// creates the event on Google Calendar, then replies to the user on LINE.
//
// Required env vars:
//   LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
//     (refresh token must have been issued with a write scope, e.g.
//      https://www.googleapis.com/auth/calendar.events)
//   GEMINI_API_KEY
// Optional: GOOGLE_CALENDAR_ID (default "primary"), TIMEZONE (default "Asia/Taipei")

const crypto = require('crypto');

const {
    LINE_CHANNEL_SECRET,
    LINE_CHANNEL_ACCESS_TOKEN,
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REFRESH_TOKEN,
    GOOGLE_CALENDAR_ID,
    GEMINI_API_KEY,
    TIMEZONE = 'Asia/Taipei',
} = process.env;

function verifySignature(rawBody, signature) {
    if (!signature || !rawBody) return false;
    const expected = crypto.createHmac('sha256', LINE_CHANNEL_SECRET).update(rawBody).digest('base64');
    const expectedBuf = Buffer.from(expected);
    const givenBuf = Buffer.from(signature);
    if (expectedBuf.length !== givenBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, givenBuf);
}

function todayInfo() {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: TIMEZONE }));
    const weekdayNames = ['日', '一', '二', '三', '四', '五', '六'];
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    return { dateStr, weekday: weekdayNames[now.getDay()] };
}

async function parseEventFromText(text) {
    const { dateStr, weekday } = todayInfo();
    const prompt = `你是行事曆助理。今天是 ${dateStr}（星期${weekday}），時區 ${TIMEZONE}。請把使用者訊息解析成一個行事曆事件。使用者訊息：「${text}」

規則：
- date 用 YYYY-MM-DD 格式，正確處理「明天」「後天」「下週三」「這個週五」等相對日期用語
- startTime / endTime 用 24 小時制 HH:mm
- 如果使用者沒說結束時間，endTime 留空（呼叫端會預設抓開始時間加 1 小時）
- 如果訊息完全不像是要新增行程（例如只是打招呼、問問題、跟行程無關的閒聊），把 valid 設為 false，其他欄位可留空`;

    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generationConfig: {
                    responseMimeType: 'application/json',
                    responseSchema: {
                        type: 'OBJECT',
                        properties: {
                            valid: { type: 'BOOLEAN' },
                            title: { type: 'STRING' },
                            date: { type: 'STRING' },
                            startTime: { type: 'STRING' },
                            endTime: { type: 'STRING' },
                            location: { type: 'STRING' },
                        },
                    },
                },
            }),
        }
    );

    if (!response.ok) throw new Error(`Gemini API error: ${response.status} ${await response.text()}`);
    const data = await response.json();
    const jsonText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!jsonText) throw new Error('Gemini returned no content');
    return JSON.parse(jsonText);
}

async function getAccessToken() {
    const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            refresh_token: GOOGLE_REFRESH_TOKEN,
            grant_type: 'refresh_token',
        }),
    });
    if (!response.ok) throw new Error(`Token refresh failed: ${response.status} ${await response.text()}`);
    const data = await response.json();
    return data.access_token;
}

async function createCalendarEvent(parsed) {
    const accessToken = await getAccessToken();
    const calendarId = encodeURIComponent(GOOGLE_CALENDAR_ID || 'primary');

    const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
            summary: parsed.title,
            location: parsed.location || undefined,
            start: { dateTime: `${parsed.date}T${parsed.startTime}:00`, timeZone: TIMEZONE },
            end: { dateTime: `${parsed.date}T${parsed.endTime}:00`, timeZone: TIMEZONE },
        }),
    });

    if (!response.ok) throw new Error(`Calendar insert failed: ${response.status} ${await response.text()}`);
    return response.json();
}

async function replyToLine(replyToken, text) {
    await fetch('https://api.line.me/v2/bot/message/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
        body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
    });
}

async function handleTextMessage(event) {
    const text = event.message.text.trim();
    try {
        const parsed = await parseEventFromText(text);

        if (!parsed?.valid || !parsed.title || !parsed.date || !parsed.startTime) {
            await replyToLine(event.replyToken, '不太確定這是要新增行程 🤔 可以講清楚一點日期跟時間嗎？例如：「明天下午3點跟客戶開會」');
            return;
        }

        if (!parsed.endTime) {
            const [h, m] = parsed.startTime.split(':').map(Number);
            const endH = (h + 1) % 24;
            parsed.endTime = `${String(endH).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        }

        await createCalendarEvent(parsed);
        await replyToLine(
            event.replyToken,
            `✅ 已經幫你加進日曆：\n${parsed.date} ${parsed.startTime}-${parsed.endTime}\n${parsed.title}${parsed.location ? ` @ ${parsed.location}` : ''}`
        );
    } catch (err) {
        console.error('Failed to handle message:', err);
        await replyToLine(event.replyToken, '新增行程時發生錯誤，麻煩稍後再試一次，或先用 Google 日曆手動加。');
    }
}

exports.lineWebhook = async (req, res) => {
    if (req.method !== 'POST') {
        res.status(405).send('Method Not Allowed');
        return;
    }

    const signature = req.get('x-line-signature');
    if (!verifySignature(req.rawBody, signature)) {
        res.status(401).send('Invalid signature');
        return;
    }

    const events = req.body?.events || [];
    await Promise.all(
        events
            .filter((event) => event.type === 'message' && event.message?.type === 'text')
            .map((event) => handleTextMessage(event))
    );

    res.status(200).send('OK');
};
