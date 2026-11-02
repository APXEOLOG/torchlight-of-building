import { describe, expect, test } from "vitest";
import { parseGameLog } from "./parse-log";

const PLAYER_ID = "1234567890123";

const dump = [
  "[2026.11.02-10.00.00:000][  0]LogTemp: login",
  `+player +id [${PLAYER_ID}]`,
  "+skillLayout +slots +1 +key [1]",
  "|            |      |  +value +skillId [100_2]",
  "+SkillSlot +costSlot +1 [1]",
  "|          |         +2 [101]",
  "|          |         +... [more]",
  "+bag +wearItems +1 +Index [2]",
  "|    |          |  +Item +BaseId [121]",
  "|    |          |  |     +Note [sent by 1234567890123]",
  "|    |          +2 +...",
  "+chat +text [not a build section]",
  "[2026.11.02-10.00.01:000][  0]LogTemp: done",
];

const sheetLine = (time: string, text: string): string =>
  `[2026.11.02-${time}:000][  0]LogLua: RoleAttrMgr@${text}`;

const sheets = [
  "[2026.11.02-11.00.00:000][  0]Log: ViewPlayerBDReference PageRunState = Run",
  sheetLine("11.00.01", "Attri.Id Attack DPS 1"),
  sheetLine("11.00.01", "[1] = 500.5 [2] = nil"),
  "[2026.11.02-11.00.02:000][  0]Log: ViewPlayerBDReference PageRunState = Destory",
  sheetLine("11.00.03", "Attri.Id Attack DPS 1"),
  sheetLine("11.00.03", "[1] = 700"),
  sheetLine("11.00.03", "Attri.Id Projectile Speed 2"),
  sheetLine("11.00.03", "[1] = 343"),
];

describe("parseGameLog", () => {
  test("reads a login's sections into typed values and lists", () => {
    const [login] = parseGameLog(dump.join("\r\n"), "UE_game.log").logins;
    expect(login.capturedAt).toBe("2026-11-02T10:00:00Z");
    expect(login.skillLayout).toEqual({
      slots: [{ key: 1, value: { skillId: "100_2" } }],
    });
    expect(login.SkillSlot).toEqual({ costSlot: [1, 101] });
    expect(login.wearItems).toEqual([
      { Index: 2, Item: { BaseId: 121, Note: "sent by <removed>" } },
    ]);
  });

  test("never returns the player's ID or sections it doesn't know", () => {
    const [login] = parseGameLog(dump.join("\n"), "UE_game.log").logins;
    const text = JSON.stringify(login);
    expect(text).not.toContain(PLAYER_ID);
    expect(text).not.toContain("not a build section");
    expect(login.player).toBeUndefined();
  });

  test("records lists the game cut and sections it left out", () => {
    const [login] = parseGameLog(dump.join("\n"), "UE_game.log").logins;
    expect(login._truncated).toEqual(["/SkillSlot/costSlot", "/wearItems"]);
    expect(login._missing).toContain("geniusInfos");
    expect(login._missing).not.toContain("wearItems");
  });

  test("ignores blocks without a skill layout", () => {
    const text = ["+bag +wearItems +1 +Index [2]", "plain line"].join("\n");
    expect(parseGameLog(text, "UE_game.log").logins).toEqual([]);
  });

  test("marks stat sheets from an imported build's viewer", () => {
    const parsed = parseGameLog(sheets.join("\n"), "UE_game.log").sheets;
    expect(parsed).toEqual([
      {
        time: "11.00.01:000",
        inViewer: true,
        stats: { "Attack DPS": [500.5] },
      },
      {
        time: "11.00.03:000",
        inViewer: false,
        stats: { "Attack DPS": [700], "Projectile Speed": [343] },
      },
    ]);
  });
});
