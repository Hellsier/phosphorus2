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
// server.js, database.js, .env, package.json снаружи больше не видны.
app.use(express.static(path.join(__dirname, "public")));

const HISTORY_LIMIT = 50;

wss.on("connection", async (ws) => {
    console.log("Новое подключение");

    try {
        const result = await db.execute(
            `SELECT nickname, text, created_at FROM messages ORDER BY id DESC LIMIT ?`,
            [HISTORY_LIMIT]
        );
        const history = result.rows.reverse();
        ws.send(JSON.stringify({ type: "history", messages: history }));
    } catch (err) {
        console.error("Ошибка загрузки истории:", err.message);
    }

    ws.on("message", async (data) => {
        let payload;
        try {
            payload = JSON.parse(data.toString());
        } catch {
            return;
        }

        const nickname = (payload.nickname || "").toString().slice(0, 50);
        const text = (payload.text || "").toString().trim().slice(0, 2000);

        if (!nickname || !text) return;

        try {
            await db.execute(
                `INSERT INTO messages (nickname, text) VALUES (?, ?)`,
                [nickname, text]
            );
        } catch (err) {
            console.error("Ошибка сохранения сообщения:", err.message);
            return;
        }

        const outgoing = JSON.stringify({ type: "message", nickname, text });

        wss.clients.forEach((client) => {
            if (client.readyState === 1) {
                client.send(outgoing);
            }
        });
    });

    ws.on("close", () => {
        console.log("Клиент отключился");
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
                nickname: user.nickname
            }
        });
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
    console.error("Не удалось инициализировать базу данных:", err.message);
    process.exit(1);
});
