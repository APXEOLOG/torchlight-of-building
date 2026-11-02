import { execSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as cheerio from "cheerio";
import { program } from "commander";
import type {
  Legendary,
  LegendaryAffix,
  LegendaryAffixChoice,
} from "../data/legendary/types";
import type { EquipmentSlot, EquipmentType } from "../tli/gear-data-types";
import { LegendaryDataOverrides } from "./legendaries/legendary-data-overrides";
import {
  EQUIPMENT_TYPE_PAGES,
  fetchGearTypePages,
  fetchPage,
  GEAR_TYPE_DIR,
  processInBatches,
  toSnakeCase,
} from "./tlidb-tools";

const CURRENT_SEASON = "SS14Season";

// ============================================================================
// Fetching
// ============================================================================

const BASE_URL = "https://tlidb.com/en";
const LEGENDARY_GEAR_DIR = join(
  process.cwd(),
  ".garbage",
  "tlidb",
  "en",
  "legendary_gear",
);

/** Extract legendary gear links from a gear type page's #LegendaryGear tab */
const extractLegendaryLinksFromGearPage = (
  html: string,
): { href: string; name: string }[] => {
  const $ = cheerio.load(html);
  const links: { href: string; name: string }[] = [];
  const seen = new Set<string>();

  // The icon links in this tab have no text, so only the named links count
  $("#LegendaryGear a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const name = $(el).text().trim();

    if (
      href !== "" &&
      name !== "" &&
      !href.startsWith("http") &&
      !href.startsWith("#") &&
      !href.startsWith("/") &&
      !seen.has(href)
    ) {
      seen.add(href);
      links.push({ href, name });
    }
  });

  return links;
};

const fetchLegendaryPages = async (): Promise<void> => {
  await mkdir(LEGENDARY_GEAR_DIR, { recursive: true });

  // Step 1: Fetch all gear type pages
  await fetchGearTypePages();

  // Step 2: Collect all legendary links from gear type pages
  console.log("\nCollecting legendary links from gear type pages...");
  const allLegendaryLinks = new Map<string, { href: string; name: string }>();

  for (const pageName of Object.keys(EQUIPMENT_TYPE_PAGES)) {
    const snakeCaseName = toSnakeCase(pageName);
    const filepath = join(GEAR_TYPE_DIR, `${snakeCaseName}.html`);

    try {
      const html = await readFile(filepath, "utf-8");
      const links = extractLegendaryLinksFromGearPage(html);

      for (const link of links) {
        if (!allLegendaryLinks.has(link.href)) {
          allLegendaryLinks.set(link.href, link);
        }
      }

      if (links.length > 0) {
        console.log(`  ${pageName}: ${links.length} legendaries`);
      }
    } catch (error) {
      console.error(`Error reading ${pageName}:`, error);
    }
  }

  const legendaryLinks = Array.from(allLegendaryLinks.values());
  console.log(`\nFound ${legendaryLinks.length} unique legendary links`);

  if (legendaryLinks.length === 0) {
    throw new Error("No legendary gear links found. Check the page structure.");
  }

  // Step 3: Fetch each legendary's individual page
  console.log(`Fetching ${legendaryLinks.length} legendary pages...`);

  await processInBatches(legendaryLinks, async ({ href, name }) => {
    const snakeCaseName = toSnakeCase(name);
    const filename = `${snakeCaseName}.html`;
    const filepath = join(LEGENDARY_GEAR_DIR, filename);

    try {
      const decodedHref = decodeURIComponent(href);
      const url = `${BASE_URL}/${encodeURIComponent(decodedHref)}`;
      const html = await fetchPage(url);
      await writeFile(filepath, html);
      console.log(`Saved: ${filepath}`);
    } catch (error) {
      console.error(`Error fetching ${name} (${href}):`, error);
    }
  });

  console.log("Fetching complete!");
};

// ============================================================================
// Parsing
// ============================================================================

const cleanHtmlText = (
  // biome-ignore lint/suspicious/noExplicitAny: cheerio internal type
  elem: cheerio.Cheerio<any>,
  $: cheerio.CheerioAPI,
): string => {
  // Get HTML content and replace <br> with newlines
  let html = $(elem).html() ?? "";
  html = html.replace(/<br\s*\/?>/gi, "\n");

  // Load into cheerio to get text content (strips remaining HTML)
  let text = cheerio.load(html).text();

  // Replace en-dash with regular hyphen
  text = text.replace(/\u2013/g, "-");

  // Normalize whitespace per line, filter empty lines
  return text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
};

interface AffixChoiceCard {
  descriptor: string;
  isCorroded: boolean;
  choices: string[];
}

/**
 * Extracts affix choice cards from the HTML.
 * These are cards with headers like "<Random stat affix>" or "<Random stat affix>Corroded"
 */
const extractAffixChoiceCards = (
  $: cheerio.CheerioAPI,
): Map<string, AffixChoiceCard> => {
  const choiceCards = new Map<string, AffixChoiceCard>();

  // Find h5.card-header elements with the golden color style
  $('h5.card-header[style*="color: #ffc130"]').each((_, header) => {
    const $header = $(header);
    const headerText = $header.text().trim();

    // Check if the header text starts and ends with angle brackets (possibly with "Corroded" suffix)
    const corrodedSuffix = "Corroded";
    const isCorroded = headerText.endsWith(corrodedSuffix);

    // Extract the descriptor without angle brackets and optional Corroded suffix
    let descriptor = headerText;
    if (isCorroded) {
      descriptor = descriptor.slice(0, -corrodedSuffix.length);
    }

    // Check if it has angle brackets
    if (!descriptor.startsWith("<") || !descriptor.endsWith(">")) {
      return;
    }

    // Remove angle brackets to get the descriptor
    descriptor = descriptor.slice(1, -1);

    // Get the choices from the card body
    const $card = $header.closest(".card");
    const choices: string[] = [];

    $card.find(".card-body li").each((_, li) => {
      const choice = cleanHtmlText($(li), $);
      if (choice) {
        choices.push(choice);
      }
    });

    // Create a unique key that includes corroded status
    const key = isCorroded ? `${descriptor}:corroded` : `${descriptor}:normal`;

    choiceCards.set(key, { descriptor, isCorroded, choices });
  });

  return choiceCards;
};

/** Legendary data extracted from tlidb (without equipment slot/type) */
interface TlidbLegendary {
  name: string;
  baseItem: string;
  baseStat: string;
  normalAffixes: LegendaryAffix[];
  corruptionAffixes: LegendaryAffix[];
}

/**
 * Converts an affix text to a LegendaryAffix (string or LegendaryAffixChoice).
 * If the text is enclosed in angle brackets, it looks up the corresponding choice card.
 */
const parseAffix = (
  affixText: string,
  choiceCards: Map<string, AffixChoiceCard>,
  isCorroded: boolean,
): LegendaryAffix => {
  // Check if affix is enclosed in angle brackets like <Random stat affix>
  if (affixText.startsWith("<") && affixText.endsWith(">")) {
    const descriptor = affixText.slice(1, -1);
    const key = isCorroded ? `${descriptor}:corroded` : `${descriptor}:normal`;
    const choiceCard = choiceCards.get(key);

    if (choiceCard !== undefined) {
      const result: LegendaryAffixChoice = {
        choiceDescriptor: descriptor,
        choices: choiceCard.choices,
      };
      return result;
    }

    // If no choice card found, still return a LegendaryAffixChoice with empty choices
    const result: LegendaryAffixChoice = {
      choiceDescriptor: descriptor,
      choices: [],
    };
    return result;
  }

  return affixText;
};

// biome-ignore lint/suspicious/noExplicitAny: cheerio internal type
type CheerioCard = cheerio.Cheerio<any>;

const extractNormalAffixes = (
  card: CheerioCard,
  $: cheerio.CheerioAPI,
  choiceCards: Map<string, AffixChoiceCard>,
): LegendaryAffix[] => {
  const affixes: LegendaryAffix[] = [];
  card.find(".tierParent > div").each((_, el) => {
    const affixText = cleanHtmlText($(el), $);
    if (affixText) {
      affixes.push(parseAffix(affixText, choiceCards, false));
    }
  });
  return affixes;
};

const extractLegendary = (
  $: cheerio.CheerioAPI,
  filename: string,
  choiceCards: Map<string, AffixChoiceCard>,
): TlidbLegendary | undefined => {
  // Find the current season card
  let seasonCard: CheerioCard | undefined;

  $(".card.ui_item").each((_, card) => {
    const $card = $(card);
    const itemVer = $card.find(".item_ver").text().trim();
    if (itemVer === CURRENT_SEASON && !$card.hasClass("previousItem")) {
      seasonCard = $card;
    }
  });

  if (seasonCard === undefined) {
    console.log(`  Skipping ${filename}: No ${CURRENT_SEASON} card found`);
    return undefined;
  }

  const mainCard = seasonCard;
  const normalAffixes = extractNormalAffixes(mainCard, $, choiceCards);

  // Extract name
  const name = mainCard.find("h5.card-title.item_rarity").text().trim();

  // Extract baseStat - includes attrs2 plus any sibling div.text-center before the hr
  const attrs2 = mainCard.find('div[data-block="attrs2"]');
  let baseStat = cleanHtmlText(attrs2, $);

  // Look for additional base stat divs that come after attrs2 but before the hr
  // These are div.text-center elements without data-block attribute
  let nextElem = attrs2.next();
  while (nextElem.length > 0) {
    const tagName = nextElem.prop("tagName")?.toLowerCase();
    // Stop at hr or any non-div element
    if (tagName === "hr" || tagName !== "div") {
      break;
    }
    // Only include div.text-center without data-block attribute
    if (
      nextElem.hasClass("text-center") &&
      nextElem.attr("data-block") === undefined
    ) {
      const extraStat = cleanHtmlText(nextElem, $);
      if (extraStat) {
        baseStat = baseStat ? `${baseStat}\n${extraStat}` : extraStat;
      }
    }
    nextElem = nextElem.next();
  }

  // Find the Corroded card
  // biome-ignore lint/suspicious/noExplicitAny: cheerio internal type
  let corrodedCard: cheerio.Cheerio<any> | undefined;
  $(".card.ui_item").each((_, card) => {
    const $card = $(card);
    const header = $card.find(".card-header").text().trim();
    if (header === "Corroded") {
      corrodedCard = $card;
      return false; // break loop
    }
  });

  // Extract corruption affixes (div.t0)
  const corruptionAffixes: LegendaryAffix[] = [];
  if (corrodedCard !== undefined) {
    corrodedCard.find(".tierParent > div").each((_, el) => {
      const affixText = cleanHtmlText($(el), $);
      if (affixText) {
        corruptionAffixes.push(parseAffix(affixText, choiceCards, true));
      }
    });
  }

  // Find the Info card and extract baseItem
  let baseItem = "";
  $(".card.ui_item").each((_, card) => {
    const $card = $(card);
    const header = $card.find(".card-header").text().trim();
    if (header === "Info") {
      // Find the Base: line and get the <a> text
      $card.find(".card-body li").each((_, li) => {
        const $li = $(li);
        const text = $li.text();
        if (text.startsWith("Base:")) {
          baseItem = $li.find("a").text().trim();
          return false; // break inner loop
        }
      });
      return false; // break outer loop
    }
  });

  // Skip items without a base item (like Divinity Slates)
  if (!baseItem) {
    console.log(`  Skipping ${filename}: No baseItem found`);
    return undefined;
  }

  return { baseItem, baseStat, name, normalAffixes, corruptionAffixes };
};

// ============================================================================
// Equipment type mapping from gear type pages
// ============================================================================

/**
 * Builds a map from legendary name → equipment info by reading gear type pages
 * and extracting legendary links from each one.
 */
const buildEquipmentMap = async (): Promise<
  Map<string, { equipmentSlot: EquipmentSlot; equipmentType: EquipmentType }>
> => {
  const equipmentMap = new Map<
    string,
    { equipmentSlot: EquipmentSlot; equipmentType: EquipmentType }
  >();

  for (const [pageName, info] of Object.entries(EQUIPMENT_TYPE_PAGES)) {
    const snakeCaseName = toSnakeCase(pageName);
    const filepath = join(GEAR_TYPE_DIR, `${snakeCaseName}.html`);

    try {
      const html = await readFile(filepath, "utf-8");
      const links = extractLegendaryLinksFromGearPage(html);

      for (const link of links) {
        equipmentMap.set(link.name, {
          equipmentSlot: info.slot,
          equipmentType: info.type,
        });
      }
    } catch {
      // Gear type page not cached yet - skip
    }
  }

  return equipmentMap;
};

// ============================================================================
// Output
// ============================================================================

const applyOverrides = (legendaries: Legendary[]): Legendary[] => {
  // Create a map for efficient lookup
  const legendaryMap = new Map(legendaries.map((l) => [l.name, l]));

  // Apply overrides
  for (const [name, override] of Object.entries(LegendaryDataOverrides)) {
    if (override === undefined) {
      // Remove legendary if it exists
      if (legendaryMap.delete(name)) {
        console.log(`  Override: Removed "${name}"`);
      }
    } else {
      // Validate that key matches the name property
      if (override.name !== name) {
        throw new Error(
          `Override key "${name}" does not match legendary name "${override.name}"`,
        );
      }
      // Upsert legendary
      const action = legendaryMap.has(name) ? "Replaced" : "Added";
      legendaryMap.set(name, override);
      console.log(`  Override: ${action} "${name}"`);
    }
  }

  return Array.from(legendaryMap.values());
};

const generateDataFile = (items: Legendary[]): string => {
  return `// This file is machine-generated. Do not modify manually.
// To regenerate, run: pnpm exec tsx src/scripts/generate-legendary-data.ts
import type { Legendary } from "./types";

export const Legendaries: readonly Legendary[] = ${JSON.stringify(items)};
`;
};

interface Options {
  refetch: boolean;
}

const main = async (options: Options): Promise<void> => {
  if (options.refetch) {
    console.log("Refetching pages from tlidb...\n");
    await fetchLegendaryPages();
    console.log("");
  }

  const outDir = join(process.cwd(), "src", "data", "legendary");

  // Step 1: Build equipment slot/type mapping from gear type pages
  console.log("Building equipment info from gear type pages...");
  const equipmentMap = await buildEquipmentMap();
  console.log(`Found equipment info for ${equipmentMap.size} legendaries`);

  // Step 2: Read tlidb legendary files
  console.log("Reading HTML files from:", LEGENDARY_GEAR_DIR);
  const files = await readdir(LEGENDARY_GEAR_DIR);
  const htmlFiles = files.filter((f) => f.endsWith(".html"));
  console.log(`Found ${htmlFiles.length} HTML files`);

  const legendaries: Legendary[] = [];
  let skippedCount = 0;

  for (const filename of htmlFiles) {
    const filepath = join(LEGENDARY_GEAR_DIR, filename);
    const html = await readFile(filepath, "utf-8");
    const $ = cheerio.load(html);

    // Extract choice cards first
    const choiceCards = extractAffixChoiceCards($);

    const tlidbData = extractLegendary($, filename, choiceCards);
    if (tlidbData === undefined) {
      continue;
    }

    // Step 3: Merge with equipment data from gear type pages
    const equipmentInfo = equipmentMap.get(tlidbData.name);
    if (equipmentInfo === undefined) {
      console.warn(`No equipment data found for: ${tlidbData.name} - skipping`);
      skippedCount++;
      continue;
    }

    legendaries.push({
      ...tlidbData,
      equipmentSlot: equipmentInfo.equipmentSlot,
      equipmentType: equipmentInfo.equipmentType,
    });
  }

  console.log(
    `Extracted ${legendaries.length} legendaries (skipped ${skippedCount} without equipment data)`,
  );

  // Apply manual overrides
  console.log("Applying overrides...");
  const finalLegendaries = applyOverrides(legendaries);

  // Sort by name for consistent output
  finalLegendaries.sort((a, b) => a.name.localeCompare(b.name));

  console.log(`Final count: ${finalLegendaries.length} legendaries`);

  await mkdir(outDir, { recursive: true });

  const dataPath = join(outDir, "legendaries.ts");
  await writeFile(dataPath, generateDataFile(finalLegendaries), "utf-8");
  console.log(`Generated legendaries.ts`);

  console.log("\nCode generation complete!");
  execSync("pnpm format", { stdio: "inherit" });
};

program
  .description("Generate legendary data from cached HTML pages")
  .option("--refetch", "Refetch HTML pages from tlidb before generating")
  .action((options: Options) => {
    main(options)
      .then(() => process.exit(0))
      .catch((error) => {
        console.error("Script failed:", error);
        process.exit(1);
      });
  })
  .parse();
