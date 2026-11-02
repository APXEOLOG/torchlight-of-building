# Importing a character from the game log

`src/scripts/import-log.ts` reads the character from the game's `UE_game.log` and saves it as a build the engine and the planner can open.

It only reads the log file. It never touches the game, its process, its config or its network traffic, because the game runs XD's Themis anti-cheat.

## First-time setup

Create `.player/config.json`, pointing at the game's log folder:

```json
{
  "logDir": "C:/Program Files (x86)/Steam/steamapps/common/Torchlight Infinite/UE_game/TorchLight/Saved/Logs"
}
```

Optionally create `.player/manual.json` for what the log can't give (see [Manual entries](#manual-entries)).

## Updating your build

The game writes your gear, skills and talents to the log only when you log in, so changes made in-game reach the log at your next login.

1. Change your character in-game, then log in again.
2. From the repo root, run the import while that log still exists. The game has only kept its current log and one backup so far, so don't wait long.

   ```bash
   pnpm exec tsx src/scripts/import-log.ts
   ```

3. Read the printed `capture` block. Everything but `inferred` should be empty or complete; [Reading the capture block](#reading-the-capture-block) says what to do if it isn't.
4. If you changed pactspirits or respecced a tree with hand-entered nodes, edit `.player/manual.json` and run the import again. Nothing re-reads that file on its own.
5. Open the result. With `pnpm dev` running, paste the contents of `.player/builds/own-<time>.code.txt` after `/import/` in the planner's address, for example `http://localhost:3000/import/<code>`. Each visit adds a new saved build in that browser. To use the build in a script, load its `save` field.

Each login gets its own build file, so earlier builds stay as they were. Running the import again rewrites the build for the latest login and leaves the others alone. To rebuild from an older login:

```bash
pnpm exec tsx src/scripts/import-log.ts --login login-<time>.json
```

To read specific logs instead of the configured folder, pass their paths as arguments.

## What goes where

`.player` is gitignored, because this is a public repo and these are one player's items. Don't commit it.

| Path | Contents |
|---|---|
| `config.json` | `logDir` |
| `manual.json` | Hand-entered pactspirit lines and talent nodes |
| `logins/login-<time>.json` | Each login dump, with only build sections kept and the player's ID removed |
| `sheets/sheets-<log name>.json` | Stat sheets the game logged, each marked `inViewer` if an imported build's viewer was open |
| `builds/own-<time>.build.json` | The build |
| `builds/own-<time>.code.txt` | The same `save` as a planner build code |

Keep `logins/`. The game cuts long lists at 30 entries at random, so gaps are filled from older logins, and the game deletes its old logs.

## Build format

A build file has two parts:

```json
{
  "capture": { "schema": 2, "source": "own-log", "capturedAt": "...", "coverage": {}, "inferred": [], "leftOut": {}, "unreadable": [] },
  "save": {}
}
```

`save` is the engine's own `SaveData` (`src/lib/schemas/save-data.schema.ts`), so anything that accepts a save accepts it: `loadSave()`, `calculateOffense()`, `encodeBuildCode()` and the planner.

### What fills the save

| In the save | From the log | Notes |
|---|---|---|
| `equipmentPage` | `wearItems` | 10 slots. Equipment type comes from the engine's base gear or legendary data, by name |
| `skillPage` | `dressSkillItems`, `skillLayout` | Active slots 1-5 and passive slots with their supports and levels |
| `talentPage` | `geniusInfos` | Tree, allocated nodes and core talents. The log's `x` is the row and `y` the column, both from 1; the save uses column then row, from 0 |
| `heroPage` | `heroCharacterv3OverView` | Hero, traits and memories |
| `configurationPage.customAffixLines` | `dressingTalentBlocks`, `manual.json` | Divinity slate lines and pactspirit lines, as plain text |

### What isn't converted

- **Slate layout:** slates go in as plain lines, because their effects don't depend on position and the log's shape IDs aren't the engine's. `divinityPage` stays empty.
- **Pactspirits:** `pactspiritPage` stays empty, and their stats come from `manual.json` as plain lines. `ContractInfosV2` is kept in the login file but not read.
- **Other tree effects:** `talentBlockInfluence` is kept in the login file but not read.
- **Legendary sections other than implicit, prefix and suffix:** these don't reach `legendaryAffixes`.
- **Vorax gear:** the engine's base gear list has no Vorax entries, so it's reported under `unknownGear`.
- **Heroes other than Rosa 2:** tlidb doesn't publish hero IDs, so `HEROES` in `src/player-log/login-to-save.ts` is entered by hand. Add a line with the engine's hero name for each new one. An unknown hero's ID is reported under `noName`.
- **Combat setup:** the log has no fight conditions, so the save uses the default configuration. Set conditions such as Frozen or blessings in the planner or the script that runs the build.

### capture fields

| Field | Meaning |
|---|---|
| `coverage.skills` | Skill slots found out of those the login says are in use |
| `coverage.skillsMissing` | Slots no login could fill |
| `coverage.gear` | Gear pieces converted, out of 10 |
| `coverage.talentTrees` | Each tree's name and points, with `cutOffAfter` if the log lost its end |
| `coverage.missingSections` | Sections absent from this login. `skills` is normally absent and isn't used |
| `inferred` | Values not stated by this login: skill slots from an older login, memory base stats worked out from their ID, and the level 1 trait |
| `leftOut.noRolledValue` | Lines still showing a range, so the log had no roll for them |
| `leftOut.noName` | Game IDs missing from the ID table |
| `leftOut.unknownGear` | Gear the engine's data doesn't have |
| `leftOut.unreadSections` | Affix sections on an item that the importer doesn't know |
| `unreadable` | Lines that reached the save but `parseMod` can't read, so they have no effect on damage |

## Reading the capture block

| You see | Do this |
|---|---|
| `cutOffAfter` on a tree | Add the rest of that tree to `talentNodes` in `manual.json` |
| `skillsMissing` not empty | Log in again: the game cuts different entries each time, and that login's list fills the gap for later imports |
| `noName` not empty | Run the post-patch steps below. If the IDs remain, tlidb doesn't list them yet |
| `unknownGear` not empty | The piece is missing from the save, so damage will be wrong. Regenerate the data; for Vorax gear, the engine doesn't support it yet |
| `unreadSections` not empty | Add the section to `SECTIONS` in `src/player-log/login-to-save.ts` and use it in `readGear` |
| `unreadable` includes a damage line | Add a parser with the `adding-mod-parsers` skill |
| `noRolledValue` not empty | Check the line in-game. If it matters, add it to the item by hand in the planner |

## Manual entries

`.player/manual.json` holds what the log can't give. All fields are optional:

```json
{
  "pactspiritLines": [
    "+5% additional damage",
    "+12% Attack Damage",
    "+12% Attack Damage"
  ],
  "talentNodes": {
    "Prophet": [
      { "x": 6, "y": 4, "points": 1 }
    ]
  },
  "follower": {
    "lines": ["+40% Projectile Speed", "+20% Attack and Cast Speed"],
    "marksTarget": true
  }
}
```

- **`pactspiritLines`:** one line per stat, repeated if a stat appears more than once, in the wording `parseMod` reads. Lines it can't read show up under `unreadable`.
- **`follower`:** the login doesn't list followers, so enter what their Tartarus skills give you. `lines` are plain stat lines, in the wording `parseMod` reads, and count as always active. `marksTarget` turns on Mark in the build's configuration, for a skill like Forking Thunder. In the save, follower lines sit between the slate lines and the pactspirit lines.
- **`talentNodes`:** keyed by the tree name shown in `coverage.talentTrees`, such as `Goddess_of_Hunting`. `x` is the column and `y` the row, both from 0, and `points` is how many points the node has.

Talent nodes are always added to what the log reports, so keep them in step with the game:

- Once a tree has hand-entered nodes, its `cutOffAfter` warning no longer appears, so you won't be told if the log's cut moves.
- List only nodes the log loses. A node listed in both places counts twice.
- After a respec, update or remove that tree's entry.

Manual entries apply to every build made after you edit the file, and existing builds keep the values they were made with.

## After a game patch

Regenerate the game data. The game ID table scans every cached page, so it runs last:

```bash
pnpm exec tsx src/scripts/generate.ts all --refetch
```

To rebuild only the ID table, drop the other generators:

```bash
pnpm exec tsx src/scripts/generate.ts game-ids
```

Check the counts it prints. It stops with an error if a group falls below its minimum in `MIN_COUNTS`, since a tlidb layout change can otherwise leave a table empty without any failure. Then log in and run the import, because old login files can name items that a new patch changed.

Existing build files don't change when the data does. They keep the text they were made with, which is what makes them usable as snapshots. To apply new data to an old login, rebuild it with `--login`.

## Code map

| File | Role |
|---|---|
| `src/player-log/parse-log.ts` | Log text to logins and stat sheets. Pure, with no file access |
| `src/player-log/login-to-save.ts` | Login to `{ capture, save }`. Pure; the ID table is passed in |
| `src/scripts/import-log.ts` | The command: finds logs and reads and writes `.player` |
| `src/scripts/lib/game-ids.ts` | Reads game IDs out of tlidb pages |
| `src/scripts/generate-game-ids.ts` | Fetches the extra pages it needs and writes `src/data/game-ids/game-ids.json` |

`game-ids.json` is JSON rather than generated TypeScript because it's over 2 MB, so Biome skips it. It shouldn't be imported by anything the web app loads.

### Privacy

`parse-log.ts` keeps only the sections in `SECTIONS` and `BAG_SECTIONS`, removes any ID-like value from the log's `player` section wherever it appears, and throws if one is still in the result. When adding a section, confirm it holds no account data. Tests must use a made-up log, never a real one.
