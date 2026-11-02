import type { GameIdTable, GameIdText } from "../../data/game-ids/types";

export const createGameIdTable = (): GameIdTable => ({
  skills: {},
  items: {},
  legendaries: {},
  modifiers: {},
  talents: {},
  traits: {},
  memoryBaseStats: [],
});

const decode = (s: string): string =>
  s
    .replace(/&ndash;/g, "–")
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

const strip = (html: string): string =>
  decode(html.replace(/<br\s*\/?>/g, "\n").replace(/<[^>]+>/g, ""))
    .replace(/[ \t]+/g, " ")
    .trim();

const toText = (html: string): GameIdText => {
  const args: string[] = [];
  const marked = html.replace(
    /<span class="text-mod">([^<]*)<\/span>/g,
    (_, inner: string) => {
      const raw = decode(inner);
      args.push(raw);
      return raw.startsWith("+") ? "+#" : "#";
    },
  );
  return { template: strip(marked), args };
};

// Returns the HTML inside a span opened just before start, tracking nested spans.
const spanBody = (html: string, start: number): string => {
  let depth = 1;
  const re = /<\/?span\b[^>]*>/g;
  re.lastIndex = start;
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index);
  }
  return "";
};

// A talent's first attr block is its real node; later ones are Prophecy variants.
const firstAttrBody = (html: string, from: number): string => {
  const marker = 'data-source="attr">';
  const at = html.indexOf(marker, from);
  if (at < 0) return "";
  return html.slice(at + marker.length, html.indexOf("</div>", at));
};

// Returns how many modifier IDs came with different text than the first page that listed them.
export const scanPage = (
  table: GameIdTable,
  page: { name: string; html: string; isSkill: boolean },
): number => {
  const { name, html } = page;
  let conflicts = 0;

  for (const m of html.matchAll(/<span data-modifier-id="(\d+)">/g)) {
    const entry = toText(spanBody(html, m.index + m[0].length));
    const old = table.modifiers[m[1]];
    if (old === undefined) table.modifiers[m[1]] = entry;
    else if (old.template !== entry.template) conflicts += 1;
  }
  for (const m of html.matchAll(
    /<span class="talent-node-name" data-talent-id="(\d+)">([^<]*)<\/span>/g,
  )) {
    table.talents[m[1]] = {
      name: decode(m[2]),
      tree: name,
      text: strip(firstAttrBody(html, m.index)),
    };
  }
  for (const m of html.matchAll(
    /<span data-id="(\d+)">([^<]*)<\/span><span><a href="([^"]+)"/g,
  )) {
    if (table.talents[m[1]] !== undefined) continue;
    table.talents[m[1]] = {
      name: decode(m[2]),
      tree: m[3],
      text: strip(firstAttrBody(html, m.index)),
    };
  }
  for (const m of html.matchAll(
    /<div class="fw-bold" data-id="(\d+)">([^<]*)<\/div>(?:Require lv (\d+))?/g,
  )) {
    table.traits[m[1]] = {
      name: decode(m[2]),
      level: m[3] === undefined ? 1 : Number(m[3]),
    };
  }
  // Slate lists give each variant's ID in its hover link. ItemGold links are legendaries, whose numbers overlap base items.
  for (const m of html.matchAll(
    /data-hover="\?s=ItemBase%2F(\d+)"[^>]*href="[^"]+"[^>]*>([^<]+)</g,
  )) {
    if (table.items[m[1]] === undefined) {
      table.items[m[1]] = { name: decode(m[2]).trim() };
    }
  }

  const title = decode(
    html.match(/<h1[^>]*>([^<]*)/)?.[1]?.trim() ?? name.replace(/_/g, " "),
  );
  const id = html.match(/<div>id:\s*(\d+)<\/div>/)?.[1];
  if (id !== undefined) {
    const group = page.isSkill ? table.skills : table.items;
    if (group[id] === undefined) group[id] = { name: title };
  }
  const legendary = html.match(/<li>id:\s*(\d+)<\/li>/)?.[1];
  if (legendary !== undefined) table.legendaries[legendary] = { name: title };
  return conflicts;
};

// The middle digits of a memory base stat's ID follow the order of this tab.
export const scanMemoryBaseStats = (
  table: GameIdTable,
  memoryPageHtml: string,
): void => {
  const tab = memoryPageHtml.slice(
    memoryPageHtml.indexOf('id="BaseStats"'),
    memoryPageHtml.indexOf('id="FixedAffix"'),
  );
  const seen = new Map<string, GameIdText>();
  for (const m of tab.matchAll(/<span data-modifier-id="\d+">/g)) {
    const entry = toText(spanBody(tab, m.index + m[0].length));
    if (!seen.has(entry.template)) seen.set(entry.template, entry);
  }
  table.memoryBaseStats = [...seen.values()];
};

// Linked item pages on a list page, which are the only pages that state a gear base's ID.
export const linkedItemPages = (html: string): string[] => [
  ...new Set(
    [
      ...html.matchAll(
        /<a\b[^>]*\bdata-hover="[^"]*"[^>]*\bhref="([A-Z][^"]*)"/g,
      ),
    ].map((m) => m[1]),
  ),
];

export const pageFileName = (name: string): string =>
  `${name.replace(/[^A-Za-z0-9_-]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}.html`;
