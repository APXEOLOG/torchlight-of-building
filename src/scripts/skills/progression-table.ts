import type { Cheerio, CheerioAPI } from "cheerio";
import { t } from "@/src/tli/mod-parser";
import type { ProgressionColumn, SupportParserInput } from "./types";

const EXPECTED_LEVELS = 40;

export const extractProgressionTable = (
  $: CheerioAPI,
): SupportParserInput["progressionTable"] | undefined => {
  const card = $("div.card-header:contains('Progression /40')").closest(
    "div.card",
  );
  if (card.length === 0) {
    return undefined;
  }

  const table = card.find("table");
  if (table.length === 0) {
    return undefined;
  }

  // Each level has one cell of data-source blocks. Columns are rebuilt in the order the parsers expect:
  // one "Effectiveness of added damage" and "damage" pair per damage part, then "Descript".
  const effColumns: ProgressionColumn[] = [];
  const damageColumns: ProgressionColumn[] = [];
  const descriptColumn: ProgressionColumn = { header: "Descript", rows: {} };

  table.find("tbody tr").each((_, row) => {
    const cells = $(row).find("td");
    if (cells.length < 2) return;

    const level = Number.parseInt($(cells[0]).text().trim(), 10);
    if (Number.isNaN(level)) return;

    const description = descriptText(
      $,
      $(cells[1]).find('[data-source="des"]'),
    );
    descriptColumn.rows[level] = description;
    $(cells[1])
      .find('[data-source="damage_effective"]')
      .each((i, block) => {
        effColumns[i] ??= { header: "Effectiveness of added damage", rows: {} };
        damageColumns[i] ??= { header: "damage", rows: {} };
        effColumns[i].rows[level] = $(block)
          .text()
          .replace(/^effectiveness of added damage/i, "")
          .trim();
        damageColumns[i].rows[level] = description;
      });
  });

  const columns = effColumns.flatMap((col, i) => [col, damageColumns[i]]);
  return [...columns, descriptColumn];
};

// Hyperlink tooltips hold HTML that would pollute the text, and <br> and <hr> both separate lines.
// biome-ignore lint/suspicious/noExplicitAny: cheerio internal type
const descriptText = ($: CheerioAPI, block: Cheerio<any>): string => {
  const clone = block.clone();
  clone.find("e.Hyperlink").each((_, el) => {
    $(el).replaceWith($(el).text());
  });
  const html = (clone.html() ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr[^>]*\/?>/gi, "\n");
  return $("<div>")
    .html(html.replace(/<[^>]+>/g, ""))
    .text()
    .trim();
};

export const validateAllLevels = (
  levels: Record<number, unknown>,
  skillName: string,
): void => {
  const levelNumbers = Object.keys(levels)
    .map(Number)
    .sort((a, b) => a - b);

  if (levelNumbers.length !== EXPECTED_LEVELS) {
    throw new Error(
      `Parser for "${skillName}" extracted ${levelNumbers.length} levels, expected ${EXPECTED_LEVELS}`,
    );
  }

  for (let i = 1; i <= EXPECTED_LEVELS; i++) {
    if (!levelNumbers.includes(i)) {
      throw new Error(`Parser for "${skillName}" missing level ${i}`);
    }
  }
};

export const parseNumericValue = (value: string): number => {
  const cleaned = value.replace(/^\+/, "").trim();

  // Handle fraction notation (e.g., "31/2" = 15.5)
  const fractionMatch = cleaned.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
  let num: number;

  if (fractionMatch) {
    const numerator = Number.parseFloat(fractionMatch[1]);
    const denominator = Number.parseFloat(fractionMatch[2]);
    num = numerator / denominator;
  } else {
    num = Number.parseFloat(cleaned);
  }

  if (Number.isNaN(num)) {
    throw new Error(`Failed to parse numeric value: "${value}"`);
  }

  // Round to 4 decimal places to avoid floating point artifacts
  return Math.round(num * 10000) / 10000;
};

export const findColumn = (
  columns: ProgressionColumn[],
  headerTemplate: string,
  skillName: string,
): ProgressionColumn => {
  const matcher = t(headerTemplate);
  const col = columns.find((c) => matcher.tryMatch(c.header) !== undefined);
  if (col === undefined) {
    throw new Error(`${skillName}: no column matches "${headerTemplate}"`);
  }
  return col;
};

export const getDescriptionPart = (
  skillName: string,
  description: string[],
  index: number,
): string => {
  const descriptionPart = description[index];
  if (descriptionPart === undefined) {
    throw new Error(`${skillName}: no description found`);
  }
  return descriptionPart;
};

// ============================================
// Magnificent Support Progression Table
// ============================================

const EXPECTED_TIERS = 3;

/**
 * Extract the 3-tier progression table for magnificent support skills.
 * Looks for "Progression /3" header instead of "Progression /40".
 */
export const extractMagnificentProgressionTable = (
  $: CheerioAPI,
): ProgressionColumn[] | undefined => {
  const card = $("div.card-header:contains('Progression /3')").closest(
    "div.card",
  );
  if (card.length === 0) {
    return undefined;
  }

  const table = card.find("table");
  if (table.length === 0) {
    return undefined;
  }

  const headerRow = table.find("thead tr").first();
  const headerCells = headerRow.find("th");

  const headers: string[] = [];
  headerCells.slice(1).each((_, cell) => {
    headers.push($(cell).text().trim());
  });

  // Build column-centric structure: each column has all its tier values
  const columns: ProgressionColumn[] = headers.map((header) => ({
    header,
    rows: {},
  }));

  table.find("tbody tr").each((_, row) => {
    const cells = $(row).find("td");
    if (cells.length < 2) return;

    const tier = Number.parseInt($(cells[0]).text().trim(), 10);
    if (Number.isNaN(tier)) return;

    cells.slice(1).each((i, cell) => {
      if (columns[i] !== undefined) {
        columns[i].rows[tier] = $(cell).text().trim();
      }
    });
  });

  return columns;
};

/**
 * Validate that all 3 tiers (0, 1, 2) are present in parsed data.
 */
export const validateAllTiers = (
  tiers: Record<number, unknown>,
  skillName: string,
): void => {
  const tierNumbers = Object.keys(tiers)
    .map(Number)
    .sort((a, b) => a - b);

  if (tierNumbers.length !== EXPECTED_TIERS) {
    throw new Error(
      `Parser for "${skillName}" extracted ${tierNumbers.length} tiers, expected ${EXPECTED_TIERS}`,
    );
  }

  for (const tier of [0, 1, 2]) {
    if (!tierNumbers.includes(tier)) {
      throw new Error(`Parser for "${skillName}" missing tier ${tier}`);
    }
  }
};

/**
 * Parse a tier range from text like "+(19–23)%" or "+(16–18)%" or "(-7–-5)%".
 * Returns { min, max } object.
 */
export const parseTierRange = (
  text: string,
  skillName: string,
): { min: number; max: number } => {
  // Match patterns like "+(19–23)%" or "(130–150)%" or "+(12-14)%" or "(-7–-5)%"
  // Handle both en-dash (–) and regular hyphen (-)
  // Also handle negative numbers by capturing optional minus sign
  const rangeMatch = text.match(
    /\+?\(?(-?\d+(?:\.\d+)?)[–-](-?\d+(?:\.\d+)?)\)?/,
  );
  if (rangeMatch === null) {
    throw new Error(
      `${skillName}: Failed to parse tier range from text: "${text}"`,
    );
  }
  return {
    min: Number.parseFloat(rangeMatch[1]),
    max: Number.parseFloat(rangeMatch[2]),
  };
};

// ============================================
// Activation Medium Progression Table
// ============================================

export interface ActivationMediumTierRow {
  tier: 0 | 1 | 2 | 3;
  affixes: string[];
}

/**
 * Extract the 4-tier progression table for activation medium skills.
 * Looks for "Progression /4" header.
 * Returns an array of { tier, affixes } for each tier found.
 */
export const extractActivationMediumProgressionTable = (
  $: CheerioAPI,
): ActivationMediumTierRow[] | undefined => {
  const card = $("div.card-header:contains('Progression /4')").closest(
    "div.card",
  );
  if (card.length === 0) {
    return undefined;
  }

  const table = card.find("table");
  if (table.length === 0) {
    return undefined;
  }

  const result: ActivationMediumTierRow[] = [];

  table.find("tbody tr").each((_, row) => {
    const cells = $(row).find("td");
    if (cells.length < 2) return;

    const tierNum = Number.parseInt($(cells[0]).text().trim(), 10);
    if (Number.isNaN(tierNum) || tierNum < 0 || tierNum > 3) return;
    const tier = tierNum as 0 | 1 | 2 | 3;

    // Each row of the cell is an affix line, written as either <li> or <div>
    const affixes: string[] = [];
    $(cells[1])
      .children("li, div")
      .each((_, li) => {
        // Clone the <li> and strip hyperlink elements using DOM methods
        // (regex fails because cheerio decodes HTML entities in data-bs-title
        // attributes, producing raw > characters that break [^>]* patterns)
        const liClone = $(li).clone();
        liClone.find("e.Hyperlink").each((_, el) => {
          const text = $(el).text();
          $(el).replaceWith(text);
        });

        // Get HTML and process it
        let html = liClone.html() ?? "";

        // Replace <span class="text-mod">(min–max)</span> with (min-max) format
        // Handle en-dash (–) by replacing with regular hyphen (-)
        html = html.replace(
          /<span class="text-mod">([^<]+)<\/span>/g,
          (_match, content: string) => {
            // Replace en-dash with hyphen for consistency with craft() function
            return content.replace(/–/g, "-");
          },
        );

        // Remove any remaining HTML tags
        const text = html.replace(/<[^>]+>/g, "").trim();

        if (text.length > 0) {
          affixes.push(text);
        }
      });

    result.push({ tier, affixes });
  });

  return result.length > 0 ? result : undefined;
};
