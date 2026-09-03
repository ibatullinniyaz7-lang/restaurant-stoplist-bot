export class TelegramError extends Error {
  constructor(method, status, description) {
    super(`Telegram ${method}: ${status} ${description}`);
    this.name = "TelegramError";
    this.method = method;
    this.status = status;
    this.description = description;
  }
}

export async function telegramCall(env, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  let data;
  try {
    data = await response.json();
  } catch {
    throw new TelegramError(method, response.status, "некорректный ответ API");
  }

  if (!response.ok || !data.ok) {
    throw new TelegramError(method, response.status, data.description ?? "неизвестная ошибка");
  }
  return data.result;
}

export function sendMessage(env, chatId, text, extra = {}) {
  return telegramCall(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

export function answerCallback(env, callbackQueryId, text = "", showAlert = false) {
  return telegramCall(env, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: showAlert,
    cache_time: 0,
  });
}

export function deleteMessage(env, chatId, messageId) {
  return telegramCall(env, "deleteMessage", {
    chat_id: chatId,
    message_id: messageId,
  });
}

export async function editMessage(env, chatId, messageId, text, replyMarkup) {
  try {
    return await telegramCall(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: replyMarkup,
    });
  } catch (error) {
    if (error instanceof TelegramError && error.description.includes("message is not modified")) {
      return null;
    }
    throw error;
  }
}
