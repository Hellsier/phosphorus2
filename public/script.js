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
const chatHeader = document.getElementById("chatHeader");
const contactsList = document.getElementById("contactsList");
const publicChatItem = document.getElementById("publicChatItem");
const newContactLogin = document.getElementById("newContactLogin");
const addContactBtn = document.getElementById("addContactBtn");
const addContactMessage = document.getElementById("addContactMessage");

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
}

// ---- Звуковые и браузерные уведомления о новых личных сообщениях ----

let audioCtx = null;

function playNotificationSound() {
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
                addMessage(msg.nickname, msg.text, msg.nickname === currentUser.nickname, msg.created_at);
            });
        }

        if (data.type === "public_message" && currentChat.type === "public") {
            addMessage(data.nickname, data.text, data.nickname === currentUser.nickname, data.created_at);
        }

        if (data.type === "private_message") {
            const otherLogin = data.from === currentUser.login ? data.to : data.from;
            const isIncoming = data.from !== currentUser.login;
            const viewingThisChat = currentChat.type === "private" && currentChat.login === otherLogin;

            // Если это переписка, которую сейчас видим на экране — дорисовываем сразу
            if (viewingThisChat) {
                addMessage(null, data.text, data.from === currentUser.login, data.created_at);
            }

            // Если такого контакта ещё нет в списке слева — сначала добавляем его
            const contactExists = !!document.querySelector(`.contactItem[data-login="${otherLogin}"]`);
            const contactListReady = contactExists
                ? Promise.resolve()
                : loadConversations();

            // Уведомляем только о чужих сообщениях, и только если человек прямо сейчас
            // не смотрит именно в эту открытую и активную вкладку с этим диалогом
            if (isIncoming) {
                const activelyWatching = viewingThisChat && document.hasFocus();
                if (!activelyWatching) {
                    playNotificationSound();
                    const senderNickname = knownNicknames[data.from] || otherLogin;
                    showDesktopNotification(senderNickname, data.text);
                    Promise.resolve(contactListReady).then(() => markContactUnread(otherLogin));
                }
            }
        }
    };

    const sendMessage = () => {
        const text = input.value.trim();
        if (text === "" || !connected) return;

        if (currentChat.type === "public") {
            ws.send(JSON.stringify({
                type: "public_message",
                nickname: currentUser.nickname,
                text
            }));
        } else {
            ws.send(JSON.stringify({
                type: "private_message",
                to: currentChat.login,
                text
            }));
        }

        input.value = "";
        input.focus();
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

function addMessage(nickname, text, isMine, timestamp) {
    const msg = document.createElement("div");
    msg.className = "message";
    msg.classList.add(isMine ? "mine" : "other");

    if (!isMine && nickname) {
        const nameEl = document.createElement("div");
        nameEl.className = "message-nickname";
        nameEl.textContent = nickname;
        msg.appendChild(nameEl);
    }

    const textEl = document.createElement("div");
    textEl.textContent = text;
    msg.appendChild(textEl);

    const timeText = formatMessageTime(timestamp);
    if (timeText) {
        const timeEl = document.createElement("div");
        timeEl.className = "message-time";
        timeEl.textContent = timeText;
        msg.appendChild(timeEl);
    }

    messages.appendChild(msg);
    messages.scrollTop = messages.scrollHeight;
}

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

async function openPublicChat() {
    currentChat = { type: "public" };
    chatHeader.textContent = "AntiRKNet — Общий чат";
    setActiveContactItem(publicChatItem);
    messages.innerHTML = "";
    addSystemMessage("Загрузка истории...");

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

    try {
        const response = await fetch(
            `/messages/private?me=${encodeURIComponent(currentUser.login)}&with=${encodeURIComponent(login)}`
        );
        const data = await response.json();

        messages.innerHTML = "";

        if (data.success) {
            data.messages.forEach((msg) => {
                addMessage(null, msg.text, msg.sender_login === currentUser.login, msg.created_at);
            });
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
