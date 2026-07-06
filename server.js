const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 10000;

app.use(express.static(__dirname));

wss.on('connection', (ws) => {
    console.log('Новое подключение');

    ws.on('message', (data) => {
        const text = data.toString();
        wss.clients.forEach((client) => {
            if (client !== ws && client.readyState === 1) {
                client.send(text);
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
