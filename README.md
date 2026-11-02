# Torchlight of Building

Torchlight Infinite character build planner and dps calculator.

## Getting Started

```bash
pnpm install
pnpm lingui:compile
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Importing your character

You can import your character from the game's log. See [docs/claude/player-import.md](docs/claude/player-import.md).

## Want to contribute? 

* Reach out to me on discord. I am aclinia on the torchlight infinite.
* Currently accepting contributions, but I have limited bandwidth for onboarding for the next few weeks, so you'll have to figure out things on your own for the most part
* Basic rules of contribution:
  * All code contributions MUST BE MANUALLY VERIFIED FOR CORRECTNESS by the author. I don't care if you hand write or use AI, it has to be good code quality and correct.
  * I will not be accepting code contributions that affect core system infrastructure, such as the calculation scaffolding, as it is too important and I need to maintain a good mental model of it for now
  * Currently, the easiest ways to help would probably be: creating more affix templates, supporting new mods in the existing calculation framework, adding data overrides for when tlidb is incorrect, adding hero traits, skills.
