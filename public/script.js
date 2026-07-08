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
                addMessage(msg.nickname, msg.text, msg.nickname === currentUser.nickname);
            });
        }

        if (data.type === "public_message" && currentChat.type === "public") {
            addMessage(data.nickname, data.text, data.nickname === currentUser.nickname);
        }

        if (data.type === "private_message") {
            const otherLogin = data.from === currentUser.login ? data.to : data.from;

            // Если это переписка, которую сейчас видим на экране — дорисовываем сразу
            if (currentChat.type === "private" && currentChat.login === otherLogin) {
                addMessage(null, data.text, data.from === currentUser.login);
            }

            // Если такого контакта ещё нет в списке слева — добавляем
            if (!document.querySelector(`.contactItem[data-login="${otherLogin}"]`)) {
                loadConversations();
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

function addMessage(nickname, text, isMine) {
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
                addMessage(null, msg.text, msg.sender_login === currentUser.login);
            });
        }
    } catch (err) {
        messages.innerHTML = "";
        addSystemMessage("Не удалось загрузить переписку.");
    }
}

publicChatItem.addEventListener("click", openPublicChat);

function renderContactItem(login, nickname) {
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
