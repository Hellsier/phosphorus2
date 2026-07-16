const authScreen = document.getElementById("authScreen");
const chatContainer = document.getElementById("chatContainer");
const authTitle = document.getElementById("authTitle");
const loginInput = document.getElementById("loginInput");
const nicknameInput = document.getElementById("nicknameInput");
const passwordInput = document.getElementById("passwordInput");
const authButton = document.getElementById("authButton");
const switchMode = document.getElementById("switchMode");
const authMessage = document.getElementById("authMessage");

const input = document.getElementById("messageInput");
const button = document.getElementById("sendButton");
const messages = document.getElementById("messages");
const chatHeader = document.getElementById("chatHeaderText");
const backToContacts = document.getElementById("backToContacts");
const MOBILE_BREAKPOINT = 700;
const contactsList = document.getElementById("contactsList");
const publicChatItem = document.getElementById("publicChatItem");
const newContactLogin = document.getElementById("newContactLogin");
const addContactBtn = document.getElementById("addContactBtn");
const addContactMessage = document.getElementById("addContactMessage");
const replyBar = document.getElementById("replyBar");
const replyBarAuthor = document.getElementById("replyBarAuthor");
const replyBarText = document.getElementById("replyBarText");
const cancelReplyBtn = document.getElementById("cancelReplyBtn");

const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🔥"];
let replyingTo = null; // { id, scope, authorLabel, text } или null

let mode = "register";
let ws = null;
let currentUser = null;

// login -> nickname, чтобы уведомления могли показать имя человека, а не логин
const knownNicknames = {};

// Текущий открытый чат: { type: 'public' } или { type: 'private', login, nickname }
let currentChat = { type: "public" };

chatContainer.style.display = "none";

function updateAuthUI() {
    authMessage.textContent = "";

    if (mode === "register") {
        authTitle.textContent = "Привет! Рады вас видеть!";
        authButton.textContent = "Зарегистрироваться";
        switchMode.textContent = "Уже есть аккаунт? Войти";
        nicknameInput.style.display = "block";
    } else {
        authTitle.textContent = "С возвращением!";
        authButton.textContent = "Войти";
        switchMode.textContent = "Нет аккаунта? Зарегистрироваться";
        nicknameInput.style.display = "none";
    }
}

switchMode.addEventListener("click", () => {
    mode = mode === "register" ? "login" : "register";
    updateAuthUI();
});

updateAuthUI();

authButton.addEventListener("click", handleAuth);

[loginInput, nicknameInput, passwordInput].forEach((el) => {
    el.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            handleAuth();
        }
    });
});

async function handleAuth() {
    const login = loginInput.value.trim();
    const password = passwordInput.value.trim();
    const nickname = nicknameInput.value.trim();

    if (!login || !password || (mode === "register" && !nickname)) {
        authMessage.style.color = "#ff8c8c";
        authMessage.textContent = "Заполните все поля!";
        return;
    }

    authButton.disabled = true;
    authMessage.style.color = "#b9bbbe";
    authMessage.textContent = "Подождите...";

    try {
        const endpoint = mode === "register" ? "/register" : "/login";
        const body = mode === "register"
            ? { login, password, nickname }
            : { login, password };

        const response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });

        const data = await response.json();

        if (!data.success) {
            authMessage.style.color = "#ff8c8c";
            authMessage.textContent = data.message || "Ошибка.";
            return;
        }

        if (mode === "register") {
            authMessage.style.color = "#8cff9c";
            authMessage.textContent = "Аккаунт создан! Теперь войдите.";
            mode = "login";
            updateAuthUI();
            passwordInput.value = "";
        } else {
            const user = data.user;
            localStorage.setItem("chatUser", JSON.stringify(user));
            enterChat(user);
        }

    } catch (err) {
        authMessage.style.color = "#ff8c8c";
        authMessage.textContent = "Не удалось связаться с сервером.";
    } finally {
        authButton.disabled = false;
    }
}

function enterChat(user) {
    currentUser = user;
    authScreen.style.display = "none";
    chatContainer.style.display = "flex";
    connectWebSocket();
    loadConversations();
    requestNotificationPermission();
    initPushNotifications();
}

// ---- Push-уведомления внутри APK-приложения (Capacitor) ----
// В обычном браузере window.Capacitor не существует — вся функция
// просто ничего не делает, ошибок не будет.
function initPushNotifications() {
    if (!window.Capacitor || !window.Capacitor.isNativePlatform || !window.Capacitor.isNativePlatform()) {
        return;
    }

    const { PushNotifications } = window.Capacitor.Plugins;
    if (!PushNotifications) return;

    PushNotifications.requestPermissions()
        .then((result) => {
            if (result.receive === "granted") {
                PushNotifications.register();
            }
        })
        .catch((err) => console.error("Ошибка запроса разрешения на push:", err));

    PushNotifications.addListener("registration", (token) => {
        fetch("/register-push-token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ login: currentUser.login, token: token.value })
        }).catch((err) => console.error("Не удалось отправить push-токен на сервер:", err.message));
    });

    PushNotifications.addListener("registrationError", (err) => {
        console.error("Ошибка регистрации push:", err);
    });
}

// ---- Звуковые и браузерные уведомления о новых личных сообщениях ----

// Файл со своим звуком уведомления. Положи его в public/notification.mp3 —
// если файла нет или он не проигрался, автоматически используется запасной
// процедурный звук (два коротких тона), чтобы уведомления не пропадали совсем.
const NOTIFICATION_SOUND_URL = "notification.mp3";
let notificationAudio = null;

function playNotificationSound() {
    try {
        if (!notificationAudio) {
            notificationAudio = new Audio(NOTIFICATION_SOUND_URL);
            notificationAudio.volume = 0.6;
        }

        // currentTime = 0 нужен, чтобы звук проигрывался заново,
        // даже если предыдущее уведомление ещё не отзвучало
        notificationAudio.currentTime = 0;
        notificationAudio.play().catch(() => {
            // Файла нет, браузер заблокировал автоплей, формат не поддержан и т.д.
            // — подстраховываемся процедурным звуком, чтобы не остаться совсем без сигнала
            playFallbackTone();
        });
    } catch (err) {
        playFallbackTone();
    }
}

let audioCtx = null;

function playFallbackTone() {
    try {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioCtx.state === "suspended") {
            audioCtx.resume();
        }

        const now = audioCtx.currentTime;
        const gain = audioCtx.createGain();
        gain.connect(audioCtx.destination);
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.18, now + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);

        // Два коротких тона — привычный "дзинь" мессенджера, без внешних аудиофайлов
        const osc1 = audioCtx.createOscillator();
        osc1.type = "sine";
        osc1.frequency.setValueAtTime(880, now);
        osc1.connect(gain);
        osc1.start(now);
        osc1.stop(now + 0.15);

        const osc2 = audioCtx.createOscillator();
        osc2.type = "sine";
        osc2.frequency.setValueAtTime(1175, now + 0.12);
        osc2.connect(gain);
        osc2.start(now + 0.12);
        osc2.stop(now + 0.4);
    } catch (err) {
        console.error("Не удалось воспроизвести звук уведомления:", err.message);
    }
}

function requestNotificationPermission() {
    if ("Notification" in window && Notification.permission === "default") {
        Notification.requestPermission();
    }
}

function showDesktopNotification(title, body) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    // Не показываем всплывающее уведомление, если вкладка и так открыта и активна
    if (document.visibilityState === "visible" && document.hasFocus()) return;

    try {
        const notif = new Notification(title, { body });
        notif.onclick = () => {
            window.focus();
            notif.close();
        };
    } catch (err) {
        console.error("Не удалось показать уведомление:", err.message);
    }
}

function markContactUnread(login) {
    const el = document.querySelector(`.contactItem[data-login="${login}"]`);
    if (el) el.classList.add("unread");
}

function clearContactUnread(login) {
    const el = document.querySelector(`.contactItem[data-login="${login}"]`);
    if (el) el.classList.remove("unread");
}

function connectWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${protocol}://${location.host}`);
    let connected = false;

    ws.onopen = () => {
        connected = true;
        ws.send(JSON.stringify({ type: "auth", login: currentUser.login }));
        addSystemMessage(`✅ Подключено как ${currentUser.nickname}`);
    };

    ws.onclose = () => {
        connected = false;
        addSystemMessage("❌ Соединение потеряно");
    };

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.type === "history" && currentChat.type === "public") {
            messages.innerHTML = "";
            data.messages.forEach((msg) => {
                addMessage(msg.nickname, msg.text, msg.nickname === currentUser.nickname, msg.created_at, {
                    messageId: msg.id,
                    scope: "public",
                    reply: msg.reply_to_id
                        ? { authorLabel: msg.reply_nickname, text: msg.reply_text }
                        : null,
                    reactions: msg.reactions || [],
                });
            });
        }

        if (data.type === "public_message" && currentChat.type === "public") {
            addMessage(data.nickname, data.text, data.nickname === currentUser.nickname, data.created_at, {
                messageId: data.id,
                scope: "public",
                reply: data.reply_to_id
                    ? { authorLabel: data.reply_nickname, text: data.reply_text }
                    : null,
                reactions: data.reactions || [],
            });
        }

        if (data.type === "private_message") {
            const otherLogin = data.from === currentUser.login ? data.to : data.from;
            const isIncoming = data.from !== currentUser.login;
            const viewingThisChat = currentChat.type === "private" && currentChat.login === otherLogin;

            // Если это переписка, которую сейчас видим на экране — дорисовываем сразу
            if (viewingThisChat) {
                let replyAuthorLabel = null;
                if (data.reply_to_id) {
                    replyAuthorLabel = data.reply_sender_login === currentUser.login
                        ? currentUser.nickname
                        : currentChat.nickname;
                }

                addMessage(null, data.text, data.from === currentUser.login, data.created_at, {
                    isPrivate: true,
                    isRead: !!data.is_read,
                    messageId: data.id,
                    scope: "private",
                    reply: data.reply_to_id ? { authorLabel: replyAuthorLabel, text: data.reply_text } : null,
                    reactions: data.reactions || [],
                });
            }

            // Если такого контакта ещё нет в списке слева — сначала добавляем его
            const contactExists = !!document.querySelector(`.contactItem[data-login="${otherLogin}"]`);
            const contactListReady = contactExists
                ? Promise.resolve()
                : loadConversations();

            if (isIncoming) {
                // Диалог открыт на экране прямо сейчас — сразу сообщаем отправителю,
                // что сообщение увидено (двойная галочка)
                if (viewingThisChat && ws && ws.readyState === 1) {
                    ws.send(JSON.stringify({ type: "mark_read", with: otherLogin }));
                }

                // Уведомляем только о чужих сообщениях, и только если человек прямо сейчас
                // не смотрит именно в эту открытую и активную вкладку с этим диалогом
                const activelyWatching = viewingThisChat && document.hasFocus();
                if (!activelyWatching) {
                    playNotificationSound();
                    const senderNickname = knownNicknames[data.from] || otherLogin;
                    showDesktopNotification(senderNickname, data.text);
                    Promise.resolve(contactListReady).then(() => markContactUnread(otherLogin));
                }
            }
        }

        // Собеседник прочитал наши сообщения — проставляем двойные галочки
        if (data.type === "read_receipt") {
            if (currentChat.type === "private" && currentChat.login === data.by) {
                document.querySelectorAll("#messages .message.mine .message-status").forEach((el) => {
                    el.classList.add("read");
                    el.textContent = "✓✓";
                    el.title = "Прочитано";
                });
            }
        }

        // Кто-то поставил/снял реакцию — обновляем ряд реакций у нужного сообщения
        if (data.type === "reaction_update") {
            updateReactionsOnMessage(data.scope, data.message_id, data.reactions);
        }
    };

    const sendMessage = () => {
        const text = input.value.trim();
        if (text === "" || !connected) return;

        const replyToId = replyingTo ? replyingTo.id : undefined;

        if (currentChat.type === "public") {
            ws.send(JSON.stringify({
                type: "public_message",
                nickname: currentUser.nickname,
                text,
                reply_to_id: replyToId
            }));
        } else {
            ws.send(JSON.stringify({
                type: "private_message",
                to: currentChat.login,
                text,
                reply_to_id: replyToId
            }));
        }

        input.value = "";
        input.focus();
        cancelReply();
    };

    button.onclick = sendMessage;
    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            sendMessage();
        }
    });
}

// Приводим время из БД ("YYYY-MM-DD HH:MM:SS" или ISO) к красивому виду ЧЧ:ММ
// в часовом поясе пользователя.
function formatMessageTime(rawTimestamp) {
    if (!rawTimestamp) return "";

    let isoString = rawTimestamp;
    if (typeof isoString === "string" && isoString.includes(" ") && !isoString.includes("T")) {
        // SQLite CURRENT_TIMESTAMP отдаёт UTC без "T" и без "Z" — добавляем их сами
        isoString = isoString.replace(" ", "T") + "Z";
    }

    const date = new Date(isoString);
    if (isNaN(date.getTime())) return "";

    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// meta (необязательный объект):
// { isPrivate, isRead, messageId, scope: 'public'|'private', reply: {authorLabel, text}|null, reactions: [] }
function addMessage(nickname, text, isMine, timestamp, meta = {}) {
    const msg = document.createElement("div");
    msg.className = "message";
    msg.classList.add(isMine ? "mine" : "other");

    if (meta.messageId != null) msg.dataset.messageId = String(meta.messageId);
    if (meta.scope) msg.dataset.scope = meta.scope;

    if (!isMine && nickname) {
        const nameEl = document.createElement("div");
        nameEl.className = "message-nickname";
        nameEl.textContent = nickname;
        msg.appendChild(nameEl);
    }

    // Превью сообщения, на которое отвечают (как реплай в Telegram)
    if (meta.reply) {
        const replyEl = document.createElement("div");
        replyEl.className = "reply-preview";

        const replyAuthorEl = document.createElement("div");
        replyAuthorEl.className = "reply-preview-author";
        replyAuthorEl.textContent = meta.reply.authorLabel || "…";

        const replyTextEl = document.createElement("div");
        replyTextEl.className = "reply-preview-text";
        replyTextEl.textContent = meta.reply.text || "";

        replyEl.appendChild(replyAuthorEl);
        replyEl.appendChild(replyTextEl);
        msg.appendChild(replyEl);
    }

    // Текст и блок "время + статус" — соседние элементы в одной строке (flex):
    // текст прижат влево, время с галочками — вправо, на одном уровне с текстом.
    const rowEl = document.createElement("div");
    rowEl.className = "message-row";

    const textEl = document.createElement("span");
    textEl.className = "message-text";
    textEl.appendChild(document.createTextNode(text));
    rowEl.appendChild(textEl);

    const metaEl = document.createElement("span");
    metaEl.className = "message-meta";

    const timeText = formatMessageTime(timestamp);
    if (timeText) {
        const timeEl = document.createElement("span");
        timeEl.className = "message-time";
        timeEl.textContent = timeText;
        metaEl.appendChild(timeEl);
    }

    if (isMine && meta.isPrivate) {
        const statusEl = document.createElement("span");
        statusEl.className = "message-status" + (meta.isRead ? " read" : "");
        statusEl.textContent = meta.isRead ? "✓✓" : "✓";
        statusEl.title = meta.isRead ? "Прочитано" : "Отправлено";
        metaEl.appendChild(statusEl);
    }

    if (metaEl.childNodes.length > 0) {
        rowEl.appendChild(metaEl);
    }

    msg.appendChild(rowEl);

    // Кнопки "Ответить" и "Реакция" — доступны только у сообщений, у которых
    // есть id и известен scope (общий/личный чат), т.е. не у системных сообщений.
    if (meta.messageId != null && meta.scope) {
        const actionsEl = document.createElement("div");
        actionsEl.className = "message-actions";

        const authorForReply = isMine
            ? currentUser.nickname
            : (nickname || (currentChat.type === "private" ? currentChat.nickname : ""));

        const replyBtn = document.createElement("button");
        replyBtn.type = "button";
        replyBtn.className = "message-action-btn";
        replyBtn.textContent = "↩";
        replyBtn.title = "Ответить";
        replyBtn.addEventListener("click", () => {
            startReply(meta.messageId, meta.scope, authorForReply, text);
        });
        actionsEl.appendChild(replyBtn);

        const reactBtn = document.createElement("button");
        reactBtn.type = "button";
        reactBtn.className = "message-action-btn";
        reactBtn.textContent = "😀";
        reactBtn.title = "Реакция";
        reactBtn.addEventListener("click", (event) => {
            event.stopPropagation();
            toggleReactionPicker(reactBtn, meta.messageId, meta.scope);
        });
        actionsEl.appendChild(reactBtn);

        msg.appendChild(actionsEl);
    }

    // Реакции под сообщением (может быть пустым списком — просто ничего не отрисуется)
    const reactionsRowEl = document.createElement("div");
    reactionsRowEl.className = "reactions-row";
    renderReactionsInto(reactionsRowEl, meta.reactions || [], meta.messageId, meta.scope);
    msg.appendChild(reactionsRowEl);

    messages.appendChild(msg);
    messages.scrollTop = messages.scrollHeight;
}

// ---- Реакции на сообщения ----

function renderReactionsInto(container, reactions, messageId, scope) {
    container.innerHTML = "";
    reactions.forEach(({ emoji, logins }) => {
        if (!logins || logins.length === 0) return;

        const pill = document.createElement("button");
        pill.type = "button";
        pill.className = "reaction-pill";
        if (currentUser && logins.includes(currentUser.login)) {
            pill.classList.add("mine");
        }
        pill.textContent = `${emoji} ${logins.length}`;
        pill.title = logins.join(", ");
        pill.addEventListener("click", () => sendReaction(messageId, scope, emoji));
        container.appendChild(pill);
    });
}

function updateReactionsOnMessage(scope, messageId, reactions) {
    const el = document.querySelector(
        `.message[data-scope="${scope}"][data-message-id="${messageId}"]`
    );
    if (!el) return;

    const container = el.querySelector(".reactions-row");
    if (container) renderReactionsInto(container, reactions, messageId, scope);
}

function sendReaction(messageId, scope, emoji) {
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: "toggle_reaction", scope, message_id: messageId, emoji }));
}

let reactionPickerEl = null;

function closeReactionPicker() {
    if (reactionPickerEl) {
        reactionPickerEl.remove();
        reactionPickerEl = null;
    }
    document.removeEventListener("click", closeReactionPicker);
}

function toggleReactionPicker(anchorBtn, messageId, scope) {
    if (reactionPickerEl) {
        closeReactionPicker();
        return;
    }

    const picker = document.createElement("div");
    picker.className = "reaction-picker";

    REACTION_EMOJIS.forEach((emoji) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "reaction-picker-btn";
        btn.textContent = emoji;
        btn.addEventListener("click", (event) => {
            event.stopPropagation();
            sendReaction(messageId, scope, emoji);
            closeReactionPicker();
        });
        picker.appendChild(btn);
    });

    document.body.appendChild(picker);

    const rect = anchorBtn.getBoundingClientRect();
    const pickerWidth = REACTION_EMOJIS.length * 32 + 16;
    picker.style.position = "fixed";
    picker.style.top = `${rect.bottom + 4}px`;
    picker.style.left = `${Math.min(Math.max(8, rect.left - pickerWidth / 2), window.innerWidth - pickerWidth - 8)}px`;

    reactionPickerEl = picker;
    setTimeout(() => document.addEventListener("click", closeReactionPicker), 0);
}

// ---- Ответ на сообщение (как реплай в Telegram) ----

function startReply(messageId, scope, authorLabel, text) {
    replyingTo = { id: messageId, scope, authorLabel, text };
    replyBarAuthor.textContent = authorLabel || "Сообщение";
    replyBarText.textContent = text.length > 120 ? text.slice(0, 120) + "…" : text;
    replyBar.style.display = "flex";
    input.focus();
}

function cancelReply() {
    replyingTo = null;
    replyBar.style.display = "none";
}

cancelReplyBtn.addEventListener("click", cancelReply);

function addSystemMessage(text) {
    const msg = document.createElement("div");
    msg.style.cssText = "color:#888; text-align:center; margin:10px 0; font-size:14px;";
    msg.textContent = text;
    messages.appendChild(msg);
}

// ---- Переключение между чатами ----

function setActiveContactItem(el) {
    document.querySelectorAll(".contactItem").forEach((item) => item.classList.remove("active"));
    el.classList.add("active");
}

function isMobileLayout() {
    return window.innerWidth <= MOBILE_BREAKPOINT;
}

function showChatPaneOnMobile() {
    if (isMobileLayout()) {
        chatContainer.classList.add("mobile-chat-open");
    }
}

function showContactsPaneOnMobile() {
    chatContainer.classList.remove("mobile-chat-open");
}

backToContacts.addEventListener("click", showContactsPaneOnMobile);

async function openPublicChat() {
    currentChat = { type: "public" };
    chatHeader.textContent = "AntiRKNet — Общий чат";
    setActiveContactItem(publicChatItem);
    messages.innerHTML = "";
    addSystemMessage("Загрузка истории...");
    showChatPaneOnMobile();
    cancelReply();

    // История общего чата придёт через WS при следующем auth,
    // но раз соединение уже открыто — просто попросим сервер снова
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "auth", login: currentUser.login }));
    }
}

async function openPrivateChat(login, nickname, el) {
    currentChat = { type: "private", login, nickname };
    chatHeader.textContent = `AntiRKNet — ${nickname}`;
    setActiveContactItem(el);
    clearContactUnread(login);
    messages.innerHTML = "";
    addSystemMessage("Загрузка переписки...");
    showChatPaneOnMobile();
    cancelReply();

    try {
        const response = await fetch(
            `/messages/private?me=${encodeURIComponent(currentUser.login)}&with=${encodeURIComponent(login)}`
        );
        const data = await response.json();

        messages.innerHTML = "";

        if (data.success) {
            data.messages.forEach((msg) => {
                let replyAuthorLabel = null;
                if (msg.reply_to_id) {
                    replyAuthorLabel = msg.reply_sender_login === currentUser.login
                        ? currentUser.nickname
                        : currentChat.nickname;
                }

                addMessage(null, msg.text, msg.sender_login === currentUser.login, msg.created_at, {
                    isPrivate: true,
                    isRead: !!msg.is_read,
                    messageId: msg.id,
                    scope: "private",
                    reply: msg.reply_to_id ? { authorLabel: replyAuthorLabel, text: msg.reply_text } : null,
                    reactions: msg.reactions || [],
                });
            });

            // Открыли переписку — значит, все сообщения собеседника теперь прочитаны
            if (ws && ws.readyState === 1) {
                ws.send(JSON.stringify({ type: "mark_read", with: login }));
            }
        }
    } catch (err) {
        messages.innerHTML = "";
        addSystemMessage("Не удалось загрузить переписку.");
    }
}

publicChatItem.addEventListener("click", openPublicChat);

function renderContactItem(login, nickname) {
    knownNicknames[login] = nickname;

    const el = document.createElement("div");
    el.className = "contactItem";
    el.dataset.login = login;
    el.textContent = `👤 ${nickname}`;
    el.addEventListener("click", () => openPrivateChat(login, nickname, el));
    contactsList.appendChild(el);
    return el;
}

async function loadConversations() {
    try {
        const response = await fetch(`/conversations?login=${encodeURIComponent(currentUser.login)}`);
        const data = await response.json();

        if (!data.success) return;

        // очищаем всё, кроме "Общий чат"
        Array.from(contactsList.children).forEach((child) => {
            if (child !== publicChatItem) child.remove();
        });

        data.conversations.forEach((user) => {
            renderContactItem(user.login, user.nickname);
        });
    } catch (err) {
        console.error("Не удалось загрузить список чатов:", err.message);
    }
}

addContactBtn.addEventListener("click", addContactByLogin);
newContactLogin.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
        event.preventDefault();
        addContactByLogin();
    }
});

async function addContactByLogin() {
    const login = newContactLogin.value.trim();
    addContactMessage.textContent = "";

    if (!login) return;

    if (login === currentUser.login) {
        addContactMessage.textContent = "Это ваш собственный логин.";
        return;
    }

    try {
        const response = await fetch(`/users/${encodeURIComponent(login)}`);
        const data = await response.json();

        if (!data.success) {
            addContactMessage.textContent = "Пользователь не найден.";
            return;
        }

        const existing = document.querySelector(`.contactItem[data-login="${login}"]`);
        const el = existing || renderContactItem(data.user.login, data.user.nickname);

        openPrivateChat(data.user.login, data.user.nickname, el);
        newContactLogin.value = "";
    } catch (err) {
        addContactMessage.textContent = "Ошибка связи с сервером.";
    }
}

const savedUser = localStorage.getItem("chatUser");
if (savedUser) {
    enterChat(JSON.parse(savedUser));
}

