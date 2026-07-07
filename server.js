const db = require("./database");
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');

const app = express();
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 10000;

app.use(express.static(__dirname));

const messageHistory = [];

wss.on('connection', (ws) => {
    console.log('Новое подключение');

    messageHistory.forEach((text) => {
    });

    ws.on('message', (data) => {
        const text = data.toString();
        
        messageHistory.push(text);
        if (messageHistory.length > 5000) {
            messageHistory.shift();
        }

        wss.clients.forEach((client) => {
            if (client !== ws && client.readyState === 1) {
                client.send(JSON.stringify({ type: 'message', text }));
            }
        });
    });

    ws.on('close', () => {
        console.log('Клиент отключился');
    });
});

app.post("/register", (req, res) => {

    const { login, password, nickname } = req.body;

    if (!login || !password || !nickname) {
        return res.json({
            success: false,
            message: "Заполните все поля!"
        });
    }

    db.get(
        "SELECT * FROM users WHERE login = ?",
        [login],
        (err, row) => {

            if (err) {
                return res.json({
                    success: false,
                    message: "Ошибка базы данных."
                });
            }

            if (row) {
                return res.json({
                    success: false,
                    message: "Такой логин уже существует."
                });
            }

            db.run(
                "INSERT INTO users (login, password, nickname) VALUES (?, ?, ?)",
                [login, password, nickname],
                function(err) {

                    if (err) {
                        return res.json({
                            success: false,
                            message: "Не удалось создать аккаунт."
                        });
                    }

                    res.json({
                        success: true,
                        message: "Аккаунт успешно создан!"
                    });

                }
            );

        }
    );

});

app.post("/login", (req, res) => {
 
    const { login, password } = req.body;
 
    if (!login || !password) {
        return res.json({
            success: false,
            message: "Заполните все поля!"
        });
    }
 
    db.get(
        "SELECT * FROM users WHERE login = ?",
        [login],
        (err, row) => {
 
            if (err) {
                return res.json({
                    success: false,
                    message: "Ошибка базы данных."
                });
            }
 
            if (!row || row.password !== password) {
                return res.json({
                    success: false,
                    message: "Неверный логин или пароль."
                });
            }
 
            res.json({
                success: true,
                message: "Вход выполнен!",
                user: {
                    login: row.login,
                    nickname: row.nickname
                }
            });
 
        }
    );
 
});
 
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});