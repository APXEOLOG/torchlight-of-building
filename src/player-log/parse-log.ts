// Reads the login dumps and stat sheets the game writes to UE_game.log. It only ever sees the log's text.
// Only the build sections below are kept, and the player's ID is never returned.

const SECTIONS = [
  "heroCharacterv3OverView",
  "skillLayout",
  "SkillSlot",
  "skills",
  "geniusInfos",
  "ContractInfosV2",
  "talentBlockInfluence",
];
const BAG_SECTIONS = ["wearItems", "dressSkillItems", "dressingTalentBlocks"];
const TIME = /^\[(\d{4})\.(\d+)\.(\d+)-(\d+)\.(\d+)\.(\d+)/;
const PRIVATE = /^(\d{8,}|[0-9a-fA-F-]{16,})$/;
const SHEET_LINE = /^\[\d{4}\.\d+\.\d+-([\d.:]+)\]\[.*RoleAttrMgr@(.*)$/;
const SHEET_ATTR = /Attri\.Id\s+(.*?)\s+(-?\d+)\s*$/;
const SHEET_VALUE = /\[\d+\] = (-?[\d.]+|nil)/g;

type Tree = { [key: string]: Tree | string };

export interface RawLogin {
  capturedAt: string | undefined;
  sourceLog: string;
  _missing: string[];
  _truncated: string[];
  [section: string]: unknown;
}

export interface StatSheet {
  time: string;
  inViewer: boolean;
  stats: Record<string, number[]>;
}

const splitLines = (text: string): string[] => text.split(/\r\n|\n|\r/);

// A key's parent comes from the column of its +, so field order doesn't matter.
const parseTree = (lines: string[]): Tree => {
  const root: Tree = {};
  const stack: { column: number; node: Tree }[] = [{ column: -1, node: root }];
  for (const raw of lines) {
    const split = raw.indexOf(" [");
    const head = split < 0 ? raw : raw.slice(0, split);
    const tail = split < 0 ? "" : raw.slice(split + 2);
    const value = tail.endsWith("]") ? tail.slice(0, -1) : undefined;
    const tokens = [...head.matchAll(/\+([^+\s[]+)/g)];
    tokens.forEach((token, i) => {
      while (stack[stack.length - 1].column >= token.index) stack.pop();
      const parent = stack[stack.length - 1].node;
      const key = token[1];
      if (i === tokens.length - 1 && value !== undefined) {
        parent[key] = value;
        return;
      }
      let child = Object.hasOwn(parent, key) ? parent[key] : undefined;
      if (child === undefined) {
        child = {};
        parent[key] = child;
      } else if (typeof child === "string") {
        child = { _value: child };
        parent[key] = child;
      }
      stack.push({ column: token.index, node: child });
    });
  }
  return root;
};

const scalar = (text: string): boolean | number | string => {
  if (text === "true" || text === "false") return text === "true";
  if (/^-?\d{1,15}$/.test(text) || /^-?\d+\.\d+$/.test(text)) {
    return Number(text);
  }
  return text;
};

// Turns numbered keys into lists and typed values, and records where the game cut a list at 30 entries.
const clean = (node: Tree | string, path: string, cuts: string[]): unknown => {
  if (typeof node === "string") return scalar(node);
  const all = Object.keys(node);
  const cut = all.includes("...");
  if (cut && all.length === 1) return undefined;
  const keys = all.filter((k) => k !== "...");
  const numbered = keys.length > 0 && keys.every((k) => /^\d+$/.test(k));
  if (cut) cuts.push(path);
  const done: Record<string, unknown> = {};
  for (const key of keys) {
    const part = numbered ? "#" : key;
    const value = clean(node[key], `${path}/${part}`, cuts);
    if (value === undefined) cuts.push(path);
    else done[key] = value;
  }
  if (!numbered) return done;
  return Object.keys(done)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => done[k]);
};

const privateValues = (node: Tree | string | undefined): string[] => {
  if (node === undefined) return [];
  if (typeof node === "string") return PRIVATE.test(node) ? [node] : [];
  return Object.values(node).flatMap(privateValues);
};

const scrub = (node: unknown, secrets: string[]): unknown => {
  if (Array.isArray(node)) return node.map((v) => scrub(v, secrets));
  if (typeof node === "object" && node !== null) {
    return Object.fromEntries(
      Object.entries(node).map(([k, v]) => [k, scrub(v, secrets)]),
    );
  }
  if (typeof node !== "string" && typeof node !== "number") return node;
  const text = String(node);
  const scrubbed = secrets.reduce(
    (t, secret) => t.replaceAll(secret, "<removed>"),
    text,
  );
  return scrubbed === text ? node : scrubbed;
};

const convertLogin = (
  capturedAt: string | undefined,
  lines: string[],
  sourceLog: string,
): RawLogin => {
  const tree = parseTree(lines);
  const secrets = [...new Set(privateValues(tree.player))];
  const cuts: string[] = [];
  const out: Record<string, unknown> = {};
  for (const name of SECTIONS) {
    if (tree[name] !== undefined) {
      out[name] = clean(tree[name], `/${name}`, cuts);
    }
  }
  const bag = tree.bag;
  if (typeof bag === "object") {
    for (const name of BAG_SECTIONS) {
      if (bag[name] !== undefined) {
        out[name] = clean(bag[name], `/${name}`, cuts);
      }
    }
  }
  const scrubbed = scrub(out, secrets) as Record<string, unknown>;
  const login: RawLogin = {
    capturedAt,
    sourceLog,
    ...scrubbed,
    _missing: [...SECTIONS, ...BAG_SECTIONS].filter(
      (name) => out[name] === undefined,
    ),
    _truncated: [...new Set(cuts)].sort(),
  };
  const written = JSON.stringify(login);
  if (secrets.some((secret) => written.includes(secret))) {
    throw new Error("A private value is still in the login; nothing returned");
  }
  return login;
};

const parseLogins = (lines: string[], sourceLog: string): RawLogin[] => {
  const logins: RawLogin[] = [];
  let block: string[] = [];
  let found = false;
  let time: string | undefined;
  for (const line of lines) {
    if (line.startsWith("+") || line.startsWith("|")) {
      block.push(line);
      found = found || line.startsWith("+skillLayout");
      continue;
    }
    if (found) logins.push(convertLogin(time, block, sourceLog));
    block = [];
    found = false;
    const m = line.match(TIME);
    if (m !== null) {
      time = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
    }
  }
  if (found) logins.push(convertLogin(time, block, sourceLog));
  return logins;
};

// The time spans when an imported build's viewer was open. Stat sheets inside them aren't the player's.
const viewerSpans = (lines: string[]): [string, string][] => {
  const spans: [string, string][] = [];
  let start: string | undefined;
  for (const line of lines) {
    if (
      !line.includes("ViewPlayerBDReference") ||
      !line.includes("PageRunState")
    ) {
      continue;
    }
    const t = line.match(TIME);
    const stamp = t === null ? "" : `${t[4]}.${t[5]}.${t[6]}`;
    if (line.includes("PageRunState = Run") && start === undefined) {
      start = stamp;
    } else if (line.includes("PageRunState = Destory") && start !== undefined) {
      spans.push([start, stamp]);
      start = undefined;
    }
  }
  if (start !== undefined) spans.push([start, "99"]);
  return spans;
};

const parseSheets = (lines: string[]): StatSheet[] => {
  const spans = viewerSpans(lines);
  const sheets: StatSheet[] = [];
  let current: StatSheet | undefined;
  let name: string | undefined;
  for (const line of lines) {
    const m = line.match(SHEET_LINE);
    if (m === null) continue;
    const attr = m[2].match(SHEET_ATTR);
    if (attr !== null) {
      // A sheet starts with Attack DPS.
      if (attr[1] === "Attack DPS") {
        const clock = m[1].split(":")[0];
        current = {
          time: m[1],
          inViewer: spans.some(([a, b]) => a <= clock && clock <= b),
          stats: {},
        };
        sheets.push(current);
      }
      name = attr[1];
    } else if (current !== undefined && name !== undefined) {
      current.stats[name] = [...m[2].matchAll(SHEET_VALUE)]
        .filter((v) => v[1] !== "nil")
        .map((v) => Number(v[1]));
      name = undefined;
    }
  }
  return sheets;
};

export const parseGameLog = (
  text: string,
  sourceLog: string,
): { logins: RawLogin[]; sheets: StatSheet[] } => {
  const lines = splitLines(text);
  return { logins: parseLogins(lines, sourceLog), sheets: parseSheets(lines) };
};
