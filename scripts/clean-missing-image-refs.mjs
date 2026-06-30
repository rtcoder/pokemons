#!/usr/bin/env node

import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DEFAULT_SOURCE_DIR = "data-v2/pokemons";
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = parseArgs(process.argv.slice(2));
const sourceDir = resolveProjectPath(args.source ?? DEFAULT_SOURCE_DIR);
const dryRun = Boolean(args.dryRun);
const limit = optionalPositiveInteger(args.limit, "--limit");
const offset = Number(args.offset ?? 0);

if (args.help) {
  printHelp();
  process.exit(0);
}

assertNonNegativeInteger(offset, "--offset");

await main();

async function main() {
  const files = await listJsonFiles(sourceDir);
  const selectedFiles = files.slice(
    offset,
    limit === undefined ? undefined : offset + limit,
  );
  const manifest = {
    sourceDir,
    dryRun,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    sourceCount: files.length,
    selectedOffset: offset,
    selectedLimit: limit ?? null,
    selectedCount: selectedFiles.length,
    scannedFiles: 0,
    changedFiles: 0,
    keptImages: 0,
    removedImages: 0,
    files: [],
  };

  console.log(`Source: ${sourceDir}`);
  console.log(`Mode: ${dryRun ? "dry-run" : "write"}`);
  console.log(`Selected files: ${selectedFiles.length}/${files.length} from offset ${offset}`);

  for (const [index, filePath] of selectedFiles.entries()) {
    const result = await cleanPokemonFile(filePath, offset + index + 1, files.length);
    manifest.scannedFiles += 1;
    manifest.keptImages += result.keptImages;
    manifest.removedImages += result.removedImages;

    if (result.changed) {
      manifest.changedFiles += 1;
      manifest.files.push(result);
    }

    await writeJson(path.join(sourceDir, "missing-image-refs-manifest.json"), manifest);
  }

  manifest.finishedAt = new Date().toISOString();
  await writeJson(path.join(sourceDir, "missing-image-refs-manifest.json"), manifest);
  console.log(
    `Done. Scanned ${manifest.scannedFiles}, changed ${manifest.changedFiles}, kept images ${manifest.keptImages}, removed images ${manifest.removedImages}.`,
  );
}

async function cleanPokemonFile(filePath, position, total) {
  const pokemon = JSON.parse(await readFile(filePath, "utf8"));
  let keptImages = 0;
  let removedImages = 0;
  const removed = [];

  for (const form of pokemon.forms ?? []) {
    const images = form.images ?? [];
    const kept = [];

    for (const image of images) {
      if (image?.path && existsSync(resolveProjectPath(image.path))) {
        kept.push(image);
        keptImages += 1;
      } else {
        removedImages += 1;
        removed.push({
          form: form.name,
          kind: image?.kind ?? null,
          path: image?.path ?? null,
          url: image?.url ?? null,
        });
      }
    }

    form.images = kept;
  }

  const changed = removedImages > 0;
  const relativeFile = projectRelativePath(filePath);

  if (changed) {
    console.log(
      `[${position}/${total}] ${relativeFile}: ${dryRun ? "would remove" : "remove"} ${removedImages} missing image refs`,
    );

    if (!dryRun) {
      await writeJson(filePath, pokemon);
    }
  }

  return {
    file: relativeFile,
    changed,
    keptImages,
    removedImages,
    removed,
  };
}

async function listJsonFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .filter((entry) => entry.name !== "missing-image-refs-manifest.json")
    .map((entry) => path.join(dir, entry.name))
    .sort(comparePokemonFileNames);
}

async function writeJson(filePath, payload) {
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function comparePokemonFileNames(left, right) {
  const leftId = Number(path.basename(left).split("-", 1)[0]);
  const rightId = Number(path.basename(right).split("-", 1)[0]);

  if (Number.isFinite(leftId) && Number.isFinite(rightId) && leftId !== rightId) {
    return leftId - rightId;
  }

  return left.localeCompare(right);
}

function projectRelativePath(absolutePath) {
  return path.relative(PROJECT_ROOT, absolutePath).split(path.sep).join("/");
}

function resolveProjectPath(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(PROJECT_ROOT, filePath);
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

    if (["dry-run", "help"].includes(rawKey)) {
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

function optionalPositiveInteger(value, name) {
  if (value === undefined) {
    return undefined;
  }

  const number = Number(value);
  assertPositiveInteger(number, name);
  return number;
}

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function assertNonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

function camelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function printHelp() {
  console.log(`
Usage:
  node scripts/clean-missing-image-refs.mjs [options]

Default behavior:
  Clean data-v2 Pokemon JSON files by removing forms[].images entries whose
  local image file no longer exists.

Options:
  --source <dir>    Pokemon JSON directory. Default: ${DEFAULT_SOURCE_DIR}
  --limit <number>  Process only N JSON files.
  --offset <number> Start from this file offset. Default: 0
  --dry-run         Print what would change without writing files.
  --help            Show this help.

Examples:
  node scripts/clean-missing-image-refs.mjs --dry-run --limit 10
  node scripts/clean-missing-image-refs.mjs
`);
}
