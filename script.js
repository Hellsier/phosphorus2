const input = document.getElementById("messageInput");
const button = document.getElementById("sendButton");
const messages = document.getElementById("messages");

const ws = new WebSocket(`wss://${location.host}`);
let connected = false;

ws.onopen = () => {
    connected = true;
    addSystemMessage("✅ Подключено");
};

ws.onclose = () => {
    connected = false;
    addSystemMessage("❌ Соединение потеряно");
};

ws.onmessage = (event) => {
    addMessage(event.data, false);
};

const sendMessage = () => {
    const text = input.value.trim();
    if (text === "" || !connected) return;
    ws.send(text);
    addMessage(text, true);
    input.value = "";
    input.focus();
};

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

button.onclick = sendMessage;
input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
        event.preventDefault();
        sendMessage();
    }
});
