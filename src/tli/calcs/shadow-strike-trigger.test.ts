import { describe, expect, test } from "vitest";
import {
  type AffixLine,
  type BaseSupportSkillSlot,
  DEFAULT_CONFIGURATION,
  type Loadout,
} from "../core";
import type { Mod } from "../mod";
import { parseMod } from "../mod-parser";
import { parseSupportAffixes } from "../skills/support-mod-templates";
import { calculateOffense } from "./offense";

const sword = {
  equipmentType: "One-Handed Sword" as const,
  baseStats: {
    baseStatLines: [
      {
        text: "100 - 100 physical damage",
        mods: [{ type: "GearBasePhysDmg", value: 100 } as const],
      },
      {
        text: "1.5 attack speed",
        mods: [{ type: "GearBaseAttackSpeed", value: 1.5 } as const],
      },
    ],
  },
};

const lines = (mods: Mod[]): AffixLine[] =>
  mods.map((mod) => ({ text: "", mods: [mod] }));

const wrathfulVault: BaseSupportSkillSlot = {
  skillType: "noble_support",
  name: "Groundshaker: Wrathful Vault (Noble)",
  tier: 0,
  rank: 1,
  affixes: [
    { text: "", mods: [{ mod: { type: "SkillGainsTag", tag: "Mobility" } }] },
  ],
};

const loadout = (
  mods: Mod[],
  groundshakerSupports: Record<number, BaseSupportSkillSlot> = {
    1: wrathfulVault,
  },
): Loadout => ({
  gearPage: { equippedGear: { mainHand: sword }, inventory: [] },
  talentPage: {
    talentTrees: {},
    inventory: { prismList: [], inverseImageList: [] },
  },
  divinityPage: { placedSlates: [], inventory: [] },
  skillPage: {
    activeSkills: {
      1: {
        skillName: "Frost Spike",
        enabled: true,
        level: 20,
        supportSkills: {},
      },
      2: {
        skillName: "Groundshaker",
        enabled: true,
        level: 20,
        supportSkills: groundshakerSupports,
      },
    },
    passiveSkills: {},
  },
  heroPage: {
    selectedHero: undefined,
    traits: {},
    memorySlots: {},
    memoryInventory: [],
  },
  pactspiritPage: {},
  customAffixLines: lines(mods),
});

const run = (l: Loadout) =>
  calculateOffense({ loadout: l, configuration: DEFAULT_CONFIGURATION });

describe("Banishment: Shadow Strike", () => {
  const trigger: Mod = {
    type: "TriggerMainShadowStrikeOnAtkMobility",
    value: 2,
  };

  test("parses the effect line", () => {
    expect(
      parseMod(
        "Triggers the Main Shadow Strike Skill 2 time(s) when casting an Attack Mobility Skill",
      ),
    ).toEqual([trigger]);
  });

  test("Wrathful Vault gives Groundshaker the Mobility tag", () => {
    const [tagMods] = parseSupportAffixes([
      "The supported skill is now cast when jumping forward and creates fissures upon landing. The supported skill can no longer be triggered",
    ]);
    expect(tagMods).toEqual([
      { mod: { type: "SkillGainsTag", tag: "Mobility" } },
    ]);
  });

  test("the main Shadow Strike skill hits twice per Attack Mobility cast", () => {
    const plain = run(loadout([])).skills["Frost Spike"];
    const triggered = run(loadout([trigger]));
    const fs = triggered.skills["Frost Spike"];
    const gs = triggered.skills.Groundshaker;
    expect(plain?.trigger).toBeUndefined();
    expect(fs?.trigger?.bySkill).toBe("Groundshaker");
    const castsPerSec = gs?.attackDpsSummary?.mainhand.aspd ?? 0;
    const ownPerSec = plain?.attackDpsSummary?.mainhand.aspd ?? 1;
    expect(fs?.trigger?.castsPerSec).toBeCloseTo(castsPerSec);
    expect(fs?.totalDps).toBeCloseTo(
      ((plain?.totalDps ?? 0) * 2 * castsPerSec) / ownPerSec,
    );
  });

  test("no trigger without an Attack Mobility skill", () => {
    const fs = run(loadout([trigger], {})).skills["Frost Spike"];
    expect(fs?.trigger).toBeUndefined();
  });

  test("Movement Speed converts to attack speed for Mobility skills only", () => {
    const conversion = parseMod(
      "70% of the bonuses for Movement Speed is also applied to the Attack and Cast Speed of Mobility Skills",
    );
    const ms: Mod = { type: "MovementSpeedPct", value: 100 };
    const base = run(loadout([ms]));
    const converted = run(loadout([ms, ...(conversion ?? [])]));
    const aspd = (r: typeof base, name: "Frost Spike" | "Groundshaker") =>
      r.skills[name]?.attackDpsSummary?.mainhand.aspd ?? 0;
    expect(aspd(base, "Groundshaker")).toBeGreaterThan(0);
    expect(aspd(converted, "Frost Spike")).toBeCloseTo(
      aspd(base, "Frost Spike"),
    );
    expect(aspd(converted, "Groundshaker")).toBeCloseTo(
      aspd(base, "Groundshaker") * 1.7,
    );
  });
});
