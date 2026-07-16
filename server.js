const path = require("path");
const express = require("express");
const http = require("http");
const bcrypt = require("bcrypt");
const { WebSocketServer } = require("ws");
const { db, initDB } = require("./database");
const admin = require("firebase-admin");
require("dotenv").config();

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 10000;

// Раздаём статику ТОЛЬКО из папки public.
app.use(express.static(path.join(__dirname, "public")));

const HISTORY_LIMIT = 50;

// ---- Firebase Admin (push-уведомления) ----
// FIREBASE_SERVICE_ACCOUNT — весь JSON-файл из Firebase (Service Accounts),
// вставленный в одну строку, целиком, как значение переменной окружения.
let firebaseReady = false;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
        });
        firebaseReady = true;
        console.log("Firebase Admin подключен — push-уведомления доступны.");
    } catch (err) {
        console.error("Не удалось инициализировать Firebase Admin:", err.message);
    }
} else {
    console.log(
        "⚠️  FIREBASE_SERVICE_ACCOUNT не задан — push-уведомления отправляться не будут " +
        "(обычный чат и WebSocket продолжат работать как обычно)."
    );
}

async function sendPushToLogin(login, { title, body }) {
    if (!firebaseReady) return;

    try {
        const result = await db.execute(
            `SELECT token FROM push_tokens WHERE login = ?`,
            [login]
        );

        const tokens = result.rows.map((r) => r.token);
        if (tokens.length === 0) return;

        await admin.messaging().sendEachForMulticast({
            tokens,
            notification: { title, body },
        });
    } catch (err) {
        console.error("Ошибка отправки push-уведомления:", err.message);
    }
}

// login -> Set(ws) — один пользователь может быть онлайн в нескольких вкладках
const connections = new Map();

function addConnection(login, ws) {
    if (!connections.has(login)) connections.set(login, new Set());
    connections.get(login).add(ws);
}

function removeConnection(login, ws) {
    const set = connections.get(login);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) connections.delete(login);
}

function sendToLogin(login, payload) {
    (connections.get(login) || new Set()).forEach((client) => {
        if (client.readyState === 1) client.send(payload);
    });
}

// Помечает сообщения от sender к reader прочитанными и, если что-то реально
// изменилось, сообщает отправителю через WS, что можно показать двойную галочку.
async function markPrivateMessagesRead(reader, sender) {
    try {
        const result = await db.execute(
            `UPDATE private_messages SET is_read = 1 WHERE sender_login = ? AND recipient_login = ? AND is_read = 0`,
            [sender, reader]
        );
        if ((result.rowsAffected || 0) > 0) {
            sendToLogin(sender, JSON.stringify({ type: "read_receipt", by: reader }));
        }
    } catch (err) {
        console.error("Ошибка обновления статуса прочтения:", err.message);
    }
}

// Реакции одного сообщения, сгруппированные по эмодзи: [{ emoji, logins: [...] }]
async function fetchReactionsForMessage(scope, messageId) {
    const result = await db.execute(
        `SELECT emoji, login FROM reactions WHERE scope = ? AND message_id = ?`,
        [scope, messageId]
    );
    const grouped = {};
    result.rows.forEach((r) => {
        if (!grouped[r.emoji]) grouped[r.emoji] = [];
        grouped[r.emoji].push(r.login);
    });
    return Object.entries(grouped).map(([emoji, logins]) => ({ emoji, logins }));
}

// То же самое, но для целой пачки сообщений разом (при загрузке истории) —
// один запрос вместо N, чтобы не бить по лимитам Turso почём зря.
async function fetchReactionsBulk(scope, messageIds) {
    if (messageIds.length === 0) return {};

    const placeholders = messageIds.map(() => "?").join(",");
    const result = await db.execute(
        `SELECT message_id, emoji, login FROM reactions WHERE scope = ? AND message_id IN (${placeholders})`,
        [scope, ...messageIds]
    );

    const byMessage = {};
    result.rows.forEach((r) => {
        if (!byMessage[r.message_id]) byMessage[r.message_id] = {};
        if (!byMessage[r.message_id][r.emoji]) byMessage[r.message_id][r.emoji] = [];
        byMessage[r.message_id][r.emoji].push(r.login);
    });

    const out = {};
    messageIds.forEach((id) => {
        out[id] = byMessage[id]
            ? Object.entries(byMessage[id]).map(([emoji, logins]) => ({ emoji, logins }))
            : [];
    });
    return out;
}

wss.on("connection", (ws) => {
    console.log("Новое подключение");
    ws.userLogin = null;

    ws.on("message", async (data) => {
        let payload;
        try {
            payload = JSON.parse(data.toString());
        } catch {
            return;
        }

        // Клиент представляется сразу после открытия соединения
        if (payload.type === "auth") {
            const login = (payload.login || "").toString();
            if (!login) return;

            ws.userLogin = login;
            addConnection(login, ws);

            try {
                const result = await db.execute(
                    `SELECT m.id, m.nickname, m.text, m.created_at, m.reply_to_id,
                            r.nickname as reply_nickname, r.text as reply_text
                     FROM messages m
                     LEFT JOIN messages r ON m.reply_to_id = r.id
                     ORDER BY m.id DESC LIMIT ?`,
                    [HISTORY_LIMIT]
                );

                const rows = result.rows.reverse();
                const reactionsMap = await fetchReactionsBulk("public", rows.map((r) => r.id));
                rows.forEach((r) => { r.reactions = reactionsMap[r.id] || []; });

                ws.send(JSON.stringify({ type: "history", messages: rows }));
            } catch (err) {
                console.error("Ошибка загрузки истории общего чата:", err.message);
            }
            return;
        }

        // Сообщение в общий чат — работает как раньше
        if (payload.type === "public_message") {
            const nickname = (payload.nickname || "").toString().slice(0, 50);
            const text = (payload.text || "").toString().trim().slice(0, 2000);
            if (!nickname || !text) return;

            // Если сообщение — ответ на другое, подтягиваем его текст/автора для превью.
            // Если reply_to_id битый или ссылается на несуществующее сообщение — просто игнорируем.
            let replyToId = null;
            let replyNickname = null;
            let replyText = null;

            if (payload.reply_to_id) {
                const parsedId = parseInt(payload.reply_to_id, 10);
                if (parsedId) {
                    try {
                        const replyResult = await db.execute(
                            `SELECT nickname, text FROM messages WHERE id = ?`,
                            [parsedId]
                        );
                        if (replyResult.rows.length > 0) {
                            replyToId = parsedId;
                            replyNickname = replyResult.rows[0].nickname;
                            replyText = replyResult.rows[0].text;
                        }
                    } catch (err) {
                        console.error("Ошибка поиска сообщения для ответа:", err.message);
                    }
                }
            }

            // Фиксируем время отправки на сервере — так все клиенты видят
            // одно и то же время, независимо от часового пояса отправителя.
            const createdAt = new Date().toISOString();
            let messageId = null;

            try {
                const insertResult = await db.execute(
                    `INSERT INTO messages (nickname, text, created_at, reply_to_id) VALUES (?, ?, ?, ?) RETURNING id`,
                    [nickname, text, createdAt, replyToId]
                );
                messageId = insertResult.rows?.[0]?.id ?? null;
            } catch (err) {
                console.error("Ошибка сохранения сообщения:", err.message);
                return;
            }

            const outgoing = JSON.stringify({
                type: "public_message",
                id: messageId,
                nickname,
                text,
                created_at: createdAt,
                reply_to_id: replyToId,
                reply_nickname: replyNickname,
                reply_text: replyText,
                reactions: [],
            });
            wss.clients.forEach((client) => {
                if (client.readyState === 1) client.send(outgoing);
            });
            return;
        }

        // Личное сообщение — только отправителю и получателю
        if (payload.type === "private_message") {
            if (!ws.userLogin) return;

            const to = (payload.to || "").toString();
            const text = (payload.text || "").toString().trim().slice(0, 2000);
            if (!to || !text) return;

            // Проверяем, что сообщение, на которое отвечают, реально принадлежит
            // именно этой переписке (а не подсунуто с другим id из другого чата).
            let replyToId = null;
            let replySenderLogin = null;
            let replyText = null;

            if (payload.reply_to_id) {
                const parsedId = parseInt(payload.reply_to_id, 10);
                if (parsedId) {
                    try {
                        const replyResult = await db.execute(
                            `SELECT sender_login, recipient_login, text FROM private_messages WHERE id = ?`,
                            [parsedId]
                        );
                        const row = replyResult.rows[0];
                        const belongsToThisConversation = row && (
                            (row.sender_login === ws.userLogin && row.recipient_login === to) ||
                            (row.sender_login === to && row.recipient_login === ws.userLogin)
                        );
                        if (belongsToThisConversation) {
                            replyToId = parsedId;
                            replySenderLogin = row.sender_login;
                            replyText = row.text;
                        }
                    } catch (err) {
                        console.error("Ошибка поиска сообщения для ответа:", err.message);
                    }
                }
            }

            const createdAt = new Date().toISOString();
            let messageId = null;

            try {
                const insertResult = await db.execute(
                    `INSERT INTO private_messages (sender_login, recipient_login, text, created_at, reply_to_id) VALUES (?, ?, ?, ?, ?) RETURNING id`,
                    [ws.userLogin, to, text, createdAt, replyToId]
                );
                messageId = insertResult.rows?.[0]?.id ?? null;
            } catch (err) {
                console.error("Ошибка сохранения личного сообщения:", err.message);
                return;
            }

            const outgoing = JSON.stringify({
                type: "private_message",
                id: messageId,
                from: ws.userLogin,
                to,
                text,
                created_at: createdAt,
                is_read: false,
                reply_to_id: replyToId,
                reply_sender_login: replySenderLogin,
                reply_text: replyText,
                reactions: [],
            });

            sendToLogin(to, outgoing);
            sendToLogin(ws.userLogin, outgoing); // эхо себе (в т.ч. на другие вкладки)

            // Если получатель не в сети прямо сейчас (нет активного WebSocket-соединения) —
            // шлём push-уведомление на его устройство, если оно зарегистрировано.
            const recipientOnline = connections.has(to) && connections.get(to).size > 0;
            if (!recipientOnline) {
                try {
                    const senderResult = await db.execute(
                        `SELECT nickname FROM users WHERE login = ?`,
                        [ws.userLogin]
                    );
                    const senderNickname = senderResult.rows[0]?.nickname || ws.userLogin;
                    await sendPushToLogin(to, { title: senderNickname, body: text });
                } catch (err) {
                    console.error("Не удалось отправить push:", err.message);
                }
            }

            return;
        }

        // Собеседник открыл переписку (или увидел новое сообщение) — помечаем прочитанным
        if (payload.type === "mark_read") {
            if (!ws.userLogin) return;

            const otherLogin = (payload.with || "").toString();
            if (!otherLogin) return;

            await markPrivateMessagesRead(ws.userLogin, otherLogin);
            return;
        }

        // Реакция-эмодзи на сообщение (общий чат или личное).
        // Один пользователь — одна реакция на сообщение: повторный клик тем же
        // эмодзи снимает реакцию, клик другим эмодзи — заменяет её.
        if (payload.type === "toggle_reaction") {
            if (!ws.userLogin) return;

            const scope = payload.scope === "private" ? "private" : "public";
            const messageId = parseInt(payload.message_id, 10);
            const emoji = (payload.emoji || "").toString().slice(0, 8);
            if (!messageId || !emoji) return;

            // Для личных сообщений — убеждаемся, что реагирующий реально
            // участник этой переписки, а не подставил чужой message_id.
            let recipients = null; // null => отправляем всем (общий чат)
            if (scope === "private") {
                try {
                    const msgResult = await db.execute(
                        `SELECT sender_login, recipient_login FROM private_messages WHERE id = ?`,
                        [messageId]
                    );
                    const row = msgResult.rows[0];
                    if (!row) return;
                    if (row.sender_login !== ws.userLogin && row.recipient_login !== ws.userLogin) return;
                    recipients = [row.sender_login, row.recipient_login];
                } catch (err) {
                    console.error("Ошибка проверки сообщения для реакции:", err.message);
                    return;
                }
            }

            try {
                const existing = await db.execute(
                    `SELECT emoji FROM reactions WHERE scope = ? AND message_id = ? AND login = ?`,
                    [scope, messageId, ws.userLogin]
                );

                if (existing.rows.length > 0 && existing.rows[0].emoji === emoji) {
                    await db.execute(
                        `DELETE FROM reactions WHERE scope = ? AND message_id = ? AND login = ?`,
                        [scope, messageId, ws.userLogin]
                    );
                } else {
                    await db.execute(
                        `INSERT INTO reactions (scope, message_id, login, emoji) VALUES (?, ?, ?, ?)
                         ON CONFLICT(scope, message_id, login) DO UPDATE SET emoji = excluded.emoji`,
                        [scope, messageId, ws.userLogin, emoji]
                    );
                }

                const reactions = await fetchReactionsForMessage(scope, messageId);
                const outgoing = JSON.stringify({
                    type: "reaction_update",
                    scope,
                    message_id: messageId,
                    reactions,
                });

                if (scope === "public") {
                    wss.clients.forEach((client) => {
                        if (client.readyState === 1) client.send(outgoing);
                    });
                } else {
                    recipients.forEach((login) => sendToLogin(login, outgoing));
                }
            } catch (err) {
                console.error("Ошибка обновления реакции:", err.message);
            }
            return;
        }
    });

    ws.on("close", () => {
        console.log("Клиент отключился");
        if (ws.userLogin) removeConnection(ws.userLogin, ws);
    });
});

app.post("/register", async (req, res) => {
    const { login, password, nickname } = req.body;

    if (!login || !password || !nickname) {
        return res.json({ success: false, message: "Заполните все поля!" });
    }

    try {
        const existing = await db.execute(
            `SELECT id FROM users WHERE login = ?`,
            [login]
        );

        if (existing.rows.length > 0) {
            return res.json({ success: false, message: "Такой логин уже существует." });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        await db.execute(
            `INSERT INTO users (login, password, nickname) VALUES (?, ?, ?)`,
            [login, hashedPassword, nickname]
        );

        res.json({ success: true, message: "Аккаунт успешно создан!" });
    } catch (err) {
        console.error(err.message);
        res.json({ success: false, message: "Ошибка базы данных." });
    }
});

app.post("/login", async (req, res) => {
    const { login, password } = req.body;

    if (!login || !password) {
        return res.json({ success: false, message: "Заполните все поля!" });
    }

    try {
        const result = await db.execute(
            `SELECT * FROM users WHERE login = ?`,
            [login]
        );

        const user = result.rows[0];

        if (!user) {
            return res.json({ success: false, message: "Неверный логин или пароль." });
        }

        const passwordMatches = await bcrypt.compare(password, user.password);

        if (!passwordMatches) {
            return res.json({ success: false, message: "Неверный логин или пароль." });
        }

        res.json({
            success: true,
            message: "Вход выполнен!",
            user: {
                login: user.login,
                nickname: user.nickname,
            },
        });
    } catch (err) {
        console.error(err.message);
        res.json({ success: false, message: "Ошибка базы данных." });
    }
});

// Проверить, существует ли пользователь с таким логином (для добавления в контакты)
// Приложение (APK) присылает сюда токен устройства после регистрации в Firebase
app.post("/register-push-token", async (req, res) => {
    const { login, token } = req.body;

    if (!login || !token) {
        return res.json({ success: false, message: "Не хватает данных." });
    }

    try {
        // Один и тот же токен может теоретически переприкрепиться к другому логину
        // (переустановка приложения на другой аккаунт) — поэтому делаем "upsert"
        await db.execute(
            `INSERT INTO push_tokens (login, token) VALUES (?, ?)
             ON CONFLICT(token) DO UPDATE SET login = excluded.login`,
            [login, token]
        );

        res.json({ success: true });
    } catch (err) {
        console.error(err.message);
        res.json({ success: false, message: "Ошибка базы данных." });
    }
});

app.get("/users/:login", async (req, res) => {
    const { login } = req.params;

    try {
        const result = await db.execute(
            `SELECT login, nickname FROM users WHERE login = ?`,
            [login]
        );

        if (result.rows.length === 0) {
            return res.json({ success: false, message: "Пользователь не найден." });
        }

        res.json({ success: true, user: result.rows[0] });
    } catch (err) {
        console.error(err.message);
        res.json({ success: false, message: "Ошибка базы данных." });
    }
});

// Список собеседников, с кем уже есть переписка
app.get("/conversations", async (req, res) => {
    const me = (req.query.login || "").toString();
    if (!me) return res.json({ success: false, message: "Не указан логин." });

    try {
        const result = await db.execute(
            `SELECT DISTINCT
                CASE WHEN sender_login = ? THEN recipient_login ELSE sender_login END as other_login
             FROM private_messages
             WHERE sender_login = ? OR recipient_login = ?`,
            [me, me, me]
        );

        const logins = result.rows.map((r) => r.other_login);
        if (logins.length === 0) return res.json({ success: true, conversations: [] });

        const placeholders = logins.map(() => "?").join(",");
        const usersResult = await db.execute(
            `SELECT login, nickname FROM users WHERE login IN (${placeholders})`,
            logins
        );

        res.json({ success: true, conversations: usersResult.rows });
    } catch (err) {
        console.error(err.message);
        res.json({ success: false, message: "Ошибка базы данных." });
    }
});

// История переписки с конкретным собеседником
app.get("/messages/private", async (req, res) => {
    const me = (req.query.me || "").toString();
    const withUser = (req.query.with || "").toString();

    if (!me || !withUser) {
        return res.json({ success: false, message: "Не указаны параметры." });
    }

    try {
        const result = await db.execute(
            `SELECT m.id, m.sender_login, m.recipient_login, m.text, m.created_at, m.is_read, m.reply_to_id,
                    r.sender_login as reply_sender_login, r.text as reply_text
             FROM private_messages m
             LEFT JOIN private_messages r ON m.reply_to_id = r.id
             WHERE (m.sender_login = ? AND m.recipient_login = ?)
                OR (m.sender_login = ? AND m.recipient_login = ?)
             ORDER BY m.id DESC
             LIMIT ?`,
            [me, withUser, withUser, me, HISTORY_LIMIT]
        );

        const rows = result.rows.reverse();
        const reactionsMap = await fetchReactionsBulk("private", rows.map((r) => r.id));
        rows.forEach((r) => { r.reactions = reactionsMap[r.id] || []; });

        res.json({ success: true, messages: rows });
    } catch (err) {
        console.error(err.message);
        res.json({ success: false, message: "Ошибка базы данных." });
    }
});

initDB().then(() => {
    server.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
}).catch((err) => {
    console.error("Не удалось инициализировать базу данных.");
    console.error("Сообщение:", err.message);
    if (err.cause) console.error("Причина:", err.cause);
    console.error(
        "Проверь: TURSO_DATABASE_URL начинается на libsql://, " +
        "TURSO_AUTH_TOKEN скопирован полностью без пробелов и переносов строк."
    );
    process.exit(1);
});
