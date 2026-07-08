const { createClient } = require("@libsql/client");
require("dotenv").config();

const hasTurso = process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN;

// Если переменные Turso не заданы — работаем с локальным файлом local.db.
// Это тот же движок (libSQL), поэтому весь остальной код не меняется.
const db = hasTurso
    ? createClient({
          url: process.env.TURSO_DATABASE_URL,
          authToken: process.env.TURSO_AUTH_TOKEN,
      })
    : createClient({ url: "file:local.db" });

if (!hasTurso) {
    console.log(
        "⚠️  TURSO_DATABASE_URL/TURSO_AUTH_TOKEN не заданы — " +
        "работаю в тестовом режиме с локальным файлом local.db (данные никуда не уходят в сеть)."
    );
}

async function initDB() {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            login TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            nickname TEXT NOT NULL
        )
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nickname TEXT NOT NULL,
            text TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Личные сообщения: маршрутизация по логину (он уникален),
    // никнейм для отображения подтягивается отдельно из users.
    await db.execute(`
        CREATE TABLE IF NOT EXISTS private_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender_login TEXT NOT NULL,
            recipient_login TEXT NOT NULL,
            text TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    console.log(hasTurso ? "База данных Turso подключена и готова." : "Локальная тестовая база готова.");
}

module.exports = { db, initDB };
