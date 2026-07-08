const path = require("path");
const express = require("express");
const http = require("http");
const bcrypt = require("bcrypt");
const { WebSocketServer } = require("ws");
const { db, initDB } = require("./database");
require("dotenv").config();

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 10000;

// Раздаём статику ТОЛЬКО из папки public.
app.use(express.static(path.join(__dirname, "public")));

const HISTORY_LIMIT = 50;

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
                    `SELECT nickname, text, created_at FROM messages ORDER BY id DESC LIMIT ?`,
                    [HISTORY_LIMIT]
                );
                ws.send(JSON.stringify({ type: "history", messages: result.rows.reverse() }));
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

            // Фиксируем время отправки на сервере — так все клиенты видят
            // одно и то же время, независимо от часового пояса отправителя.
            const createdAt = new Date().toISOString();

            try {
                await db.execute(
                    `INSERT INTO messages (nickname, text, created_at) VALUES (?, ?, ?)`,
                    [nickname, text, createdAt]
                );
            } catch (err) {
                console.error("Ошибка сохранения сообщения:", err.message);
                return;
            }

            const outgoing = JSON.stringify({ type: "public_message", nickname, text, created_at: createdAt });
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

            const createdAt = new Date().toISOString();
            let messageId = null;

            try {
                const insertResult = await db.execute(
                    `INSERT INTO private_messages (sender_login, recipient_login, text, created_at) VALUES (?, ?, ?, ?) RETURNING id`,
                    [ws.userLogin, to, text, createdAt]
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
            });

            sendToLogin(to, outgoing);
            sendToLogin(ws.userLogin, outgoing); // эхо себе (в т.ч. на другие вкладки)
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
            `SELECT id, sender_login, recipient_login, text, created_at, is_read
             FROM private_messages
             WHERE (sender_login = ? AND recipient_login = ?)
                OR (sender_login = ? AND recipient_login = ?)
             ORDER BY id DESC
             LIMIT ?`,
            [me, withUser, withUser, me, HISTORY_LIMIT]
        );

        res.json({ success: true, messages: result.rows.reverse() });
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
