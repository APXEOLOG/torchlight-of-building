// Turns a parsed login into the engine's SaveData, plus a record of what it couldn't fill in.
// The game cuts long lists at random, so skill gaps are filled from the login's other lists, then from earlier logins.
import type { GameIdTable, GameIdText } from "@/src/data/game-ids/types";
import { ALL_BASE_GEAR } from "@/src/data/gear-base/all-base-gear";
import { Legendaries } from "@/src/data/legendary/legendaries";
import type { Gear } from "@/src/lib/save-data";
import {
  EMPTY_SAVE_DATA,
  type SaveData,
} from "@/src/lib/schemas/save-data.schema";
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
  Item: { BaseId: number; Level?: number };
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

const list = <T>(value: unknown): T[] =>
  Array.isArray(value) ? (value as T[]) : [];

const fmt = (v: number): string =>
  Number.isInteger(v) ? String(v) : String(Number(v.toFixed(2)));

// Puts rolled values into a tlidb template. If the log has fewer values than the text has numbers, the values belong to
// the ranged numbers: a fixed number like Gale's 60% isn't logged. A number with no rolled value keeps the page's own text.
export const renderText = (entry: GameIdText, values: number[]): string => {
  let next = 0;
  let i = 0;
  return entry.template.replace(/\+?#/g, (mark) => {
    const arg = entry.args[i];
    const takes = values.length >= entry.args.length || arg?.includes("–");
    i += 1;
    const v = takes === true ? values[next] : undefined;
    if (takes === true) next += 1;
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
        legendaryAffixes: [
          ...(parts.implicit ?? []),
          ...(parts.prefixes ?? []),
          ...(parts.suffixes ?? []),
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
  const slotSkills = new Map<number, { id: number; level?: number }>();
  const readSkills = (from: RawLogin, label: string | undefined): void => {
    const add = (slot: number, id: number, level?: number): void => {
      if (slotSkills.has(slot)) return;
      slotSkills.set(slot, { id, level });
      if (label !== undefined) inferred.push(`skill slot ${slot}: ${label}`);
    };
    for (const s of list<RawSkillItem>(from.dressSkillItems)) {
      add(s.Index, s.Item.BaseId, s.Item.Level);
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
  ): { name: string; level?: number } | undefined => {
    const skill = slotSkills.get(slot);
    if (skill === undefined) return undefined;
    const name = ids.skills[String(skill.id)]?.name;
    if (name === undefined) {
      noName.push(skill.id);
      return undefined;
    }
    return { name, level: skill.level };
  };
  const toSkill = (slot: number, supportSlots: number[]) => {
    const main = named(slot);
    if (main === undefined) return undefined;
    const supports = supportSlots.flatMap((s) => named(s) ?? []);
    return {
      skillName: main.name,
      enabled: true,
      level: main.level,
      supportSkills: Object.fromEntries(
        supports.map((x, i) => [
          i + 1,
          { skillType: "support" as const, name: x.name, level: x.level },
        ]),
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
