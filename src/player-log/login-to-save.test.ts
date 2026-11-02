import { describe, expect, test } from "vitest";
import type { GameIdTable } from "@/src/data/game-ids/types";
import { loginToBuild, renderText } from "./login-to-save";
import type { RawLogin } from "./parse-log";

const ids: GameIdTable = {
  skills: { 100: { name: "Frost Spike" }, 200: { name: "Haunt" } },
  items: {
    121: { name: "Silence Piercing Claw" },
    3811: { name: "Long Night Sorcerer's Mask" },
    71001: { name: "Memory of Origin" },
  },
  legendaries: { 77: { name: "Howling Wind" } },
  modifiers: {
    1: { template: "+#% Attack Speed", args: ["+(1–5)"] },
    2: { template: "+#% Max Life\n+#% Max Mana", args: ["+(1–5)", "+(1–5)"] },
    3: { template: "+#% Fire Damage", args: ["+(1–5)"] },
  },
  talents: {
    10: { name: "Spark", tree: "Prophet", text: "+5% Attack Speed" },
    11: { name: "Focus", tree: "Prophet", text: "+6% Cast Speed" },
  },
  traits: {
    1510001: { name: "Unsullied Blade", level: 1 },
    1510011: { name: "Baptism of Purity", level: 45 },
  },
  memoryBaseStats: [
    { template: "+# Strength", args: ["+(1–9)"] },
    { template: "+# Intelligence", args: ["+(1–9)"] },
  ],
};

const login = (over: Record<string, unknown> = {}): RawLogin => ({
  capturedAt: "2026-11-02T10:00:00Z",
  sourceLog: "UE_game.log",
  _missing: [],
  _truncated: [],
  ...over,
});

const build = (over: Record<string, unknown>, earlier: RawLogin[] = []) =>
  loginToBuild(login(over), earlier, ids);

describe("renderText", () => {
  test("fills every number when the log has them all", () => {
    const entry = { template: "+#% and #%", args: ["+(1–5)", "60"] };
    expect(renderText(entry, [3, 70])).toBe("+3% and 70%");
  });

  test("gives values to ranged numbers when the log has fewer", () => {
    const entry = { template: "#% and +#%", args: ["60", "+(1–5)"] };
    expect(renderText(entry, [3])).toBe("60% and +3%");
  });

  test("keeps tlidb's text for a number without a value", () => {
    expect(renderText({ template: "+#%", args: ["+(1–5)"] }, [])).toBe(
      "+(1–5)%",
    );
  });
});

describe("loginToBuild", () => {
  test("takes gear types from the engine's data", () => {
    const { save } = build({
      wearItems: [
        { Index: 1, Item: { BaseId: 3811, Prefix: [{ Id: 1, DynArgs: [4] }] } },
        { Index: 2, Item: { BaseId: 121 } },
      ],
    });
    expect(save.equipmentPage.inventory[0]).toMatchObject({
      id: "helmet",
      equipmentType: "Helmet (INT)",
      rarity: "rare",
      baseGearName: "Long Night Sorcerer's Mask",
      prefixes: ["+4% Attack Speed"],
    });
    expect(save.equipmentPage.inventory[1].equipmentType).toBe("Claw");
    expect(save.equipmentPage.equippedGear.mainHand).toEqual({
      id: "mainHand",
    });
  });

  test("reports gear the engine doesn't know instead of guessing a type", () => {
    const { save, capture } = build({
      wearItems: [{ Index: 2, Item: { BaseId: 999 } }],
    });
    expect(save.equipmentPage.inventory).toEqual([]);
    expect(capture.leftOut.unknownGear).toEqual([
      "mainHand: base 999 (undefined)",
    ]);
    expect(capture.coverage.gear).toBe("0/10");
  });

  test("splits lines, leaves out unrolled ones and reports unknown IDs", () => {
    const { save, capture } = build({
      wearItems: [
        {
          Index: 2,
          Item: {
            BaseId: 121,
            Prefix: [{ Id: 2, DynArgs: [4] }, { Id: 9 }],
            Suffix: [{ Id: 3 }],
          },
        },
      ],
    });
    const [gear] = save.equipmentPage.inventory;
    expect(gear.prefixes).toEqual(["+4% Max Life"]);
    expect(gear.suffixes).toEqual([]);
    expect(capture.leftOut.noRolledValue).toEqual([
      "+(1–5)% Max Mana",
      "+(1–5)% Fire Damage",
    ]);
    expect(capture.leftOut.noName).toEqual([9]);
  });

  test("fills skills missing from a cut list using earlier logins", () => {
    const earlier = login({
      capturedAt: "2026-11-01T10:00:00Z",
      skillLayout: { slots: [{ key: 101, value: { skillId: "200_1" } }] },
    });
    const { save, capture } = build(
      {
        SkillSlot: { costSlot: [1, 101, 102] },
        dressSkillItems: [{ Index: 1, Item: { BaseId: 100, Level: 21 } }],
      },
      [earlier],
    );
    const slot = save.skillPage.activeSkills[1];
    expect(slot).toMatchObject({ skillName: "Frost Spike", level: 21 });
    expect(slot?.supportSkills[1]).toMatchObject({ name: "Haunt" });
    expect(capture.coverage.skills).toBe("2/3");
    expect(capture.coverage.skillsMissing).toEqual([102]);
    expect(capture.inferred).toContain(
      "skill slot 101: from 2026-11-01T10:00:00Z",
    );
  });

  test("converts talent positions and flags a tree the game cut", () => {
    const geniusList = Array.from({ length: 30 }, (_, i) => ({
      geniusId: 10,
      point: i === 0 ? 2 : 0,
      position: { x: 3, y: 5 },
    }));
    const { save, capture } = build({
      geniusInfos: {
        info: [
          {
            geniusList,
            bonusGeniusInfo: [{ key: 1, value: { geniusId: 11 } }],
          },
        ],
      },
    });
    expect(save.talentPage.talentTrees.tree1).toEqual({
      name: "Prophet",
      allocatedNodes: [{ x: 4, y: 2, points: 2 }],
      selectedCoreTalents: ["Focus"],
    });
    expect(capture.coverage.talentTrees[0].cutOffAfter).toEqual({ x: 4, y: 2 });
  });

  test("hand-entered nodes and pactspirit lines join the save", () => {
    const { save, capture } = loginToBuild(
      login({
        geniusInfos: {
          info: [
            {
              geniusList: [
                { geniusId: 10, point: 1, position: { x: 1, y: 1 } },
              ],
            },
          ],
        },
      }),
      [],
      ids,
      {
        pactspiritLines: ["+2% additional damage"],
        talentNodes: { Prophet: [{ x: 6, y: 4, points: 3 }] },
      },
    );
    expect(save.talentPage.talentTrees.tree1?.allocatedNodes).toEqual([
      { x: 0, y: 0, points: 1 },
      { x: 6, y: 4, points: 3 },
    ]);
    expect(save.configurationPage.customAffixLines).toEqual([
      "+2% additional damage",
    ]);
    expect(capture.coverage.talentTrees[0].points).toBe(4);
  });

  test("adds follower lines before pactspirit lines and marks the target", () => {
    const { save, capture } = loginToBuild(login({}), [], ids, {
      pactspiritLines: ["+2% additional damage"],
      follower: {
        lines: ["+40% Projectile Speed", "This line means nothing"],
        marksTarget: true,
      },
    });
    expect(save.configurationPage.customAffixLines).toEqual([
      "+40% Projectile Speed",
      "This line means nothing",
      "+2% additional damage",
    ]);
    expect(save.configurationPage.targetEnemyMarked).toBe(true);
    expect(capture.unreadable).toEqual(["This line means nothing"]);
  });

  test("reads hero, traits and memories, inferring the base stat by ID", () => {
    const { save, capture } = build({
      heroCharacterv3OverView: {
        heroPurchaseId: 15002,
        pointOverView: { activeId: [1510011] },
        reminiscenceOverView: {
          reminiscence: [
            {
              index: 1,
              detail: {
                BaseId: 71001,
                ReminiscenceLevel: 40,
                ReminiscenceFixedLevel: 2,
                ReminiscenceFixedLevelFromEnhance: 1,
                BaseAttrAffix: [{ Id: 403102411, DynArgs: [90] }],
              },
            },
          ],
        },
      },
    });
    expect(save.heroPage.selectedHero).toBe(
      "Lightbringer Rosa: Unsullied Blade (#2)",
    );
    expect(save.heroPage.traits.level1).toEqual({ name: "Unsullied Blade" });
    expect(save.heroPage.traits.level45).toEqual({ name: "Baptism of Purity" });
    expect(save.heroPage.memorySlots.slot45).toMatchObject({
      memoryType: "Memory of Origin",
      baseStat: "+90 Intelligence",
      fixedAffixes: ["+1 to Hero Trait Level"],
    });
    expect(capture.inferred).toContain("memory base stat: +90 Intelligence");
  });

  test("slates go in as plain lines", () => {
    const { save } = build({
      dressingTalentBlocks: [
        { Index: 1, Item: { BaseTalentList: [10], EnchantTalentList: [11] } },
      ],
    });
    expect(save.configurationPage.customAffixLines).toEqual([
      "+5% Attack Speed",
      "+6% Cast Speed",
    ]);
  });

  test("lists lines the engine can't read", () => {
    const { capture } = loginToBuild(login(), [], ids, {
      pactspiritLines: ["This line means nothing"],
    });
    expect(capture.unreadable).toEqual(["This line means nothing"]);
  });
});
