// Turns a parsed login into the engine's SaveData, plus a record of what it couldn't fill in.
// The game cuts long lists at random, so skill gaps are filled from the login's other lists, then from earlier logins.
import type { GameIdTable, GameIdText } from "@/src/data/game-ids/types";
import { ALL_BASE_GEAR } from "@/src/data/gear-base/all-base-gear";
import { Legendaries } from "@/src/data/legendary/legendaries";
import { ActivationMediumSkills } from "@/src/data/skill/activation-medium";
import { MagnificentSupportSkills } from "@/src/data/skill/support-magnificent";
import { NobleSupportSkills } from "@/src/data/skill/support-noble";
import type { ActivationMediumAffixDef } from "@/src/data/skill/types";
import type { Gear } from "@/src/lib/save-data";
import {
  EMPTY_SAVE_DATA,
  type SaveData,
} from "@/src/lib/schemas/save-data.schema";
import type { BaseSupportSkillSlot as SupportSlot } from "@/src/lib/schemas/skill.schema";
import { parseTierRange } from "@/src/lib/special-support-utils";
import { parseMod } from "@/src/tli/mod-parser";
import type { RawLogin } from "./parse-log";

// Things the log can't give, entered by hand.
// Pactspirits are paid pets, so build comparisons leave them out; their stats only feed the player's own simulation.
export interface ManualEntries {
  pactspiritLines?: string[];
  talentNodes?: Record<string, { x: number; y: number; points: number }[]>;
  // What a follower's skills give the player, since the login doesn't list followers.
  follower?: { lines?: string[]; marksTarget?: boolean };
}

export interface Capture {
  schema: 2;
  source: "own-log";
  capturedAt: string | undefined;
  coverage: {
    skills: string;
    skillsMissing: number[];
    gear: string;
    talentTrees: {
      tree: string | undefined;
      points: number;
      cutOffAfter?: { x: number; y: number };
    }[];
    missingSections: string[];
  };
  // Values taken from somewhere other than this login.
  inferred: string[];
  // Lines that didn't reach the engine, and why.
  leftOut: {
    noRolledValue: string[];
    noName: number[];
    unknownGear: string[];
    unreadSections: string[];
  };
  // Lines that reached the engine but that it can't read.
  unreadable: string[];
}

export interface PlayerBuild {
  capture: Capture;
  save: SaveData;
}

interface RawAffix {
  Id?: number;
  DynArgs?: Record<string, unknown> | unknown[];
}
type RawItem = {
  BaseId: number;
  UniqueItmId?: number;
  Level?: number;
  [key: string]: unknown;
};
interface RawSkillItem {
  Index: number;
  // For Magnificent and Noble supports, Level is the star rank. Prefix holds rolled lines (theirs and Activation Mediums').
  Item: { BaseId: number; Level?: number; Prefix?: RawAffix[] };
}
interface RawGenius {
  geniusId: number;
  point?: number;
  position: { x: number; y: number };
}
interface RawTree {
  geniusList?: RawGenius[];
  bonusGeniusInfo?: { key: number; value: { geniusId: number } }[];
}

const GEAR_SLOTS: Record<number, string> = {
  1: "helmet",
  2: "mainHand",
  3: "offHand",
  4: "chest",
  5: "neck",
  6: "leftRing",
  7: "rightRing",
  8: "belt",
  9: "gloves",
  10: "boots",
};
const SECTIONS: Record<string, string> = {
  BaseAttrAffix: "baseStats",
  BaseAffix: "baseAffix",
  FixedBaseAffix: "implicit",
  ChipAffix: "towerSequence",
  EnchantAffixs: "beltBlend",
  Prefix: "prefixes",
  Suffix: "suffixes",
  DreamAffix: "sweetDream",
};
const SKIP_KEYS = /Slots$|^DreamAffixExclusive$/;
const AFFIX_KEYS = /Affix|^Prefix$|^Suffix$/;
// tlidb doesn't publish hero IDs, so these are entered by hand.
const HEROES: Record<number, string> = {
  15002: "Lightbringer Rosa: Unsullied Blade (#2)",
};
const ACTIVE_SLOTS = [1, 2, 3, 4, 5];
const PASSIVE_SLOTS = [1001, 1007, 1013, 1019];
const MEMORY_BASE_STAT = /^4031(\d\d)\d{3}$/;

// The range a rolled line was rolled in, such as "+(18–22)", which tells its tier.
const rolledRange = (
  entry: GameIdText | undefined,
): { min: number; max: number } | undefined => {
  const arg = entry?.args.find((a) => a.includes("–"));
  return arg === undefined ? undefined : parseTierRange(arg);
};

// tlidb's description gives only the Tier 1 range of a Magnificent or Noble support's rolled line.
const specialTier = (
  description: readonly string[],
  range: { min: number; max: number } | undefined,
): 0 | 1 | 2 => {
  const tier1 = description.map(parseTierRange).find((r) => r !== undefined);
  if (range === undefined || tier1 === undefined) return 1;
  if (range.min === tier1.min && range.max === tier1.max) return 1;
  return range.max > tier1.max ? 0 : 2;
};

// An Activation Medium's tier is the one whose affix list has the same range as its rolled line.
const mediumTier = (
  defs: Record<0 | 1 | 2 | 3, ActivationMediumAffixDef[]> | undefined,
  rolled: { range?: { min: number; max: number } }[],
): 0 | 1 | 2 | 3 => {
  const range = rolled.find((r) => r.range !== undefined)?.range;
  if (defs === undefined || range === undefined) return 0;
  const tier = ([0, 1, 2, 3] as const).find((t) =>
    (defs[t] ?? []).some((d) => {
      const r = parseTierRange(d.affix);
      return r !== undefined && r.min === range.min && r.max === range.max;
    }),
  );
  return tier ?? 0;
};

const list = <T>(value: unknown): T[] =>
  Array.isArray(value) ? (value as T[]) : [];

const fmt = (v: number): string =>
  Number.isInteger(v) ? String(v) : String(Number(v.toFixed(2)));

// How well a logged value fits a tlidb number: 2 for the same fixed number, 1 for inside its range, 0 otherwise.
const valueFit = (arg: string | undefined, v: number): number => {
  const nums = (arg ?? "").match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  const x = Math.abs(v);
  if (nums.length === 1) return nums[0] === x ? 2 : 0;
  if (nums.length === 2) {
    return x >= Math.min(nums[0], nums[1]) && x <= Math.max(nums[0], nums[1])
      ? 1
      : 0;
  }
  return 0;
};

// The log keeps a line's values in the game's source-language order, which can differ from the English text: Lone
// Walker's "+29% Aura effect when affected by 4 or more Auras" is logged as [4, 29]. Each value goes to the number it
// fits best; ties keep the logged order.
const orderValues = (
  args: (string | undefined)[],
  values: number[],
): number[] => {
  if (values.length < 2 || values.length > 6) return values;
  let best = values;
  let bestScore = -1;
  const permute = (left: number[], taken: number[]): void => {
    if (left.length === 0) {
      const score = taken.reduce((s, v, i) => s + valueFit(args[i], v), 0);
      if (score > bestScore) {
        bestScore = score;
        best = taken;
      }
      return;
    }
    left.forEach((v, i) => {
      permute([...left.slice(0, i), ...left.slice(i + 1)], [...taken, v]);
    });
  };
  permute(values, []);
  return best;
};

// Puts rolled values into a tlidb template. If the log has fewer values than the text has numbers, the values belong to
// the ranged numbers: a fixed number like Gale's 60% isn't logged. A number with no rolled value keeps the page's own text.
export const renderText = (entry: GameIdText, values: number[]): string => {
  const marks = entry.template.match(/\+?#/g) ?? [];
  const takes = marks.map(
    (_, i) =>
      values.length >= entry.args.length ||
      entry.args[i]?.includes("–") === true,
  );
  const slots = takes.flatMap((t, i) => (t ? [i] : []));
  const ordered = orderValues(
    slots.map((i) => entry.args[i]),
    values.slice(0, slots.length),
  );
  let i = 0;
  return entry.template.replace(/\+?#/g, (mark) => {
    const arg = entry.args[i];
    const slot = slots.indexOf(i);
    i += 1;
    const v = slot >= 0 ? ordered[slot] : undefined;
    if (v !== undefined) {
      return mark.startsWith("+") && v >= 0 ? `+${fmt(v)}` : fmt(v);
    }
    return arg ?? mark;
  });
};

export const loginToBuild = (
  login: RawLogin,
  earlier: RawLogin[],
  ids: GameIdTable,
  manual: ManualEntries = {},
): PlayerBuild => {
  const noRolledValue: string[] = [];
  const noName: number[] = [];
  const unknownGear: string[] = [];
  const unreadSections = new Set<string>();
  const inferred: string[] = [];

  // One logged affix can hold several lines. A line still showing tlidb's range wasn't rolled in the log, so it stays out.
  const splitLines = (text: string): string[] =>
    text
      .split("\n")
      .map((t) => t.trim())
      .filter((t) => {
        if (t.includes("–")) {
          noRolledValue.push(t);
          return false;
        }
        return t !== "";
      });

  const affixLines = (affix: RawAffix): string[] => {
    const id = String(affix.Id);
    const values = Object.values(affix.DynArgs ?? {}).filter(
      (v): v is number => typeof v === "number",
    );
    const entry = ids.modifiers[id];
    if (entry !== undefined) return splitLines(renderText(entry, values));
    const base = id.match(MEMORY_BASE_STAT);
    const stat =
      base === null ? undefined : ids.memoryBaseStats[Number(base[1]) - 1];
    if (stat === undefined) {
      noName.push(Number(affix.Id));
      return [];
    }
    const text = renderText(stat, values);
    inferred.push(`memory base stat: ${text}`);
    return splitLines(text);
  };

  const readSections = (item: RawItem): Record<string, string[]> => {
    const out: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(item)) {
      if (SKIP_KEYS.test(key) || !AFFIX_KEYS.test(key)) continue;
      const affixes = list<RawAffix>(value).filter((a) => a?.Id !== undefined);
      if (affixes.length === 0) continue;
      const name = SECTIONS[key];
      if (name === undefined) {
        unreadSections.add(key);
        continue;
      }
      out[name] = affixes.flatMap(affixLines);
    }
    return out;
  };

  const readGear = (slot: string, item: RawItem): Gear | undefined => {
    const parts = readSections(item);
    const common = {
      id: slot,
      baseStats: parts.baseStats?.join("\n") || undefined,
    };
    if ((item.UniqueItmId ?? 0) > 0) {
      const name = ids.legendaries[String(item.UniqueItmId)]?.name;
      const legendary = Legendaries.find((l) => l.name === name);
      if (legendary === undefined) {
        unknownGear.push(`${slot}: legendary ${item.UniqueItmId} (${name})`);
        return undefined;
      }
      return {
        ...common,
        equipmentType: legendary.equipmentType,
        rarity: "legendary",
        legendaryName: legendary.name,
        // A legendary has no base affix of its own: the log keeps its corroded line there.
        legendaryAffixes: [
          ...(parts.implicit ?? []),
          ...(parts.prefixes ?? []),
          ...(parts.suffixes ?? []),
          ...(parts.baseAffix ?? []),
        ],
      };
    }
    const name = ids.items[String(item.BaseId)]?.name;
    const base = ALL_BASE_GEAR.find((g) => g.name === name);
    if (base === undefined) {
      unknownGear.push(`${slot}: base ${item.BaseId} (${name})`);
      return undefined;
    }
    return {
      ...common,
      equipmentType: base.equipmentType,
      rarity: "rare",
      baseGearName: base.name,
      baseAffixes: [...(parts.implicit ?? []), ...(parts.baseAffix ?? [])],
      towerSequenceAffix: parts.towerSequence?.[0],
      blendAffix: parts.beltBlend?.[0],
      sweetDreamAffix: parts.sweetDream?.[0],
      prefixes: parts.prefixes ?? [],
      suffixes: parts.suffixes ?? [],
    };
  };

  const gear = list<{ Index: number; Item: RawItem }>(login.wearItems).flatMap(
    ({ Index, Item }): { slot: string; piece: Gear }[] => {
      const slot = GEAR_SLOTS[Index] ?? `slot${Index}`;
      const piece = readGear(slot, Item);
      return piece === undefined ? [] : [{ slot, piece }];
    },
  );

  // Slot number to skill: the login's two lists first, then earlier logins.
  const slotSkills = new Map<
    number,
    { id: number; level?: number; prefix?: RawAffix[] }
  >();
  const readSkills = (from: RawLogin, label: string | undefined): void => {
    const add = (
      slot: number,
      id: number,
      level?: number,
      prefix?: RawAffix[],
    ): void => {
      if (slotSkills.has(slot)) return;
      slotSkills.set(slot, { id, level, prefix });
      if (label !== undefined) inferred.push(`skill slot ${slot}: ${label}`);
    };
    for (const s of list<RawSkillItem>(from.dressSkillItems)) {
      add(s.Index, s.Item.BaseId, s.Item.Level, s.Item.Prefix);
    }
    const layout = from.skillLayout as { slots?: unknown } | undefined;
    for (const s of list<{ key: number; value?: { skillId?: unknown } }>(
      layout?.slots,
    )) {
      const id = Number(String(s.value?.skillId).split("_")[0]);
      if (!Number.isNaN(id)) add(s.key, id);
    }
  };
  readSkills(login, undefined);
  for (const other of earlier) readSkills(other, `from ${other.capturedAt}`);

  const named = (
    slot: number,
  ): { name: string; level?: number; prefix?: RawAffix[] } | undefined => {
    const skill = slotSkills.get(slot);
    if (skill === undefined) return undefined;
    const name = ids.skills[String(skill.id)]?.name;
    if (name === undefined) {
      noName.push(skill.id);
      return undefined;
    }
    return { name, level: skill.level, prefix: skill.prefix };
  };
  const toSupport = (x: {
    name: string;
    level?: number;
    prefix?: RawAffix[];
  }): SupportSlot => {
    const rolled = (x.prefix ?? []).map((a) => ({
      lines: affixLines(a),
      range: rolledRange(ids.modifiers[String(a.Id)]),
      value: Object.values(a.DynArgs ?? {}).find(
        (v): v is number => typeof v === "number",
      ),
    }));
    const special =
      MagnificentSupportSkills.find((s) => s.name === x.name) ??
      NobleSupportSkills.find((s) => s.name === x.name);
    const first = rolled.find((r) => r.value !== undefined);
    if (special !== undefined && first !== undefined) {
      return {
        skillType: MagnificentSupportSkills.some((s) => s.name === x.name)
          ? "magnificent_support"
          : "noble_support",
        name: x.name,
        tier: specialTier(special.description, first.range),
        rank: Math.min(5, Math.max(1, x.level ?? 1)) as 1 | 2 | 3 | 4 | 5,
        craftedAffix: first.lines.join("\n"),
        value: first.value ?? 0,
      };
    }
    const medium = (
      ActivationMediumSkills as readonly {
        name: string;
        affixDefs?: Record<0 | 1 | 2 | 3, ActivationMediumAffixDef[]>;
      }[]
    ).find((s) => s.name === x.name);
    if (medium !== undefined && rolled.length > 0) {
      return {
        skillType: "activation_medium",
        name: x.name,
        tier: mediumTier(medium.affixDefs, rolled),
        affixes: rolled.flatMap((r) => r.lines),
      };
    }
    return { skillType: "support", name: x.name, level: x.level };
  };
  // Supports keep their slot number, since Magnificent, Noble and Activation Medium supports only fit one slot each.
  const toSkill = (slot: number, supportSlots: number[]) => {
    const main = named(slot);
    if (main === undefined) return undefined;
    return {
      skillName: main.name,
      enabled: true,
      level: main.level,
      supportSkills: Object.fromEntries(
        supportSlots.flatMap((s, i) => {
          const x = named(s);
          return x === undefined ? [] : [[i + 1, toSupport(x)]];
        }),
      ),
    };
  };
  const activeSkills = ACTIVE_SLOTS.flatMap((n) => {
    const skill = toSkill(
      n,
      [1, 2, 3, 4, 5].map((k) => n * 100 + k),
    );
    return skill === undefined ? [] : [[n, skill] as const];
  });
  const passiveSkills = PASSIVE_SLOTS.flatMap((n) => {
    const skill = toSkill(
      n,
      [1, 2, 3, 4, 5].map((k) => n + k),
    );
    return skill === undefined ? [] : [skill];
  });

  const genius = login.geniusInfos as { info?: unknown } | undefined;
  const trees = list<RawTree>(genius?.info).map((tree) => {
    // The log counts x as the row and y as the column, both from 1; the engine uses column then row from 0.
    const logged = list<RawGenius>(tree.geniusList).filter(
      (g) => (g.point ?? 0) > 0,
    );
    const core = list<{ key: number; value: { geniusId: number } }>(
      tree.bonusGeniusInfo,
    )
      .sort((a, b) => a.key - b.key)
      .map((b) => b.value.geniusId);
    const treeName = [...core, ...logged.map((g) => g.geniusId)]
      .map((id) => ids.talents[String(id)]?.tree)
      .find((t) => t !== undefined);
    for (const id of [...core, ...logged.map((g) => g.geniusId)]) {
      if (ids.talents[String(id)] === undefined) noName.push(id);
    }
    const extra =
      treeName === undefined ? [] : (manual.talentNodes?.[treeName] ?? []);
    const nodes = [
      ...logged.map((g) => ({
        x: g.position.y - 1,
        y: g.position.x - 1,
        points: g.point ?? 0,
      })),
      ...extra,
    ];
    // The list runs in tree order and the game stops at 30, so a list of 30 that doesn't reach the last cell lost its end.
    const whole = list<RawGenius>(tree.geniusList);
    const last = whole.at(-1)?.position;
    const cut =
      whole.length >= 30 &&
      !(last?.y === 7 && last.x === 5) &&
      extra.length === 0 &&
      last !== undefined;
    return {
      treeName,
      nodes,
      core: core.flatMap((c) => ids.talents[String(c)]?.name ?? []),
      cutOffAfter: cut ? { x: last.y - 1, y: last.x - 1 } : undefined,
    };
  });
  const tree = (i: number) => {
    const t = trees[i];
    if (t === undefined) return undefined;
    return {
      name: t.treeName ?? "",
      allocatedNodes: t.nodes,
      selectedCoreTalents: t.core,
    };
  };

  const view = (login.heroCharacterv3OverView ?? {}) as {
    heroPurchaseId?: number;
    pointOverView?: { activeId?: unknown };
    reminiscenceOverView?: { reminiscence?: unknown };
  };
  const memories = list<{ index: number; detail?: RawItem }>(
    view.reminiscenceOverView?.reminiscence,
  );
  const memory = (position: number) => {
    const detail = memories.find((m) => m.index === position)?.detail;
    if (detail === undefined) return undefined;
    const parts = readSections(detail);
    // Not listed as an affix: the game shows the sum of these two as "+N to Hero Trait Level". It's the trait's total
    // level, which already counts the engine's +1 for a full memory.
    const traitLevel =
      Number(detail.ReminiscenceFixedLevel ?? 0) +
      Number(detail.ReminiscenceFixedLevelFromEnhance ?? 0);
    return {
      id: `memory${position}`,
      memoryType: ids.items[String(detail.BaseId)]?.name as "Memory of Origin",
      rarity: "epic" as const,
      level: Number(detail.ReminiscenceLevel ?? 40),
      baseStat: parts.baseStats?.[0] ?? "",
      fixedAffixes: [
        ...(traitLevel > 2 ? [`+${traitLevel - 2} to Hero Trait Level`] : []),
        ...(parts.baseAffix ?? []),
      ],
      randomAffixes: parts.suffixes ?? [],
    };
  };
  const heroMemories = [memory(1), memory(2), memory(3)];

  // The level 1 trait is always on, so the log doesn't list it. Its ID shares the hero's first three digits.
  const activeTraits = list<number>(view.pointOverView?.activeId);
  const firstTrait =
    activeTraits.length > 0
      ? Number(`${String(activeTraits[0]).slice(0, 3)}0001`)
      : undefined;
  if (firstTrait !== undefined) inferred.push(`hero trait ${firstTrait}`);
  const traits = [
    ...(firstTrait === undefined ? [] : [firstTrait]),
    ...activeTraits,
  ].flatMap((id) => {
    const entry = ids.traits[String(id)];
    if (entry === undefined) noName.push(id);
    return entry === undefined ? [] : [entry];
  });
  const trait = (level: number) => {
    const t = traits.find((x) => x.level === level);
    return t === undefined ? undefined : { name: t.name };
  };

  const talentLines = (idList: unknown): string[] =>
    list<number>(idList).flatMap((id) => {
      const text = ids.talents[String(id)]?.text;
      if (text === undefined) {
        noName.push(id);
        return [];
      }
      return splitLines(text);
    });
  // Slates go in as plain lines: their effects don't depend on where they sit, and the log's shape IDs aren't the engine's.
  const slateLines = list<{ Item: Record<string, unknown> }>(
    login.dressingTalentBlocks,
  ).flatMap(({ Item }) => [
    ...talentLines(Item.BaseTalentList),
    ...talentLines(Item.EnchantTalentList),
  ]);
  const pactLines = manual.pactspiritLines ?? [];
  const followerLines = manual.follower?.lines ?? [];

  const heroId = view.heroPurchaseId;
  const heroName = heroId === undefined ? undefined : HEROES[heroId];
  if (heroId !== undefined && heroName === undefined) noName.push(heroId);

  const save: SaveData = {
    ...EMPTY_SAVE_DATA,
    equipmentPage: {
      equippedGear: {
        ...EMPTY_SAVE_DATA.equipmentPage.equippedGear,
        ...Object.fromEntries(gear.map(({ slot }) => [slot, { id: slot }])),
      },
      inventory: gear.map(({ piece }) => piece),
    },
    talentPage: {
      ...EMPTY_SAVE_DATA.talentPage,
      talentTrees: {
        ...EMPTY_SAVE_DATA.talentPage.talentTrees,
        tree1: tree(0),
        tree2: tree(1),
        tree3: tree(2),
        tree4: tree(3),
      },
    },
    skillPage: {
      activeSkills: Object.fromEntries(
        activeSkills,
      ) as SaveData["skillPage"]["activeSkills"],
      passiveSkills: Object.fromEntries(
        passiveSkills.map((s, i) => [i + 1, s]),
      ) as SaveData["skillPage"]["passiveSkills"],
    },
    heroPage: {
      selectedHero: heroName,
      traits: {
        level1: trait(1),
        level45: trait(45),
        level60: trait(60),
        level75: trait(75),
      },
      memorySlots: {
        slot45: heroMemories[0],
        slot60: heroMemories[1],
        slot75: heroMemories[2],
      },
      memoryInventory: [],
    },
    configurationPage: {
      ...EMPTY_SAVE_DATA.configurationPage,
      targetEnemyMarked:
        manual.follower?.marksTarget ??
        EMPTY_SAVE_DATA.configurationPage.targetEnemyMarked,
      customAffixLines: [...slateLines, ...followerLines, ...pactLines],
    },
  };

  const engineLines = [
    ...gear.flatMap(({ piece: g }) => [
      ...(g.baseAffixes ?? []),
      ...(g.legendaryAffixes ?? []),
      ...(g.prefixes ?? []),
      ...(g.suffixes ?? []),
      g.towerSequenceAffix,
      g.blendAffix,
      g.sweetDreamAffix,
    ]),
    ...heroMemories.flatMap((m) =>
      m === undefined
        ? []
        : [m.baseStat, ...m.fixedAffixes, ...m.randomAffixes],
    ),
    ...slateLines,
    ...followerLines,
    ...pactLines,
  ].filter((l): l is string => l !== undefined && l !== "");

  const skillSlot = login.SkillSlot as { costSlot?: unknown } | undefined;
  const wanted = [...new Set(list<number>(skillSlot?.costSlot))];
  return {
    save,
    capture: {
      schema: 2,
      source: "own-log",
      capturedAt: login.capturedAt,
      coverage: {
        skills: `${wanted.filter((w) => slotSkills.has(w)).length}/${wanted.length}`,
        skillsMissing: wanted.filter((w) => !slotSkills.has(w)),
        gear: `${gear.length}/10`,
        talentTrees: trees.map((t) => ({
          tree: t.treeName,
          points: t.nodes.reduce((sum, n) => sum + n.points, 0),
          cutOffAfter: t.cutOffAfter,
        })),
        missingSections: login._missing,
      },
      inferred,
      leftOut: {
        noRolledValue,
        noName,
        unknownGear,
        unreadSections: [...unreadSections],
      },
      // The engine drops a leading keyword tag like "[Gale]" before reading a line.
      unreadable: [
        ...new Set(
          engineLines.filter(
            (l) => parseMod(l.replace(/^\[[^\]]+\]\s*/, "")) === undefined,
          ),
        ),
      ],
    },
  };
};
