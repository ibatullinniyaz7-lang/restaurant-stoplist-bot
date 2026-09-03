const STAFF_BOT_SETTING = "staff_bot_enabled";

export async function isStaffBotEnabled(env) {
  const setting = await env.DB.prepare(`
    SELECT setting_value
    FROM app_settings
    WHERE setting_key = ?
    LIMIT 1
  `).bind(STAFF_BOT_SETTING).first();
  return setting?.setting_value !== "0";
}

export async function setStaffBotEnabled(env, enabled, userId) {
  await env.DB.prepare(`
    INSERT INTO app_settings (setting_key, setting_value, updated_at, updated_by_user_id)
    VALUES (?, ?, CURRENT_TIMESTAMP, ?)
    ON CONFLICT(setting_key) DO UPDATE SET
      setting_value = excluded.setting_value,
      updated_at = CURRENT_TIMESTAMP,
      updated_by_user_id = excluded.updated_by_user_id
  `).bind(STAFF_BOT_SETTING, enabled ? "1" : "0", userId ?? null).run();
}

export async function toggleStaffBotEnabled(env, userId) {
  const enabled = !(await isStaffBotEnabled(env));
  await setStaffBotEnabled(env, enabled, userId);
  return enabled;
}

export function ownerOnlyRecipients(env, afterChatId = 0) {
  const ownerChatId = Number(env.OWNER_USER_ID);
  if (!Number.isSafeInteger(ownerChatId) || ownerChatId <= Number(afterChatId || 0)) return [];
  return [{ chat_id: ownerChatId }];
}
