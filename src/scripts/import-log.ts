// Reads UE_game.log and saves the character as a build the engine and planner can open.
// Everything it writes goes to .player, which git ignores: this is a public repo and these are one player's own items.
// It only reads the log file, and never touches the game or its process.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { program } from "commander";
import type { GameIdTable } from "../data/game-ids/types";
import { encodeBuildCode } from "../lib/build-code";
import { loginToBuild, type ManualEntries } from "../player-log/login-to-save";
import { parseGameLog, type RawLogin } from "../player-log/parse-log";

const PLAYER_DIR = join(process.cwd(), ".player");
const LOGIN_DIR = join(PLAYER_DIR, "logins");
const SHEET_DIR = join(PLAYER_DIR, "sheets");
const BUILD_DIR = join(PLAYER_DIR, "builds");
const CONFIG_FILE = join(PLAYER_DIR, "config.json");
const MANUAL_FILE = join(PLAYER_DIR, "manual.json");
const IDS_FILE = join(
  process.cwd(),
  "src",
  "data",
  "game-ids",
  "game-ids.json",
);

const readJson = <T>(path: string): T =>
  JSON.parse(readFileSync(path, "utf8")) as T;

const defaultLogs = (): string[] => {
  if (!existsSync(CONFIG_FILE)) {
    throw new Error(
      `Pass log files, or set "logDir" in ${CONFIG_FILE} to the game's Saved/Logs folder`,
    );
  }
  const { logDir } = readJson<{ logDir: string }>(CONFIG_FILE);
  return readdirSync(logDir)
    .filter((f) => /^UE_game.*\.log$/.test(f))
    .sort()
    .map((f) => join(logDir, f));
};

const loginFile = (login: RawLogin): string =>
  `login-${(login.capturedAt ?? "unknown").replace(/[:-]/g, "")}.json`;

const importLogs = (paths: string[]): void => {
  mkdirSync(LOGIN_DIR, { recursive: true });
  mkdirSync(SHEET_DIR, { recursive: true });
  for (const path of paths) {
    const name = basename(path);
    const { logins, sheets } = parseGameLog(readFileSync(path, "utf8"), name);
    for (const login of logins) {
      writeFileSync(join(LOGIN_DIR, loginFile(login)), JSON.stringify(login));
      console.log(
        `${loginFile(login)} missing: ${login._missing.join(", ") || "none"} | cut lists: ${login._truncated.length}`,
      );
    }
    writeFileSync(
      join(SHEET_DIR, `sheets-${basename(path, ".log")}.json`),
      JSON.stringify({ sourceLog: name, sheets }),
    );
    console.log(
      `${name} stat sheets: ${sheets.length}, own: ${sheets.filter((s) => !s.inViewer).length}`,
    );
  }
};

const writeBuild = (target: string | undefined): void => {
  const files = readdirSync(LOGIN_DIR)
    .filter((f) => f.startsWith("login-"))
    .sort();
  const file = target === undefined ? files.at(-1) : basename(target);
  if (file === undefined) throw new Error("The logs have no login dumps");
  if (!files.includes(file)) throw new Error(`No such login: ${file}`);
  const earlier = files
    .filter((f) => f < file)
    .reverse()
    .map((f) => readJson<RawLogin>(join(LOGIN_DIR, f)));
  const manual = existsSync(MANUAL_FILE)
    ? readJson<ManualEntries>(MANUAL_FILE)
    : {};
  const build = loginToBuild(
    readJson<RawLogin>(join(LOGIN_DIR, file)),
    earlier,
    readJson<GameIdTable>(IDS_FILE),
    manual,
  );
  mkdirSync(BUILD_DIR, { recursive: true });
  const stem = file.replace("login-", "own-").replace(".json", "");
  writeFileSync(
    join(BUILD_DIR, `${stem}.build.json`),
    JSON.stringify(build, null, 1),
  );
  writeFileSync(
    join(BUILD_DIR, `${stem}.code.txt`),
    encodeBuildCode(build.save),
  );
  console.log(`\n.player/builds/${stem}.build.json`);
  console.log(JSON.stringify(build.capture, null, 1));
};

program
  .description("Import the character from UE_game.log into .player/builds")
  .argument("[logs...]", "Log files; defaults to logDir in .player/config.json")
  .option("--login <file>", "Build from this login instead of the latest")
  .action((logs: string[], options: { login?: string }) => {
    importLogs(logs.length > 0 ? logs : defaultLogs());
    writeBuild(options.login);
  })
  .parse();
