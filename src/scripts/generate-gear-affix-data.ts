import { execSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as cheerio from "cheerio";
import { program } from "commander";
import type {
  AffixType,
  CraftingPool,
  EquipmentSlot,
  EquipmentType,
} from "../tli/gear-data-types";
import {
  EQUIPMENT_TYPE_PAGES,
  fetchGearTypePages,
  GEAR_TYPE_DIR,
  TOWER_SEQUENCE_PATH,
  toSnakeCase,
} from "./tlidb-tools";

interface BaseGearAffix {
  equipmentSlot: EquipmentSlot;
  equipmentType: EquipmentType;
  affixType: AffixType;
  craftingPool: CraftingPool;
  tier: string;
  craftableAffix: string;
}

interface BaseGear {
  name: string;
  equipmentSlot: EquipmentSlot;
  equipmentType: EquipmentType;
  stats: string;
}

// Derive filename-keyed map from the shared EQUIPMENT_TYPE_PAGES
const EQUIPMENT_MAP: Record<
  string,
  { type: EquipmentType; slot: EquipmentSlot }
> = Object.fromEntries(
  Object.entries(EQUIPMENT_TYPE_PAGES).map(([pageName, info]) => [
    `${toSnakeCase(pageName)}.html`,
    info,
  ]),
);

// Get section ID prefix from filename (e.g., "scepter.html" -> "Scepter", "str_chest_armor.html" -> "STRChestArmor")
// Note: Some equipment like "one_handed_axe" has section IDs like "#One-HandedAxeBaseAffix" (with hyphen)
const getSectionPrefix = (filename: string): string => {
  const name = filename.replace(".html", "");

  // Special handling for "one_handed" and "two_handed" - they have hyphens in section IDs
  if (name.startsWith("one_handed_") || name.startsWith("two_handed_")) {
    const parts = name.split("_");
    // e.g., ["one", "handed", "axe"] -> "One-HandedAxe"
    const prefix = parts[0].charAt(0).toUpperCase() + parts[0].slice(1); // "One" or "Two"
    const handed = parts[1].charAt(0).toUpperCase() + parts[1].slice(1); // "Handed"
    const weapon = parts
      .slice(2)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join(""); // "Axe", "Sword", "Hammer"
    return `${prefix}-${handed}${weapon}`;
  }

  // Convert snake_case to PascalCase, uppercase stat prefixes
  return name
    .split("_")
    .map((part) => {
      if (["str", "dex", "int"].includes(part)) {
        return part.toUpperCase();
      }
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join("");
};

/**
 * Parses modifier text from an element, handling:
 * - <span class="text-mod"> tags (remove, keep inner text with ndash → hyphen)
 * - <e> hyperlink tags (remove, keep inner text)
 * - <br> tags (convert to newlines)
 * - Various dash characters to regular hyphens
 */
const parseModifierText = (
  // biome-ignore lint/suspicious/noExplicitAny: cheerio internal type
  el: cheerio.Cheerio<any>,
  $: cheerio.CheerioAPI,
): string => {
  const clone = el.clone();

  // Replace <e> hyperlink elements with their text
  clone.find("e").each((_, elem) => {
    $(elem).replaceWith($(elem).text());
  });

  // Remove tooltip icons
  clone.find("i.fa-solid").remove();

  // Replace <br> with placeholder
  let html = clone.html() || "";
  html = html.replace(/<br\s*\/?>/gi, "{NEWLINE}");

  // Parse and extract text
  const processed = cheerio.load(html);
  let text = processed.text();

  // Clean up whitespace
  text = text.replace(/\s+/g, " ").trim();
  text = text.replace(/{NEWLINE}\s*/g, "\n");

  // Normalize dashes
  text = text.replace(/\u2013/g, "-"); // en-dash
  text = text.replace(/\u2014/g, "-"); // em-dash
  text = text.replace(/&ndash;/g, "-");

  return text;
};

/**
 * Extract tier from a marker like: <span class="tier tier1"></span>
 */
const tierOf = (
  // biome-ignore lint/suspicious/noExplicitAny: cheerio internal type
  el: cheerio.Cheerio<any>,
): string =>
  el
    .find(".tier")
    .attr("class")
    ?.match(/tier(\d+)/)?.[1] ?? "";

/**
 * Parse sequences from the shared TOWER Sequence page.
 * The Source column lists the gear types each sequence can roll on, e.g. "Claw, Cane, STR Shield".
 */
const parseSequences = (
  $: cheerio.CheerioAPI,
  equipmentType: EquipmentType,
  slot: EquipmentSlot,
): BaseGearAffix[] => {
  const affixes: BaseGearAffix[] = [];

  $("table tbody tr").each((_, row) => {
    const tds = $(row).find("td");
    if (tds.length < 3) return;

    const types = $(tds[1])
      .text()
      .split(",")
      .map((type) =>
        type.trim().replace(/^(STR|DEX|INT) Shield$/, "Shield ($1)"),
      );
    if (!types.includes(equipmentType)) return;

    affixes.push({
      equipmentSlot: slot,
      equipmentType,
      affixType: "Tower Sequence",
      craftingPool: "",
      tier: tierOf($(tds[0])),
      craftableAffix: parseModifierText($(tds[0]), $),
    });
  });

  return affixes;
};

/**
 * Parse base gear from #Item section
 * Extracts item name and stats from item cards
 */
const parseBaseGear = (
  $: cheerio.CheerioAPI,
  sectionId: string,
  equipmentType: EquipmentType,
  slot: EquipmentSlot,
): BaseGear[] => {
  const items: BaseGear[] = [];
  const section = $(sectionId);
  if (!section.length) return items;

  // Find all item cards
  section.find(".col").each((_, col) => {
    const $col = $(col);

    const statsContainer = $col.find(".flex-grow-1");
    if (!statsContainer.length) return;

    // Extract item name from the <a> tag inside .flex-grow-1
    const nameAnchor = statsContainer.children("a").first();
    const name = nameAnchor.text().trim();
    if (!name) return;

    // Extract base stats - look for divs after the "Require lv X" div
    const statsLines: string[] = [];

    statsContainer.children("div").each((_, div) => {
      const $div = $(div);
      const text = $div.text().trim();

      // Skip require level and empty divs
      if (text.startsWith("Require") || !text) return;

      // Check if this is a stats wrapper div (contains child divs with .text-mod spans)
      const childDivs = $div.children("div");
      if (childDivs.length > 0 && $div.find(".text-mod").length > 0) {
        // Extract text from each child div separately to preserve line breaks
        childDivs.each((_, childDiv) => {
          const statText = parseModifierText($(childDiv), $);
          if (statText) {
            statsLines.push(statText);
          }
        });
      } else if ($div.find(".text-mod").length > 0 || /^\+?\d/.test(text)) {
        // Single stat line without nested divs
        const statText = parseModifierText($div, $);
        if (statText) {
          statsLines.push(statText);
        }
      }
    });

    if (statsLines.length > 0) {
      items.push({
        name,
        equipmentSlot: slot,
        equipmentType,
        stats: statsLines.join("\n"),
      });
    }
  });

  return items;
};

/**
 * Parse a titled affix card from the #XXXCraft section (Base Affix, Corrosion Base)
 */
const parseCraftCard = (
  $: cheerio.CheerioAPI,
  sectionId: string,
  equipmentType: EquipmentType,
  slot: EquipmentSlot,
  affixType: AffixType,
): BaseGearAffix[] => {
  const affixes: BaseGearAffix[] = [];
  const title = $(sectionId)
    .find(".card-title")
    .filter((_, el) => $(el).text().trim() === affixType);

  title
    .siblings(".tierParent")
    .children("div")
    .each((_, row) => {
      affixes.push({
        equipmentSlot: slot,
        equipmentType,
        affixType,
        craftingPool: "",
        tier: tierOf($(row)),
        craftableAffix: parseModifierText($(row), $),
      });
    });

  return affixes;
};

/**
 * Map Library column to CraftingPool
 */
const mapLibraryToPool = (library: string): CraftingPool => {
  const lower = library.toLowerCase();
  if (lower.includes("ultimate")) return "Ultimate";
  if (lower.includes("advanced")) return "Advanced";
  if (lower.includes("intermediate")) return "Intermediate";
  if (lower.includes("basic")) return "Basic";
  return "";
};

/**
 * Parse craft affixes from #XXXCraft section
 * Extracts T0 through T4 affixes
 * Table structure: Tier, Modifier, Lv, Weight, Library
 * Two tables: Pre-fix and Suffix (identified by caption)
 */
const parseCraftAffixes = (
  $: cheerio.CheerioAPI,
  sectionId: string,
  equipmentType: EquipmentType,
  slot: EquipmentSlot,
): BaseGearAffix[] => {
  const affixes: BaseGearAffix[] = [];
  const section = $(sectionId);
  if (!section.length) return affixes;

  // Find both tables (Pre-fix and Suffix)
  section.find("table").each((_, table) => {
    const $table = $(table);
    const caption = $table.find("caption").text().trim();

    let affixType: AffixType;
    if (caption.toLowerCase().includes("pre-fix")) {
      affixType = "Prefix";
    } else if (caption.toLowerCase().includes("suffix")) {
      affixType = "Suffix";
    } else {
      return; // Skip unknown tables
    }

    // Filter for T0 through T4
    $table
      .find(
        'tbody tr[data-tier="0"], tbody tr[data-tier="1"], tbody tr[data-tier="2"], tbody tr[data-tier="3"], tbody tr[data-tier="4"]',
      )
      .each((_, row) => {
        const $row = $(row);
        const tds = $row.find("td");
        if (tds.length < 5) return;

        const tier = $(tds[0]).text().trim();
        const modifier = parseModifierText($(tds[1]), $);
        const library = $(tds[4]).text().trim();

        affixes.push({
          equipmentSlot: slot,
          equipmentType,
          affixType,
          craftingPool: mapLibraryToPool(library),
          tier,
          craftableAffix: modifier,
        });
      });
  });

  return affixes;
};

const normalizeEquipmentType = (type: string): string => {
  return type
    .toLowerCase()
    .replace(/\s*\(([^)]+)\)\s*/g, "-$1")
    .replace(/\s+/g, "-");
};

const normalizeAffixType = (type: string): string => {
  return type.toLowerCase().replace(/\s+/g, "-");
};

const normalizeFileKey = (equipmentType: string, affixType: string): string => {
  return `${normalizeEquipmentType(equipmentType)}-${normalizeAffixType(affixType)}`;
};

const fileKeyToConstName = (fileKey: string): string => {
  return `${fileKey.replace(/-/g, "_").toUpperCase()}_AFFIXES`;
};

const generateEquipmentAffixFile = (
  fileKey: string,
  affixes: BaseGearAffix[],
): string => {
  const constName = fileKeyToConstName(fileKey);

  return `// This file is machine-generated. Do not modify manually.
// To regenerate, run: pnpm exec tsx src/scripts/generate-gear-affix-data.ts
import type { BaseGearAffix } from "../../tli/gear-data-types";

export const ${constName}: readonly BaseGearAffix[] = ${JSON.stringify(affixes)};
`;
};

const generateBaseGearFile = (items: BaseGear[]): string => {
  return `// This file is machine-generated. Do not modify manually.
// To regenerate, run: pnpm exec tsx src/scripts/generate-gear-affix-data.ts
import type { BaseGear } from "../../tli/gear-data-types";

export const ALL_BASE_GEAR: readonly BaseGear[] = ${JSON.stringify(items)};
`;
};

const generateAllAffixesFile = (fileKeys: string[]): string => {
  const imports = fileKeys
    .map((key) => {
      const constName = fileKeyToConstName(key);
      return `import { ${constName} } from "./${key}";`;
    })
    .join("\n");

  const arraySpread = fileKeys
    .map((key) => `  ...${fileKeyToConstName(key)},`)
    .join("\n");

  return `// This file is machine-generated. Do not modify manually.
// To regenerate, run: pnpm exec tsx src/scripts/generate-gear-affix-data.ts
${imports}

export const ALL_GEAR_AFFIXES = [
${arraySpread}
] as const;
`;
};

interface Options {
  refetch: boolean;
}

const main = async (options: Options): Promise<void> => {
  if (options.refetch) {
    console.log("Refetching gear type pages from tlidb...\n");
    await fetchGearTypePages();
    console.log("");
  }
  const outDir = join(process.cwd(), "src", "data", "gear-affix");

  console.log("Reading gear files from tlidb...");
  const files = await readdir(GEAR_TYPE_DIR);
  const htmlFiles = files.filter(
    (f) => f.endsWith(".html") && f !== "craft.html",
  );

  console.log(`Found ${htmlFiles.length} gear files`);

  const allAffixes: BaseGearAffix[] = [];
  const allBaseGear: BaseGear[] = [];
  const $tower = cheerio.load(await readFile(TOWER_SEQUENCE_PATH, "utf-8"));

  for (const file of htmlFiles) {
    const equipmentInfo = EQUIPMENT_MAP[file];
    if (!equipmentInfo) {
      console.warn(`Unknown equipment file: ${file}, skipping`);
      continue;
    }

    const { type, slot } = equipmentInfo;
    const filePath = join(GEAR_TYPE_DIR, file);
    const html = await readFile(filePath, "utf-8");
    const $ = cheerio.load(html);

    const sectionPrefix = getSectionPrefix(file);

    console.log(`Processing ${file} -> ${type} (${sectionPrefix})`);

    // Parse all sections
    const sequences = parseSequences($tower, type, slot);
    const baseGear = parseBaseGear($, `#${sectionPrefix}`, type, slot);
    const baseAffixes = parseCraftCard(
      $,
      `#${sectionPrefix}Craft`,
      type,
      slot,
      "Base Affix",
    );
    const corrosionBase = parseCraftCard(
      $,
      `#${sectionPrefix}Craft`,
      type,
      slot,
      "Corrosion Base",
    );
    const craftAffixes = parseCraftAffixes(
      $,
      `#${sectionPrefix}Craft`,
      type,
      slot,
    );

    allAffixes.push(
      ...sequences,
      ...baseAffixes,
      ...corrosionBase,
      ...craftAffixes,
    );

    allBaseGear.push(...baseGear);

    console.log(
      `  Sequences: ${sequences.length}, BaseGear: ${baseGear.length}, BaseAffix: ${baseAffixes.length}, Corrosion: ${corrosionBase.length}, Craft: ${craftAffixes.length}`,
    );
  }

  console.log(`\nTotal affixes extracted: ${allAffixes.length}`);

  // Group by combination of equipmentType + affixType
  const grouped = new Map<string, BaseGearAffix[]>();

  for (const affix of allAffixes) {
    const fileKey = normalizeFileKey(affix.equipmentType, affix.affixType);

    if (!grouped.has(fileKey)) {
      grouped.set(fileKey, []);
    }
    grouped.get(fileKey)?.push(affix);
  }

  console.log(`Grouped into ${grouped.size} files`);

  // Create output directory
  await mkdir(outDir, { recursive: true });

  // Generate individual affix files
  const fileKeys: string[] = [];

  for (const [fileKey, affixes] of grouped) {
    fileKeys.push(fileKey);
    const fileName = `${fileKey}.ts`;
    const filePath = join(outDir, fileName);
    const content = generateEquipmentAffixFile(fileKey, affixes);

    await writeFile(filePath, content, "utf-8");
    console.log(`Generated ${fileName} (${affixes.length} affixes)`);
  }

  // Generate all-affixes.ts
  const allAffixesPath = join(outDir, "all-affixes.ts");
  const allAffixesContent = generateAllAffixesFile(fileKeys.sort());
  await writeFile(allAffixesPath, allAffixesContent, "utf-8");
  console.log(`Generated all-affixes.ts`);

  // Delete old *-base-stats.ts files from gear-affix/
  const existingFiles = await readdir(outDir);
  const baseStatsFiles = existingFiles.filter((f) =>
    f.endsWith("-base-stats.ts"),
  );
  for (const file of baseStatsFiles) {
    await rm(join(outDir, file));
    console.log(`Deleted old ${file}`);
  }

  // Generate single BaseGear file in src/data/gear-base/
  const baseGearOutDir = join(process.cwd(), "src", "data", "gear-base");
  await mkdir(baseGearOutDir, { recursive: true });

  // Delete old per-type base gear files
  const existingBaseGearFiles = await readdir(baseGearOutDir);
  for (const file of existingBaseGearFiles) {
    if (file !== "all-base-gear.ts" && file.endsWith(".ts")) {
      await rm(join(baseGearOutDir, file));
      console.log(`Deleted old gear-base/${file}`);
    }
  }

  const allBaseGearPath = join(baseGearOutDir, "all-base-gear.ts");
  const allBaseGearContent = generateBaseGearFile(allBaseGear);
  await writeFile(allBaseGearPath, allBaseGearContent, "utf-8");
  console.log(
    `Generated gear-base/all-base-gear.ts (${allBaseGear.length} items)`,
  );

  console.log("\nCode generation complete!");
  console.log(
    `Generated ${grouped.size} affix files with ${allAffixes.length} total affixes`,
  );
  console.log(
    `Generated base gear file with ${allBaseGear.length} total items`,
  );

  execSync("pnpm format", { stdio: "inherit" });
};

program
  .description("Generate gear affix data from cached HTML pages")
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
