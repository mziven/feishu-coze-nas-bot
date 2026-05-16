const lark = require("@larksuiteoapi/node-sdk");

const {
  FEISHU_APP_ID,
  FEISHU_APP_SECRET,
  COZE_API_KEY,
  COZE_PROJECT_ID,
  COZE_CHAT_API
} = process.env;

if (!FEISHU_APP_ID || !FEISHU_APP_SECRET || !COZE_API_KEY || !COZE_PROJECT_ID || !COZE_CHAT_API) {
  console.error("Missing required environment variables.");
  process.exit(1);
}

const client = new lark.Client({
  appId: FEISHU_APP_ID,
  appSecret: FEISHU_APP_SECRET,
  domain: lark.Domain.Feishu
});

const wsClient = new lark.WSClient({
  appId: FEISHU_APP_ID,
  appSecret: FEISHU_APP_SECRET,
  loggerLevel: lark.LoggerLevel.info
});

const seenMessages = new Map();

function rememberMessage(messageId) {
  if (!messageId) return false;

  const now = Date.now();
  for (const [id, time] of seenMessages.entries()) {
    if (now - time > 10 * 60 * 1000) seenMessages.delete(id);
  }

  if (seenMessages.has(messageId)) return true;
  seenMessages.set(messageId, now);
  return false;
}

function getText(content) {
  try {
    const parsed = typeof content === "string" ? JSON.parse(content) : content;
    return String(parsed.text || "").trim();
  } catch {
    return String(content || "").trim();
  }
}

function extractCozeAnswer(rawText) {
  let answer = "";

  for (const line of rawText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;

    const jsonText = trimmed.replace(/^data:\s*/, "");
    if (!jsonText || jsonText === "[DONE]") continue;

    try {
      const data = JSON.parse(jsonText);
      if (typeof data.content === "string") answer = data.content;
      if (typeof data?.content?.text === "string") answer = data.content.text;
      if (typeof data?.data?.content === "string") answer = data.data.content;
      if (typeof data?.data?.content?.text === "string") answer = data.data.content.text;
      if (typeof data?.event?.content === "string") answer = data.event.content;
    } catch {}
  }

  return answer || rawText || "我暂时没有生成有效回复。";
}

async function callCoze(text, sessionId) {
  const response = await fetch(COZE_CHAT_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${COZE_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      content: {
        query: {
          prompt: [
            {
              type: "text",
              content: { text }
            }
          ]
        }
      },
      type: "query",
      session_id: sessionId,
      project_id: Number(COZE_PROJECT_ID)
    })
  });

  const rawText = await response.text();

  if (!response.ok) {
    throw new Error(`Coze request failed: ${rawText}`);
  }

  return extractCozeAnswer(rawText);
}

async function sendText(chatId, text) {
  await client.im.v1.message.create({
    params: {
      receive_id_type: "chat_id"
    },
    data: {
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text })
    }
  });
}

async function handleMessage(data) {
  const message = data.message;
  const sender = data.sender;

  if (!message || message.message_type !== "text") return;
  if (sender?.sender_type === "app") return;

  const messageId = message.message_id;
  if (rememberMessage(messageId)) return;

  const chatId = message.chat_id;
  const userText = getText(message.content);

  if (!chatId || !userText) return;

  console.log("Received:", userText);

  const sessionId = chatId;
  const answer = await callCoze(userText, sessionId);

  await sendText(chatId, answer);
  console.log("Replied:", answer.slice(0, 80));
}

const eventDispatcher = new lark.EventDispatcher({}).register({
  "im.message.receive_v1": async (data) => {
    handleMessage(data).catch((error) => {
      console.error("Handle message failed:", error);
    });

    return {};
  }
});

wsClient.start({
  eventDispatcher
});

console.log("Feishu Coze bot started with long connection.");
