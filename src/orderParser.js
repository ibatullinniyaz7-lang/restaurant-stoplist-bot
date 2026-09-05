import { sendMessage } from "./telegram.js";
import { escapeHtml } from "./ui.js";

const CATEGORY_ORDER = [
  "Закуски", "Горячие закуски", "Салаты", "Супы", "Блюда из мяса", "Рыбные блюда",
  "Блюда на углях", "Гарниры", "Соусы", "Выпечка", "Десерты", "Чёрный чай",
  "Чайные композиции", "Зелёный чай", "Добавки к чаю", "Кофе", "Татарские напитки",
  "Напитки Rich", "Прохладительные напитки", "Минеральная вода", "Игристое вино",
  "Красное вино", "Розовое вино", "Белое вино", "Безалкогольное вино", "Ликёры",
  "Водка", "Настойки", "Виски", "Коньяк", "Ром", "Джин", "Текила",
  "Разливное пиво", "Бутылочное пиво", "Шоты", "Алкогольные коктейли",
  "Авторские коктейли", "Безалкогольные коктейли", "Молочные коктейли", "Лимонады", "Дополнительно",
];

function normalize(value) {
  return String(value ?? "")
    .toLocaleLowerCase("ru-RU")
    .replaceAll("ё", "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function quantityAndText(line) {
  const normalizedLine = line.replace(/^²\s*/u, "2 ");
  const quantityMatch = /^(\d{1,3})\s+/.exec(normalizedLine.trim());
  const quantity = quantityMatch ? Number(quantityMatch[1]) : 1;
  const text = (quantityMatch ? normalizedLine.slice(quantityMatch[0].length) : normalizedLine).trim();
  const noteParts = [];
  const noteMatch = text.match(/\bпо\s+\d+(?:[.,]\d+)?\b/iu);
  if (noteMatch) noteParts.push(noteMatch[0]);
  if (/без\s+зелени/i.test(text)) noteParts.push("без зелени");
  if (/в\s+конце/i.test(text)) noteParts.push("в конце");
  if (/холодн/i.test(text)) noteParts.push("холодный");
  const clean = text
    .replace(/\bпо\s+\d+(?:[.,]\d+)?\b/giu, "")
    .replace(/\b(в\s+конце|без\s+зелени|холодн\w*)\b/giu, "")
    .replace(/\s+/g, " ")
    .trim();
  return { quantity, text, clean, note: noteParts.join(", ") };
}

function findByCategory(dishes, categoryName, name) {
  const wanted = normalize(name);
  return dishes.find((dish) => normalize(dish.category_name) === normalize(categoryName) && normalize(dish.name) === wanted)
    ?? dishes.find((dish) => normalize(dish.category_name) === normalize(categoryName) && normalize(dish.name).includes(wanted));
}

function aliasMatch(text, dishes) {
  const value = normalize(text);
  const direct = (category, name, when = () => true) => when(value) ? findByCategory(dishes, category, name) : null;

  if (/туган\s+авылым\s+салат/.test(value)) return direct("Салаты", "Туган Авылым");
  if (/^туг\s+авылым(?:\s+0?\d+)?$/.test(value) || /^туган\s+авылым\s+0?\d+$/.test(value)) return direct("Чёрный чай", "Туган Авылым");
  if (/^татарский(?:\s+чай)?(?:\s+0?\d+)?/.test(value)) return direct("Чёрный чай", "Татарский чай");
  if (/^(беш|бешбармак)$/.test(value)) return direct("Блюда из мяса", "Бишбармак");
  if (/^азу$|татарча\s+азу/.test(value)) return direct("Блюда из мяса", "Татарча Азу");
  if (/курбан\s*байрам|курб\s+байрам/.test(value)) return direct("Блюда из мяса", "Курбан Байрам");
  if (/батыр\s+ризы/.test(value)) return direct("Блюда из мяса", "Батыр ризыгы");
  if (/хан\s+ризы/.test(value)) return direct("Блюда из мяса", "Хан ризыгы");
  if (/татлы\s+ризык/.test(value)) return direct("Блюда из мяса", "Татлы ризыгы");
  if (/милли\s+аш/.test(value)) return direct("Блюда из мяса", "Милли ашы");
  if (/сююмбике/.test(value)) return direct("Блюда из мяса", "Сююмбике");
  if (/кызыл\s+аш/.test(value)) return direct("Супы", "Кызыл аш");
  if (/казан\s+аш/.test(value)) return direct("Супы", "Казан ашы");
  if (/токмач/.test(value)) return direct("Супы", "Токмач");
  if (/оч\s*(?:бл|п)\s*шулпа|очпочмак.*шулпа/.test(value)) return direct("Супы", "Очпочмак белэн шулпа");
  if (/^бозбаш$/.test(value)) return direct("Супы", "Бозбаш");
  if (/^уха$|патша\s+уха/.test(value)) return direct("Супы", "Патша ухасы");
  if (/^оч\s+с\s+говядиной|очпочмак\s+с\s+говядин/.test(value)) return direct("Выпечка", "Очпочмак с говядиной");
  if (/^оч\s+с\s+гусем|очпочмак\s+с\s+гусем/.test(value)) return direct("Выпечка", "Очпочмак с гусем");
  if (/^оч\s+с\s+уткой|очпочмак\s+с\s+уткой/.test(value)) return direct("Выпечка", "Очпочмак с уткой");
  if (/^элеш/.test(value)) return direct("Выпечка", "Элеш с курицей");
  if (/^перемяч/.test(value)) return direct("Выпечка", "Перемяч с говядиной");
  if (/кыстыб/.test(value)) return direct("Выпечка", "Кыстыбый");
  if (/лепеш/.test(value)) return direct("Выпечка", "Лепёшка");
  if (/губад|губал/.test(value)) return direct("Десерты", "Губадия");
  if (/баурс/.test(value)) return direct("Десерты", "Баурсак");
  if (/лимонник/.test(value)) return direct("Десерты", "Лимонник с меренгой");
  if (/алма\s+бэлеш/.test(value)) return direct("Десерты", "Алма бэлеш");
  if (/чак\s*чак/.test(value)) return direct("Десерты", "Чак-чак");
  if (/талкыш/.test(value)) return direct("Десерты", "Талкыш калеве");
  if (/чия\s+бэлеш/.test(value)) return direct("Десерты", "Чия бэлеш");
  if (/итле/.test(value)) return direct("Салаты", "Итле");
  if (/тэмле\s+урд/.test(value)) return direct("Салаты", "Тэмле Урдэк");
  if (/урд.*олив/.test(value)) return direct("Салаты", "Урдэк Оливьесы");
  if (/^язлы$/.test(value)) return direct("Салаты", "Язлы");
  if (/^биляр$/.test(value)) return direct("Салаты", "Биляр");
  if (/^кызыл$/.test(value)) return direct("Салаты", "Кызыл");
  if (/татлы.*баклаж/.test(value)) return direct("Салаты", "Татлы баклажан салаты");
  if (/туган\s+авылым/.test(value)) return direct("Салаты", "Туган Авылым");
  if (/урман\s+бул/.test(value)) return direct("Закуски", "Урман бүләге");
  if (/казлык|каздык|казылык/.test(value)) return direct("Закуски", "Казылык");
  if (/ханское\s+пир/.test(value)) return direct("Закуски", "Ханское пиршество");
  if (/тэмле\s+балык/.test(value)) return direct("Рыбные блюда", "Тэмле балык");
  if (/шашл.*кур|люля.*кур/.test(value)) return direct("Блюда на углях", "Шашлык из курицы");
  if (/шашл.*кон/.test(value)) return direct("Блюда на углях", "Шашлык из конины");
  if (/ассорти/.test(value)) return direct("Блюда на углях", "Ассорти из шашлыков");
  if (/карт.*дерев|деревенск.*карт/.test(value)) return direct("Гарниры", "Картофель по-деревенски");
  if (/фри/.test(value)) return direct("Гарниры", "Картофель фри");
  if (/сырн/.test(value)) return direct("Соусы", "Сырный соус");
  if (/чесночн/.test(value)) return direct("Соусы", "Чесночный соус");
  if (/морс.*смород|смородин/.test(value)) return direct("Прохладительные напитки", "Морс смородиновый");
  if (/морс.*клюк|клюкв/.test(value)) return direct("Прохладительные напитки", "Морс клюквенный");
  if (/^морс$/.test(value)) return direct("Прохладительные напитки", "Морс смородиновый");
  if (/рич.*апельс|сок.*рич/.test(value)) return direct("Напитки Rich", "Сок Rich");
  if (/кола.*(зеро|без\s+сахара)/.test(value)) return direct("Напитки Rich", "Кола без сахара");
  if (/^вода$|без\s+газа/.test(value)) return direct("Минеральная вода", "Волжанка с газом/без газа");
  if (/рислинг/.test(value)) return direct("Белое вино", "Рислинг Урбанихоф");
  if (/джони.*вокер|johnny\s+walker/.test(value)) return direct("Виски", "Johnnie Walker Red Label");
  if (/страк.*пш|psenice/.test(value)) return direct("Разливное пиво", "Strakovice Psenice / Страковице Пшеничное");
  if (/страк.*эль|pale\s+ale/.test(value)) return direct("Разливное пиво", "Strakovice Pale Ale / Страковице Светлый Эль");
  if (/страк.*фильтр/.test(value)) return direct("Бутылочное пиво", "Белый Кремль светлое фильтрованное");
  if (/мандарин/.test(value)) return direct("Настойки", "Настойка Мандарин");
  if (/брусник/.test(value)) return direct("Настойки", "Настойка Брусника");
  if (/облепихов/.test(value)) return direct("Чайные композиции", "Облепиховый со специями");
  if (/малина.*смород|смород.*малина/.test(value)) return direct("Чайные композиции", "Малиново-смородиновый");
  if (/^облепиха$/.test(value)) return direct("Настойки", "Настойка Облепиха");
  if (/малина.*ревень/.test(value)) return direct("Лимонады", "Малина-ревень");
  if (/мохито/.test(value)) return direct("Безалкогольные коктейли", "Мохито безалкогольный", (v) => /без\s*алк/.test(v));
  if (/мохито/.test(value)) return direct("Алкогольные коктейли", "Мохито");

  const exact = dishes.find((dish) => normalize(dish.name) === value);
  if (exact) return exact;
  const contained = dishes
    .map((dish) => ({ dish, score: normalize(dish.name).split(" ").filter((word) => value.includes(word)).length }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score);
  return contained[0]?.dish ?? null;
}

function lineItems(line, dishes) {
  const { quantity, clean, note } = quantityAndText(line);
  const normalized = normalize(clean);
  if (!normalized) return [];

  if (/^(?:настойк|нас\s*ойк).*(все|кажд)/.test(normalized)) {
    return dishes.filter((dish) => normalize(dish.category_name) === normalize("Настойки"))
      .map((dish) => ({ dish, quantity: 1, note: note || "каждого" }));
  }
  const dish = aliasMatch(clean, dishes);
  return dish ? [{ dish, quantity, note }] : [{ raw: clean, quantity, note }];
}

export function parseOrder(text, dishes) {
  const items = String(text ?? "")
    .replace(/\r/g, "")
    .split(/\n|\\/u)
    .map((line) => line.replace(/^\s*\[[^\]]+\]\s*[^:]+:\s*/u, "").trim())
    .filter(Boolean)
    .flatMap((line) => lineItems(line, dishes));

  const groups = new Map();
  const unknown = [];
  for (const item of items) {
    if (!item.dish) {
      unknown.push(item);
      continue;
    }
    const key = item.dish.category_name;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return { groups, unknown };
}

function formatOrder(result) {
  const lines = ["🧾 <b>Заказ по разделам</b>", ""];
  const orderedGroups = [...result.groups.entries()].sort((left, right) => {
    const leftIndex = CATEGORY_ORDER.indexOf(left[0]);
    const rightIndex = CATEGORY_ORDER.indexOf(right[0]);
    return (leftIndex < 0 ? 999 : leftIndex) - (rightIndex < 0 ? 999 : rightIndex);
  });
  for (const [category, items] of orderedGroups) {
    lines.push(`<b>${escapeHtml(category)}</b>`);
    for (const item of items) {
      const quantity = item.quantity > 1 ? `${item.quantity} × ` : "";
      const note = item.note ? ` <i>(${escapeHtml(item.note)})</i>` : "";
      lines.push(`• ${quantity}${escapeHtml(item.dish.name)}${note}`);
    }
    lines.push("");
  }
  if (result.unknown.length) {
    lines.push("❓ <b>Не найдено в актуальном меню</b>");
    for (const item of result.unknown) {
      const quantity = item.quantity > 1 ? `${item.quantity} × ` : "";
      lines.push(`• ${quantity}${escapeHtml(item.raw)}${item.note ? ` (${escapeHtml(item.note)})` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

export async function handleOwnerOrderMessage(message, env) {
  if (!message.text?.trim() || message.text.trim().startsWith("/")) return false;
  const result = await env.DB.prepare(`
    SELECT d.name, d.category_id, c.name AS category_name, c.menu_type
    FROM dishes d JOIN categories c ON c.id = d.category_id
    WHERE d.active = 1
    ORDER BY c.sort_order, d.sort_order, d.id
  `).all();
  const parsed = parseOrder(message.text, result.results ?? []);
  if (!parsed.groups.size && !parsed.unknown.length) return false;
  await sendMessage(env, message.chat.id, formatOrder(parsed));
  return true;
}
