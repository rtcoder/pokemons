#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const booleanOptions = new Set([
  "help",
  "dry-run",
  "force",
  "refresh-list",
  "refresh-models-list",
  "include-all-images",
  "skip-pokeapi",
  "skip-images",
  "skip-models",
  "skip-build-data",
  "skip-clean",
  "skip-ui-index",
]);

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

const sharedSelection = pickDefined({
  limit: args.limit,
  offset: args.offset,
});

const steps = [
  {
    name: "Download PokeAPI data",
    skip: args.skipPokeapi,
    command: script("download-pokeapi.mjs", {
      ...sharedSelection,
      concurrency: args.pokeapiConcurrency,
      referenceConcurrency: args.referenceConcurrency,
      retries: args.retries,
      force: args.force,
      refreshList: args.refreshList,
    }),
  },
  {
    name: "Download Pokemon images",
    skip: args.skipImages,
    command: script("download-pokemon-images.mjs", {
      ...sharedSelection,
      concurrency: args.imageConcurrency,
      retries: args.retries,
      force: args.force,
      includeAllImages: args.includeAllImages,
    }),
  },
  {
    name: "Download Pokemon models",
    skip: args.skipModels,
    command: script("download-pokemon-models.mjs", {
      ...sharedSelection,
      concurrency: args.modelConcurrency,
      retries: args.modelRetries ?? args.retries,
      force: args.force,
      refreshList: args.refreshModelsList ?? args.refreshList,
    }),
  },
  {
    name: "Build compact data-v2",
    skip: args.skipBuildData,
    command: script("build-data-v2.mjs", sharedSelection),
  },
  {
    name: "Clean missing data-v2 image references",
    skip: args.skipClean,
    command: script("clean-data-v2-missing-images.mjs", sharedSelection),
  },
  {
    name: "Build UI index",
    skip: args.skipUiIndex,
    command: script("build-ui-index.mjs"),
  },
];

await main();

async function main() {
  const activeSteps = steps.filter((step) => !step.skip);

  console.log(`Running ${activeSteps.length}/${steps.length} pipeline steps from ${PROJECT_ROOT}`);

  for (const [index, step] of activeSteps.entries()) {
    console.log(`\n[${index + 1}/${activeSteps.length}] ${step.name}`);
    console.log(`$ ${formatCommand(step.command)}`);

    if (args.dryRun) {
      continue;
    }

    await run(step.command);
  }

  console.log(args.dryRun ? "\nDry run complete." : "\nFull flow complete.");
}

function script(fileName, options = {}) {
  return [process.execPath, path.join("scripts", fileName), ...optionArgs(options)];
}

function optionArgs(options) {
  const argv = [];

  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === false) {
      continue;
    }

    const option = `--${kebabCase(key)}`;

    if (value === true) {
      argv.push(option);
    } else {
      argv.push(option, String(value));
    }
  }

  return argv;
}

function run(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: PROJECT_ROOT,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(signal ? `Command stopped by ${signal}` : `Command exited with ${code}`));
    });
  });
}

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = camelCase(rawKey);

    if (booleanOptions.has(rawKey)) {
      parsed[key] = true;
      continue;
    }

    const value = inlineValue ?? argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }

    parsed[key] = value;
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  return parsed;
}

function pickDefined(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined),
  );
}

function formatCommand(command) {
  return command.map((part) => (part.includes(" ") ? JSON.stringify(part) : part)).join(" ");
}

function camelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function kebabCase(value) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function printHelp() {
  console.log(`
Usage:
  node scripts/run-full-flow.mjs [options]

Default flow:
  1. Download PokeAPI data
  2. Download Pokemon images
  3. Download Pokemon 3D models
  4. Build compact data-v2
  5. Remove missing image references from data-v2 Pokemon files
  6. Build data-v2/pokemon-index.json for the static UI

Options:
  --limit <number>                  Pass a limit to data/image/model/build/clean steps.
  --offset <number>                 Pass an offset to data/image/model/build/clean steps.
  --dry-run                         Print commands without running them.
  --force                           Re-download files in download steps.
  --refresh-list                    Refresh PokeAPI and model lists.
  --refresh-models-list             Refresh only the model list.
  --include-all-images              Pass through to image download.
  --retries <number>                Retry count for download steps.
  --model-retries <number>          Override retries for model downloads.
  --pokeapi-concurrency <number>    PokeAPI Pokemon download concurrency.
  --reference-concurrency <number>  PokeAPI referenced endpoint concurrency.
  --image-concurrency <number>      Image download concurrency.
  --model-concurrency <number>      Model download concurrency.
  --skip-pokeapi                    Skip PokeAPI download.
  --skip-images                     Skip image download.
  --skip-models                     Skip model download.
  --skip-build-data                 Skip data-v2 build.
  --skip-clean                      Skip missing image cleanup.
  --skip-ui-index                   Skip UI index build.
  --help                            Show this help.

Examples:
  node scripts/run-full-flow.mjs --dry-run
  node scripts/run-full-flow.mjs
  node scripts/run-full-flow.mjs --limit 20 --skip-models
  node scripts/run-full-flow.mjs --skip-pokeapi --skip-images --skip-models
`);
}
