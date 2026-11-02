import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EquipmentSlot, EquipmentType } from "../tli/gear-data-types";

/**
 * Mapping from tlidb page name to equipment type and slot.
 * Keys are the URL path segments on tlidb.com (e.g., "STR_Helmet").
 * The snake_case filename is derived via toSnakeCase(pageName) + ".html".
 */
export const EQUIPMENT_TYPE_PAGES: Record<
  string,
  { type: EquipmentType; slot: EquipmentSlot }
> = {
  // One-Handed Weapons
  Scepter: { type: "Scepter", slot: "One-Handed" },
  Wand: { type: "Wand", slot: "One-Handed" },
  Cane: { type: "Cane", slot: "One-Handed" },
  Rod: { type: "Rod", slot: "One-Handed" },
  Cudgel: { type: "Cudgel", slot: "One-Handed" },
  Dagger: { type: "Dagger", slot: "One-Handed" },
  Claw: { type: "Claw", slot: "One-Handed" },
  "One-Handed_Axe": { type: "One-Handed Axe", slot: "One-Handed" },
  "One-Handed_Sword": { type: "One-Handed Sword", slot: "One-Handed" },
  "One-Handed_Hammer": { type: "One-Handed Hammer", slot: "One-Handed" },
  Pistol: { type: "Pistol", slot: "One-Handed" },

  // Two-Handed Weapons
  Tin_Staff: { type: "Tin Staff", slot: "Two-Handed" },
  Bow: { type: "Bow", slot: "Two-Handed" },
  Crossbow: { type: "Crossbow", slot: "Two-Handed" },
  Musket: { type: "Musket", slot: "Two-Handed" },
  Fire_Cannon: { type: "Fire Cannon", slot: "Two-Handed" },
  "Two-Handed_Axe": { type: "Two-Handed Axe", slot: "Two-Handed" },
  "Two-Handed_Sword": { type: "Two-Handed Sword", slot: "Two-Handed" },
  "Two-Handed_Hammer": { type: "Two-Handed Hammer", slot: "Two-Handed" },

  // Armor - STR
  STR_Chest_Armor: { type: "Chest Armor (STR)", slot: "Chest Armor" },
  STR_Boots: { type: "Boots (STR)", slot: "Boots" },
  STR_Gloves: { type: "Gloves (STR)", slot: "Gloves" },
  STR_Helmet: { type: "Helmet (STR)", slot: "Helmet" },

  // Armor - DEX
  DEX_Chest_Armor: { type: "Chest Armor (DEX)", slot: "Chest Armor" },
  DEX_Boots: { type: "Boots (DEX)", slot: "Boots" },
  DEX_Gloves: { type: "Gloves (DEX)", slot: "Gloves" },
  DEX_Helmet: { type: "Helmet (DEX)", slot: "Helmet" },

  // Armor - INT
  INT_Chest_Armor: { type: "Chest Armor (INT)", slot: "Chest Armor" },
  INT_Boots: { type: "Boots (INT)", slot: "Boots" },
  INT_Gloves: { type: "Gloves (INT)", slot: "Gloves" },
  INT_Helmet: { type: "Helmet (INT)", slot: "Helmet" },

  // Shields
  STR_Shield: { type: "Shield (STR)", slot: "Shield" },
  DEX_Shield: { type: "Shield (DEX)", slot: "Shield" },
  INT_Shield: { type: "Shield (INT)", slot: "Shield" },

  // Accessories
  Belt: { type: "Belt", slot: "Trinket" },
  Necklace: { type: "Necklace", slot: "Trinket" },
  Ring: { type: "Ring", slot: "Trinket" },
  Spirit_Ring: { type: "Spirit Ring", slot: "Trinket" },
};

const CONCURRENCY_LIMIT = 10;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const processInBatches = async <T, R>(
  items: T[],
  processor: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += CONCURRENCY_LIMIT) {
    const batch = items.slice(i, i + CONCURRENCY_LIMIT);
    console.log(
      `Processing batch ${Math.floor(i / CONCURRENCY_LIMIT) + 1}/${Math.ceil(items.length / CONCURRENCY_LIMIT)} (${batch.length} items)`,
    );
    const batchResults = await Promise.all(batch.map(processor));
    results.push(...batchResults);
    if (i + CONCURRENCY_LIMIT < items.length) {
      await delay(500);
    }
  }
  return results;
};

export const fetchPage = async (url: string): Promise<string> => {
  console.log(`Fetching: ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.text();
};

export const toSnakeCase = (name: string): string => {
  return name
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
};

const BASE_URL = "https://tlidb.com/en";

export const GEAR_TYPE_DIR = join(process.cwd(), ".garbage", "tlidb", "gear");

export const TOWER_SEQUENCE_PATH = join(
  process.cwd(),
  ".garbage",
  "tlidb",
  "tower_sequence.html",
);

/** Fetches all gear type pages from tlidb and caches them in GEAR_TYPE_DIR */
export const fetchGearTypePages = async (): Promise<void> => {
  await mkdir(GEAR_TYPE_DIR, { recursive: true });

  const gearTypePages = Object.keys(EQUIPMENT_TYPE_PAGES);
  console.log(`Fetching ${gearTypePages.length} gear type pages...`);

  await processInBatches(gearTypePages, async (pageName) => {
    const snakeCaseName = toSnakeCase(pageName);
    const filepath = join(GEAR_TYPE_DIR, `${snakeCaseName}.html`);

    try {
      const url = `${BASE_URL}/${encodeURIComponent(pageName)}`;
      const html = await fetchPage(url);
      await writeFile(filepath, html);
      console.log(`Saved: ${filepath}`);
    } catch (error) {
      console.error(`Error fetching gear type page ${pageName}:`, error);
    }
  });

  await writeFile(
    TOWER_SEQUENCE_PATH,
    await fetchPage(`${BASE_URL}/TOWER_Sequence`),
  );
};

export const extractLegendaryGearLinks = (
  html: string,
): { href: string; name: string }[] => {
  const linkRegex =
    /<a[^>]*data-hover="[^"]*ItemGold[^"]*"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
  const links: { href: string; name: string }[] = [];

  let match: RegExpExecArray | null = linkRegex.exec(html);
  while (match !== null) {
    const href = match[1];
    const name = match[2];

    if (
      href !== undefined &&
      !href.startsWith("http") &&
      !href.startsWith("#") &&
      !href.startsWith("/")
    ) {
      links.push({ href, name });
    }
    match = linkRegex.exec(html);
  }

  const seen = new Set<string>();
  return links.filter((link) => {
    if (seen.has(link.href)) return false;
    seen.add(link.href);
    return true;
  });
};
