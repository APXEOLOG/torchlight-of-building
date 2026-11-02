import { execSync } from "node:child_process";
import { program } from "commander";

const GENERATORS = {
  skills: "generate-skill-data.ts",
  talents: "generate-talent-data.ts",
  "talent-trees": "generate-talent-tree-data.ts",
  "core-talents": "generate-core-talent-data.ts",
  "gear-affixes": "generate-gear-affix-data.ts",
  legendaries: "generate-legendary-data.ts",
  "hero-memories": "generate-hero-memory-data.ts",
  "hero-traits": "generate-hero-trait-data.ts",
  pactspirits: "generate-pactspirit-data.ts",
  prisms: "generate-prism-data.ts",
  blends: "generate-blend-data.ts",
  destinies: "generate-destiny-data.ts",
  vorax: "generate-vorax-data.ts",
  hyperlinks: "generate-hyperlink-data.ts",
  // Scans the pages the others cache, so it runs last.
  "game-ids": "generate-game-ids.ts",
} as const;

type GeneratorName = keyof typeof GENERATORS;

const GENERATOR_NAMES = Object.keys(GENERATORS) as GeneratorName[];

const runGenerator = (name: GeneratorName, refetch: boolean): void => {
  const script = GENERATORS[name];
  const refetchFlag = refetch ? " --refetch" : "";

  const cmd = `pnpm exec tsx src/scripts/${script}${refetchFlag}`;
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Running: ${name} (${cmd})`);
  console.log("=".repeat(60));
  execSync(cmd, { stdio: "inherit" });
};

interface Options {
  refetch: boolean;
}

program
  .description("Run one or more data generators")
  .argument(
    "<types...>",
    `Data types to generate: ${GENERATOR_NAMES.join(", ")}, all`,
  )
  .option("--refetch", "Refetch HTML pages from tlidb before generating")
  .action((types: string[], options: Options) => {
    const targets: GeneratorName[] = types.includes("all")
      ? GENERATOR_NAMES
      : types.map((t) => {
          if (!GENERATOR_NAMES.includes(t as GeneratorName)) {
            console.error(`Unknown generator: "${t}"`);
            console.error(`Available: ${GENERATOR_NAMES.join(", ")}, all`);
            process.exit(1);
          }
          return t as GeneratorName;
        });

    console.log(
      `Generating: ${targets.join(", ")}${options.refetch ? " (with refetch)" : ""}`,
    );

    for (const target of targets) {
      runGenerator(target, options.refetch);
    }

    console.log(`\nAll done! Generated ${targets.length} data type(s).`);
  })
  .parse();
