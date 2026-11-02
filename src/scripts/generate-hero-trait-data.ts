import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import * as cheerio from "cheerio";
import type { BaseHeroTrait } from "../data/hero-trait/types";

const BASE_URL = "https://tlidb.com/en";
const HERO_LIST_URL = `${BASE_URL}/Hero`;
const CACHE_DIR = join(process.cwd(), ".garbage", "tlidb", "hero-trait");
const EXPECTED_TRAIT_COUNT = 25;

// ============================================================================
// Fetching
// ============================================================================

const fetchPage = async (url: string): Promise<string> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.text();
};

interface HeroTraitLink {
  href: string;
  heroClass: string;
  heroName: string;
  traitVariant: string;
}

const extractHeroTraitLinks = (html: string): HeroTraitLink[] => {
  const $ = cheerio.load(html);
  const links: HeroTraitLink[] = [];
  const seen = new Set<string>();

  // Each hero entry is in a div.col with an anchor linking to the trait page
  // The text is like "Berserker Rehan | Anger"
  const tab = $("#Hero");
  tab.find("div.col div.flex-grow-1 > a").each((_, el) => {
    const href = $(el).attr("href");
    const text = $(el).text().trim();
    if (href === undefined || text.length === 0) return;
    if (seen.has(href)) return;
    seen.add(href);

    // Parse "HeroClass HeroName | TraitVariant" or "HeroClass HeroName|TraitVariant"
    const pipeIndex = text.indexOf("|");
    if (pipeIndex === -1) return;

    const heroFull = text.slice(0, pipeIndex).trim();
    const traitVariant = text.slice(pipeIndex + 1).trim();

    // Split hero into class and name (e.g., "Berserker Rehan" → "Berserker", "Rehan")
    const spaceIndex = heroFull.indexOf(" ");
    if (spaceIndex === -1) return;

    const heroClass = heroFull.slice(0, spaceIndex);
    const heroName = heroFull.slice(spaceIndex + 1);

    links.push({ href, heroClass, heroName, traitVariant });
  });

  return links;
};

const runWithConcurrency = async <T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> => {
  const results: T[] = [];
  let index = 0;

  const runNext = async (): Promise<void> => {
    while (index < tasks.length) {
      const currentIndex = index;
      index++;
      const task = tasks[currentIndex];
      if (task !== undefined) {
        results[currentIndex] = await task();
      }
    }
  };

  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    runNext,
  );
  await Promise.all(workers);
  return results;
};

const fetchHeroTraitPages = async (): Promise<void> => {
  await mkdir(CACHE_DIR, { recursive: true });

  console.log("Fetching hero list page...");
  const listHtml = await fetchPage(HERO_LIST_URL);
  const links = extractHeroTraitLinks(listHtml);
  console.log(
    `Found ${links.length} hero trait pages (expected: ${EXPECTED_TRAIT_COUNT})`,
  );

  if (links.length !== EXPECTED_TRAIT_COUNT) {
    console.warn(
      `Warning: Count mismatch: found ${links.length}, expected ${EXPECTED_TRAIT_COUNT}`,
    );
  }

  let completed = 0;
  const fetchTasks = links.map((link) => async (): Promise<void> => {
    const decodedHref = decodeURIComponent(link.href);
    const url = `${BASE_URL}/${encodeURIComponent(decodedHref)}`;
    const filepath = join(CACHE_DIR, `${decodedHref}.html`);

    try {
      const html = await fetchPage(url);
      await writeFile(filepath, html);
      completed++;
      if (completed % 10 === 0 || completed === links.length) {
        console.log(`Progress: ${completed}/${links.length} pages fetched`);
      }
    } catch (error) {
      console.error(`Error fetching ${decodedHref}:`, error);
    }
  });

  console.log("Fetching with concurrency of 5...");
  await runWithConcurrency(fetchTasks, 5);
  console.log(`Fetched ${completed} hero trait pages`);
};

// ============================================================================
// Parsing
// ============================================================================

const cleanAffixHtml = (html: string): string => {
  const $ = cheerio.load(html, null, false);

  // Replace <e> hyperlink elements with their text content
  $("e").each((_, el) => {
    $(el).replaceWith($(el).text());
  });

  // Replace <span class="text-mod"> with their text content
  $("span.text-mod").each((_, el) => {
    $(el).replaceWith($(el).text());
  });

  // Get cleaned HTML then strip remaining tags
  let text = $.html();

  // Replace <br> tags with newlines
  text = text.replace(/<br\s*\/?>/gi, "\n");

  // Remove all remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode HTML entities
  text = text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ");

  // Convert en-dash to hyphen
  text = text.replace(/\u2013/g, "-");

  // Trim each line and remove empty lines
  return text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
};

const NUMBER = /[+-]?\d+(?:\.\d+)?/g;

// Writes numbers that vary by level as "(+10/+16/+22/+28/+34)". Text that differs in more than its numbers stays per level.
const mergeLevelTexts = (levelTexts: string[]): string => {
  const first = levelTexts[0];
  if (first === undefined) return "";
  const shape = first.replace(NUMBER, "#");
  if (levelTexts.some((text) => text.replace(NUMBER, "#") !== shape)) {
    return levelTexts.map((text, i) => `Level ${i + 1}${text}`).join("\n");
  }
  const numbers = levelTexts.map((text) => text.match(NUMBER) ?? []);
  let n = -1;
  return first.replace(NUMBER, (number) => {
    n++;
    const values = numbers.map((row) => row[n]);
    return values.every((value) => value === number)
      ? number
      : `(${values.join("/")})`;
  });
};

interface TlidbHeroTraitFile {
  fileName: string;
  html: string;
}

const readCachedHeroTraitFiles = async (): Promise<TlidbHeroTraitFile[]> => {
  const files = await readdir(CACHE_DIR);
  const htmlFiles = files.filter((f) => f.endsWith(".html"));

  return Promise.all(
    htmlFiles.map(async (fileName) => ({
      fileName: basename(fileName, ".html"),
      html: await readFile(join(CACHE_DIR, fileName), "utf-8"),
    })),
  );
};

const extractTraitsFromPage = (
  html: string,
  heroLabel: string,
): BaseHeroTrait[] => {
  const $ = cheerio.load(html);
  const traits: BaseHeroTrait[] = [];

  // Traits are in div.col > div.d-flex > div.flex-grow-1
  // Each contains: div.fw-bold (name), "Require lv N" text, <hr/>, div (affix HTML)
  const traitContainers = $("div.col div.flex-grow-1.mx-2.my-1");

  traitContainers.each((_, container) => {
    const nameEl = $(container).find("div.fw-bold").first();
    const name = nameEl.text().trim();
    if (name.length === 0) return;

    // Get the text content after the name div, before the <hr>
    // The "Require lv N" is a text node between the name div and the hr
    const fullText = $(container).text();
    const levelMatch = fullText.match(/Require lv (\d+)/);
    if (levelMatch === null || levelMatch[1] === undefined) return;

    const level = parseInt(levelMatch[1], 10);
    if (Number.isNaN(level)) return;

    // Each level has its own block of the full affix text
    const levelTexts = $(container)
      .find('[data-tier-content] [data-src="affix"]')
      .map((_, el) => cleanAffixHtml($(el).html() ?? ""))
      .get();
    const affix = mergeLevelTexts(levelTexts);
    if (affix.length === 0) return;

    traits.push({ hero: heroLabel, name, level, affix });
  });

  return traits;
};

// ============================================================================
// Hero label building
// ============================================================================

// Build the hero label in the existing format: "HeroClass HeroName: TraitVariant (#N)"
// The number is the variant index per hero (1-based, ordered by appearance on the list page)
const buildHeroLabels = (links: HeroTraitLink[]): Map<string, string> => {
  const heroVariantCounts = new Map<string, number>();
  const result = new Map<string, string>();

  for (const link of links) {
    const heroKey = `${link.heroClass} ${link.heroName}`;
    const count = (heroVariantCounts.get(heroKey) ?? 0) + 1;
    heroVariantCounts.set(heroKey, count);

    const decodedHref = decodeURIComponent(link.href);
    const label = `${heroKey}: ${link.traitVariant} (#${count})`;
    result.set(decodedHref, label);
  }

  return result;
};

// ============================================================================
// Code generation
// ============================================================================

const generateHeroTraitsFile = (traits: BaseHeroTrait[]): string => {
  return `// This file is machine-generated. Do not modify manually.
// To regenerate, run: pnpm exec tsx src/scripts/generate-hero-trait-data.ts
import type { BaseHeroTrait } from "./types";

export const HeroTraits = ${JSON.stringify(traits)} as const satisfies readonly BaseHeroTrait[];
`;
};

const main = async (): Promise<void> => {
  const refetch = process.argv.includes("--refetch");

  if (refetch || !existsSync(CACHE_DIR)) {
    console.log("Fetching hero trait pages from tlidb...\n");
    await fetchHeroTraitPages();
    console.log("");
  }

  // Always re-read the list page to get hero labels (needed for ordering/naming)
  console.log("Fetching hero list page for labels...");
  const listHtml = await fetchPage(HERO_LIST_URL);
  const links = extractHeroTraitLinks(listHtml);
  const heroLabels = buildHeroLabels(links);

  console.log("Reading cached hero trait HTML files...");
  const files = await readCachedHeroTraitFiles();
  console.log(`Found ${files.length} cached files`);

  console.log("Extracting hero trait data...");
  const allTraits: BaseHeroTrait[] = [];

  // Process in the order from the hero list page to maintain consistent ordering
  for (const link of links) {
    const decodedHref = decodeURIComponent(link.href);
    const file = files.find((f) => f.fileName === decodedHref);
    if (file === undefined) {
      console.warn(`Missing cached file for ${decodedHref}`);
      continue;
    }

    const heroLabel = heroLabels.get(decodedHref);
    if (heroLabel === undefined) {
      console.warn(`Missing hero label for ${decodedHref}`);
      continue;
    }

    const traits = extractTraitsFromPage(file.html, heroLabel);
    if (traits.length === 0) {
      console.warn(`No traits extracted from ${decodedHref}`);
    }
    allTraits.push(...traits);
  }

  console.log(`Extracted ${allTraits.length} hero traits`);

  if (allTraits.length === 0) {
    throw new Error("No hero traits extracted — check HTML structure");
  }

  const outDir = join(process.cwd(), "src", "data", "hero-trait");
  await mkdir(outDir, { recursive: true });

  const heroTraitsPath = join(outDir, "hero-traits.ts");
  await writeFile(heroTraitsPath, generateHeroTraitsFile(allTraits), "utf-8");
  console.log(`Generated hero-traits.ts (${allTraits.length} traits)`);

  console.log("\nCode generation complete!");
  execSync("pnpm format", { stdio: "inherit" });
};

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Script failed:", error);
    process.exit(1);
  });

export { main as generateHeroTraitData };
