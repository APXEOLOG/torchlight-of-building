import { describe, expect, test } from "vitest";
import {
  createGameIdTable,
  linkedItemPages,
  pageFileName,
  scanMemoryBaseStats,
  scanPage,
} from "./game-ids";

const scan = (html: string, name = "Page", isSkill = false) => {
  const table = createGameIdTable();
  scanPage(table, { name, html, isSkill });
  return table;
};

describe("scanPage", () => {
  test("marks a modifier's numbers and keeps tlidb's ranges", () => {
    const table = scan(
      '<span data-modifier-id="5">Up to <span class="text-mod">+(1&ndash;5)</span>% and <span class="text-mod">60</span>%</span>',
    );
    expect(table.modifiers[5]).toEqual({
      template: "Up to +#% and #%",
      args: ["+(1–5)", "60"],
    });
  });

  test("keeps the first text and counts conflicts", () => {
    const table = createGameIdTable();
    const page = (text: string) => ({
      name: "Page",
      html: `<span data-modifier-id="5">${text}</span>`,
      isSkill: false,
    });
    expect(scanPage(table, page("First"))).toBe(0);
    expect(scanPage(table, page("Second"))).toBe(1);
    expect(table.modifiers[5].template).toBe("First");
  });

  test("uses a talent's first attr block, not its Prophecy variants", () => {
    const table = scan(
      '<span class="talent-node-name" data-talent-id="9">Spark</span><div data-source="attr">+5% Attack Speed</div><div data-source="attr">+9% Attack Speed</div>',
      "Prophet",
    );
    expect(table.talents[9]).toEqual({
      name: "Spark",
      tree: "Prophet",
      text: "+5% Attack Speed",
    });
  });

  test("files a page's ID by what the page is", () => {
    const page = "<h1>Nailclaw</h1><div>id: 100</div>";
    expect(scan(page).items[100]).toEqual({ name: "Nailclaw" });
    expect(scan(page, "Page", true).skills[100]).toEqual({ name: "Nailclaw" });
  });

  test("keeps legendary numbers apart from base items", () => {
    const table = scan(
      '<a data-hover="?s=ItemGold%2F1001" href="Sparks">Sparks</a><a data-hover="?s=ItemBase%2F260201" href="Slate">Slate</a><h1>Sparks</h1><li>id: 1001</li>',
    );
    expect(table.legendaries[1001]).toEqual({ name: "Sparks" });
    expect(table.items[1001]).toBeUndefined();
    expect(table.items[260201]).toEqual({ name: "Slate" });
  });

  test("reads hero traits with their level", () => {
    const table = scan(
      '<div class="fw-bold" data-id="7">Blade</div><div class="fw-bold" data-id="8">Born</div>Require lv 45',
    );
    expect(table.traits[7]).toEqual({ name: "Blade", level: 1 });
    expect(table.traits[8].name).toBe("Born");
  });
});

test("memory base stats keep the tab's order without repeats", () => {
  const table = createGameIdTable();
  const stat = (id: number, name: string, value: number): string =>
    `<span data-modifier-id="${id}"><span class="text-mod">+${value}</span> ${name}</span>`;
  scanMemoryBaseStats(
    table,
    `<div id="BaseStats">${stat(1, "Strength", 88)}${stat(2, "Strength", 86)}${stat(3, "Dexterity", 80)}</div><div id="FixedAffix">${stat(4, "Other", 1)}</div>`,
  );
  expect(table.memoryBaseStats.map((s) => s.template)).toEqual([
    "+# Strength",
    "+# Dexterity",
  ]);
});

test("finds linked item pages once each", () => {
  const link = '<a data-hover="/cache/x" href="Nailclaw">Nailclaw</a>';
  expect(linkedItemPages(link + link)).toEqual(["Nailclaw"]);
});

test("page file names can be turned back into page names", () => {
  const file = pageFileName("Ralph's_Journey");
  expect(file).toBe("Ralph%27s_Journey.html");
  expect(decodeURIComponent(file)).toBe("Ralph's_Journey.html");
});
