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
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            is_read INTEGER NOT NULL DEFAULT 0
        )
    `);

    // Миграция для баз, созданных до появления статуса прочтения:
    // если столбца ещё нет — добавляем, если уже есть — просто игнорируем ошибку.
    try {
        await db.execute(`ALTER TABLE private_messages ADD COLUMN is_read INTEGER NOT NULL DEFAULT 0`);
    } catch (err) {
        // столбец уже существует — это нормально
    }

    // Миграция для ответов на конкретное сообщение (как реплай в Telegram)
    try {
        await db.execute(`ALTER TABLE messages ADD COLUMN reply_to_id INTEGER`);
    } catch (err) {
        // столбец уже существует — это нормально
    }
    try {
        await db.execute(`ALTER TABLE private_messages ADD COLUMN reply_to_id INTEGER`);
    } catch (err) {
        // столбец уже существует — это нормально
    }

    // Токены устройств для push-уведомлений (мобильное приложение)
    await db.execute(`
        CREATE TABLE IF NOT EXISTS push_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            login TEXT NOT NULL,
            token TEXT UNIQUE NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Реакции (эмодзи) на сообщения. scope различает общий чат и личные —
    // id сообщений в этих двух таблицах независимые, поэтому scope обязателен.
    // Один пользователь — одна реакция на сообщение (как в Telegram):
    // повторный клик тем же эмодзи снимает реакцию, другим — заменяет её.
    await db.execute(`
        CREATE TABLE IF NOT EXISTS reactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scope TEXT NOT NULL,
            message_id INTEGER NOT NULL,
            login TEXT NOT NULL,
            emoji TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(scope, message_id, login)
        )
    `);

    console.log(hasTurso ? "База данных Turso подключена и готова." : "Локальная тестовая база готова.");
}

module.exports = { db, initDB };
