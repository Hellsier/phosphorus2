
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

let mode = "register";
let ws = null;

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
    authScreen.style.display = "none";
    chatContainer.style.display = "flex";
    connectWebSocket(user);
}

function connectWebSocket(user) {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${protocol}://${location.host}`);
    let connected = false;

    ws.onopen = () => {
        connected = true;
        addSystemMessage(`✅ Подключено как ${user.nickname}`);
    };

    ws.onclose = () => {
        connected = false;
        addSystemMessage("❌ Соединение потеряно");
    };

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'history' || data.type === 'message') {
            addMessage(data.text, false);
        }
    };

    const sendMessage = () => {
        const text = input.value.trim();
        if (text === "" || !connected) return;
        ws.send(`${user.nickname}: ${text}`);
        addMessage(text, true);
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

function addMessage(text, isMine) {
    const msg = document.createElement("div");
    msg.className = "message";
    msg.classList.add(isMine ? "mine" : "other");
    msg.textContent = text;
    messages.appendChild(msg);
    messages.scrollTop = messages.scrollHeight;
}

function addSystemMessage(text) {
    const msg = document.createElement("div");
    msg.style.cssText = "color:#888; text-align:center; margin:10px 0; font-size:14px;";
    msg.textContent = text;
    messages.appendChild(msg);
}

const savedUser = localStorage.getItem("chatUser");
if (savedUser) {
    enterChat(JSON.parse(savedUser));
}
 
