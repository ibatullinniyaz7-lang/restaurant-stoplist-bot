const required = ["BOT_TOKEN", "WORKER_URL", "WEBHOOK_SECRET"];
for (const name of required) {
  if (!process.env[name]) throw new Error(`Не задана переменная ${name}`);
}

const workerUrl = process.env.WORKER_URL.replace(/\/$/, "");

async function telegram(method, payload = {}) {
  const response = await fetch(
    `https://api.telegram.org/bot${process.env.BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(`Telegram ${method}: ${data.description ?? response.status}`);
  }
  return data.result;
}

await telegram("setMyCommands", {
  commands: [
    { command: "menu", description: "Открыть разделы меню" },
    { command: "stop", description: "Показать текущий стоп-лист" },
    { command: "schedule", description: "Запись на смены" },
    { command: "announce", description: "Объявление для команды" },
    { command: "help", description: "Как пользоваться ботом" },
  ],
});

await telegram("setWebhook", {
  url: `${workerUrl}/webhook`,
  secret_token: process.env.WEBHOOK_SECRET,
  allowed_updates: ["message", "callback_query"],
  drop_pending_updates: false,
});

const webhook = await telegram("getWebhookInfo");
console.log(JSON.stringify({
  ok: webhook.url === `${workerUrl}/webhook`,
  url: webhook.url,
  pending_update_count: webhook.pending_update_count,
  last_error_message: webhook.last_error_message ?? null,
}, null, 2));
