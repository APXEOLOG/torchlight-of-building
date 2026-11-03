import {
  type TalentNodeData,
  TalentTrees,
  type TreeName,
} from "@/src/data/talent-tree";
import { getAreaFromDimensions, type PrismArea } from "@/src/lib/prism-utils";
import type { Affix, AffixLine, PlacedPrism, PrismAffix } from "./core";
import { parseMod } from "./mod-parser/index";

export type TreeSlot = "tree1" | "tree2" | "tree3" | "tree4";

export const treeDataByName: Record<TreeName, TalentNodeData[]> =
  Object.fromEntries(
    TalentTrees.map((tree) => [tree.name, tree.nodes]),
  ) as Record<TreeName, TalentNodeData[]>;

export const findTalentNodeData = (
  treeName: string,
  x: number,
  y: number,
): TalentNodeData | undefined => {
  const nodes = treeDataByName[treeName as TreeName];
  if (!nodes) return undefined;
  return nodes.find((n) => n.position.x === x && n.position.y === y);
};

export const convertAffixTextToAffix = (
  affixText: string,
  src: string,
): Affix => {
  const lines = affixText.split(/\n/);
  const affixLines: AffixLine[] = lines.map((lineText) => {
    const mods = parseMod(lineText);
    return { text: lineText, mods: mods?.map((mod) => ({ ...mod, src })) };
  });

  return { affixLines, src };
};

// Scale numeric values in affix text by a multiplier
// Excludes cooldown values from scaling (e.g., "6 s cooldown" or "Cooldown: 0.3 s")
const scaleAffixText = (text: string, multiplier: number): string => {
  // Patterns for cooldown values that should NOT be scaled:
  // - "X s cooldown" (e.g., "6 s cooldown against the same target")
  // - "Cooldown: X s" (e.g., "Cooldown: 0.3 s")
  const cooldownPatterns = [
    /(\d+(?:\.\d+)?)\s*s\s+cooldown/gi,
    /Cooldown:\s*(\d+(?:\.\d+)?)\s*s/gi,
  ];

  // Collect cooldown values and their positions to preserve them
  const cooldownMatches: { start: number; end: number; original: string }[] =
    [];
  for (const pattern of cooldownPatterns) {
    for (const match of text.matchAll(pattern)) {
      cooldownMatches.push({
        start: match.index,
        end: match.index + match[0].length,
        original: match[0],
      });
    }
  }

  // Scale numbers, but skip those within cooldown ranges
  return text.replace(
    /([+-]?)(\d+(?:\.\d+)?)/g,
    (match, sign, numStr, offset) => {
      // Check if this number is within a cooldown pattern
      const isInCooldown = cooldownMatches.some(
        (cm) => offset >= cm.start && offset < cm.end,
      );
      if (isInCooldown) {
        return match; // Return original, don't scale
      }

      const num = parseFloat(numStr);
      const scaled = num * multiplier;
      const hasDecimal = numStr.includes(".");
      const formatted = hasDecimal
        ? scaled.toFixed(numStr.split(".")[1].length)
        : Math.round(scaled).toString();
      return sign + formatted;
    },
  );
};

// Parse a gauge affix string into a PrismAffix
export const parseGaugeAffix = (affix: string): PrismAffix => {
  const areaMatch = affix.match(/(\d+x\d+) Rectangle/);
  if (areaMatch !== null) {
    return { text: affix, type: "area", dimensions: areaMatch[1] };
  }

  const bonusMatch = affix.match(
    /^All (Legendary Medium|Medium|Micro) Talent within the area also gain:\s*([\s\S]+)$/,
  );
  if (bonusMatch !== null) {
    const typeMapping: Record<string, "legendary" | "medium" | "micro"> = {
      "Legendary Medium": "legendary",
      Medium: "medium",
      Micro: "micro",
    };
    return {
      text: affix,
      type: "bonusNode",
      targetType: typeMapping[bonusMatch[1]],
      bonusText: bonusMatch[2].trim(),
    };
  }

  return { text: affix, type: "unsupported" };
};

// Get positions affected by a prism based on its area dimensions
const getAffectedPositions = (
  prismX: number,
  prismY: number,
  area: PrismArea = { w: 1, h: 1, anchorCol: 0, anchorRow: 0 },
  gridWidth: number = 7,
  gridHeight: number = 5,
): { x: number; y: number }[] => {
  const positions: { x: number; y: number }[] = [];

  for (let col = 0; col < area.w; col++) {
    for (let row = 0; row < area.h; row++) {
      const x = prismX + col - area.anchorCol;
      const y = prismY + row - area.anchorRow;

      if (x === prismX && y === prismY) continue;

      if (x >= 0 && x < gridWidth && y >= 0 && y < gridHeight) {
        positions.push({ x, y });
      }
    }
  }

  return positions;
};

export const scaleTalentAffix = (
  rawAffix: string,
  points: number,
  src: string,
): Affix => {
  const scaledText = scaleAffixText(rawAffix, Math.max(1, points));
  return convertAffixTextToAffix(addMissingSigns(scaledText), src);
};

// Some talent data drops the "+" on decimal bonuses, e.g. "7.5% Critical Strike Damage".
// A line is only signed when it doesn't parse as it is and does with the sign.
const addMissingSigns = (text: string): string =>
  text
    .split("\n")
    .map((line) =>
      /^\d/.test(line) &&
      parseMod(line) === undefined &&
      parseMod(`+${line}`) !== undefined
        ? `+${line}`
        : line,
    )
    .join("\n");

export const getPrismAffixesForNode = (
  nodePosition: { x: number; y: number },
  nodeType: "micro" | "medium" | "legendary",
  points: number,
  placedPrism: PlacedPrism | undefined,
  treeSlot: TreeSlot,
  src: string,
): Affix[] => {
  if (!placedPrism || placedPrism.treeSlot !== treeSlot) return [];

  const areaAffix = placedPrism.prism.gaugeAffixes.find(
    (a) => a.type === "area",
  );
  const area = getAreaFromDimensions(
    areaAffix?.type === "area" ? areaAffix.dimensions : undefined,
  );
  const affectedPositions = getAffectedPositions(
    placedPrism.position.x,
    placedPrism.position.y,
    area,
  );

  const isAffected = affectedPositions.some(
    (pos) => pos.x === nodePosition.x && pos.y === nodePosition.y,
  );

  if (!isAffected) return [];

  const prismAffixes: Affix[] = [];

  for (const gaugeAffix of placedPrism.prism.gaugeAffixes) {
    if (gaugeAffix.type !== "bonusNode") continue;

    if (gaugeAffix.targetType === nodeType) {
      const scaledText = scaleAffixText(
        gaugeAffix.bonusText,
        Math.max(1, points),
      );
      prismAffixes.push(convertAffixTextToAffix(scaledText, src));
    }
  }

  return prismAffixes;
};
