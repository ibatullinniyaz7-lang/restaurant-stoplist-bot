import { handleTelegramUpdate } from "./bot.js";
import { deleteAnnouncementBatch, deliverNotificationBatch } from "./broadcast.js";
import { processExpectedStatuses } from "./availability.js";
import { processScheduleAutomation } from "./schedule.js";

function json(payload, status = 200) {
  return Response.json(payload, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function sameSecret(actual, expected) {
  return Boolean(actual && expected && actual === expected);
}

async function claimUpdate(env, updateId) {
  if (!Number.isInteger(updateId)) return true;
  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO processed_updates (update_id, processed_at) VALUES (?, CURRENT_TIMESTAMP)",
  ).bind(updateId).run();
  return (result.meta?.changes ?? 0) === 1;
}

async function releaseUpdate(env, updateId) {
  if (!Number.isInteger(updateId)) return;
  await env.DB.prepare("DELETE FROM processed_updates WHERE update_id = ?").bind(updateId).run();
}

export default {
  async scheduled(controller, env, ctx) {
    const scheduledAt = new Date(controller?.scheduledTime ?? Date.now());
    ctx.waitUntil(Promise.allSettled([
      processExpectedStatuses(env, env.PUBLIC_URL),
      processScheduleAutomation(env, env.PUBLIC_URL, scheduledAt),
    ]));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return json({ ok: true, service: "restaurant-stoplist-bot" });
    }

    const broadcastMatch = /^\/internal\/broadcast\/(\d+)$/.exec(url.pathname);
    if (request.method === "GET" && broadcastMatch) {
      if (!sameSecret(request.headers.get("x-internal-secret"), env.INTERNAL_SECRET)) {
        return json({ ok: false }, 403);
      }
      const after = Number(url.searchParams.get("after") ?? 0);
      await deliverNotificationBatch(env, url.origin, Number(broadcastMatch[1]), after);
      return json({ ok: true });
    }

    const deleteAnnouncementMatch = /^\/internal\/delete-announcement\/(\d+)$/.exec(url.pathname);
    if (request.method === "GET" && deleteAnnouncementMatch) {
      if (!sameSecret(request.headers.get("x-internal-secret"), env.INTERNAL_SECRET)) {
        return json({ ok: false }, 403);
      }
      const after = Number(url.searchParams.get("after") ?? 0);
      await deleteAnnouncementBatch(env, url.origin, Number(deleteAnnouncementMatch[1]), after);
      return json({ ok: true });
    }

    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return json({ ok: false, error: "not_found" }, 404);
    }

    if (!sameSecret(request.headers.get("x-telegram-bot-api-secret-token"), env.WEBHOOK_SECRET)) {
      return json({ ok: false, error: "forbidden" }, 403);
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return json({ ok: false, error: "invalid_json" }, 400);
    }

    if (!update || typeof update !== "object" || Array.isArray(update)
      || !Number.isSafeInteger(update.update_id) || update.update_id < 0) {
      return json({ ok: false, error: "invalid_update" }, 400);
    }

    if (!(await claimUpdate(env, update.update_id))) return json({ ok: true, duplicate: true });

    try {
      await handleTelegramUpdate(update, env, ctx, url.origin);
      return json({ ok: true });
    } catch (error) {
      console.error("Update failed", {
        updateId: update.update_id,
        name: error?.name,
        message: error?.message,
      });
      await releaseUpdate(env, update.update_id);
      return json({ ok: false, error: "temporary_failure" }, 500);
    }
  },
};
