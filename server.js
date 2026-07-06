const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 10000;

app.use(express.static(__dirname));

// Хранилище сообщений (до 5000)
const messageHistory = [];

wss.on('connection', (ws) => {
    console.log('Новое подключение');

    // Отправляем историю новому клиенту
    messageHistory.forEach((text) => {
        ws.send(JSON.stringify({ type: 'history', text }));
    });

    ws.on('message', (data) => {
        const text = data.toString();
        
        // Сохраняем в историю
        messageHistory.push(text);
        if (messageHistory.length > 5000) {
            messageHistory.shift();
        }

        // Рассылаем всем
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

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
