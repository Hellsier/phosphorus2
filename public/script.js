const input = document.getElementById("messageInput");
const button = document.getElementById("sendButton");
const messages = document.getElementById("messages");

const sendMessage = () => {
    if (input.value.trim() === "")
        return;
        
    const message = document.createElement("div");
    message.className = "message";
    message.textContent = input.value;
    messages.appendChild(message);
    input.value = "";
    
    messages.scrollTop = messages.scrollHeight;
};

button.onclick = sendMessage;

input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
        event.preventDefault();
        sendMessage();
    }
});
