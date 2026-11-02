import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { program } from "commander";
import type { GameIdTable } from "../data/game-ids/types";
import {
  createGameIdTable,
  linkedItemPages,
  pageFileName,
  scanMemoryBaseStats,
  scanPage,
} from "./lib/game-ids";

const BASE_URL = "https://tlidb.com/en";
const TLIDB_DIR = join(process.cwd(), ".garbage", "tlidb");
const PAGE_DIR = join(TLIDB_DIR, "game-ids");
const OUT_DIR = join(process.cwd(), "src", "data", "game-ids");

// Pages only this generator needs. Legendary slates aren't on the legendary gear pages the other generators cache.
const FIXED_PAGES = [
  "Memory_of_Origin",
  "Memory_of_Discipline",
  "Memory_of_Progress",
  "Divinity_Slate",
  "Craft",
  "Sparks_of_Moth_Fire",
  "A_Corner_of_Divinity",
  "Space_Rift",
  "Pedigree_of_Gods",
  "Residence_of_Stars",
  "When_Sparks_Set_the_Prairie_Ablaze",
];
const ITEM_LIST_DIRS = ["gear", "vorax"];

// tlidb page layouts have changed before, which left generators exiting cleanly with empty data.
const MIN_COUNTS: Record<
  Exclude<keyof GameIdTable, "memoryBaseStats">,
  number
> = {
  skills: 700,
  items: 700,
  legendaries: 300,
  modifiers: 20000,
  talents: 1000,
  traits: 150,
};

const htmlFiles = (dir: string): string[] =>
  readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return htmlFiles(path);
      return name.endsWith(".html") ? [path] : [];
    });

const neededPages = (): string[] => {
  const linked = ITEM_LIST_DIRS.flatMap((dir) =>
    htmlFiles(join(TLIDB_DIR, dir)).flatMap((file) =>
      linkedItemPages(readFileSync(file, "utf8")),
    ),
  );
  return [...new Set([...FIXED_PAGES, ...linked])];
};

const fetchMissingPages = async (refetch: boolean): Promise<void> => {
  mkdirSync(PAGE_DIR, { recursive: true });
  const wanted = neededPages().filter(
    (name) => refetch || !existsSync(join(PAGE_DIR, pageFileName(name))),
  );
  console.log(`Fetching ${wanted.length} pages...`);
  for (const name of wanted) {
    const response = await fetch(`${BASE_URL}/${name}`, {
      headers: { "user-agent": "Mozilla/5.0" },
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch ${name}: ${response.status}`);
    }
    writeFileSync(join(PAGE_DIR, pageFileName(name)), await response.text());
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
};

const pageName = (file: string): string =>
  decodeURIComponent(basename(file, ".html"));

const main = async (options: { refetch: boolean }): Promise<void> => {
  await fetchMissingPages(options.refetch);

  const table = createGameIdTable();
  let conflicts = 0;
  const skillDir = join(TLIDB_DIR, "skill");
  for (const file of htmlFiles(TLIDB_DIR)) {
    conflicts += scanPage(table, {
      name: pageName(file),
      html: readFileSync(file, "utf8"),
      isSkill: file.startsWith(skillDir),
    });
  }
  scanMemoryBaseStats(
    table,
    readFileSync(join(PAGE_DIR, pageFileName("Memory_of_Origin")), "utf8"),
  );

  for (const [group, min] of Object.entries(MIN_COUNTS)) {
    const count = Object.keys(table[group as keyof typeof MIN_COUNTS]).length;
    console.log(`${group}: ${count}`);
    if (count < min) {
      throw new Error(`Expected at least ${min} ${group}, got ${count}`);
    }
  }
  console.log(`memory base stats: ${table.memoryBaseStats.length}`);
  if (table.memoryBaseStats.length === 0) {
    throw new Error("Expected memory base stats, got none");
  }
  console.log(`modifier text conflicts: ${conflicts}`);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "game-ids.json"), JSON.stringify(table));
  console.log("Wrote src/data/game-ids/game-ids.json");
};

program
  .description("Generate the table naming the game's own IDs from tlidb pages")
  .option("--refetch", "Refetch this generator's pages from tlidb")
  .action(async (options: { refetch?: boolean }) => {
    await main({ refetch: options.refetch === true });
  })
  .parseAsync();
