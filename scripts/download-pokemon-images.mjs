#!/usr/bin/env node

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const DEFAULT_SOURCE_DIR = "data/pokeapi/pokemons";
const DEFAULT_OUTPUT_DIR = "data/images";
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_RETRIES = 4;
const USER_AGENT = "pokemons-image-downloader/1.0";
const IMAGE_URL_PATTERN = /^https?:\/\/.+\.(png|jpg|jpeg|gif|svg|webp)(\?.*)?$/i;

const args = parseArgs(process.argv.slice(2));
const sourceDir = path.resolve(args.source ?? DEFAULT_SOURCE_DIR);
const outputDir = path.resolve(args.output ?? DEFAULT_OUTPUT_DIR);
const limit = optionalPositiveInteger(args.limit, "--limit");
const offset = Number(args.offset ?? 0);
const concurrency = Number(args.concurrency ?? DEFAULT_CONCURRENCY);
const retries = Number(args.retries ?? DEFAULT_RETRIES);
const force = Boolean(args.force);
const includeAllImages = Boolean(args.includeAllImages);

if (args.help) {
  printHelp();
  process.exit(0);
}

assertNonNegativeInteger(offset, "--offset");
assertPositiveInteger(concurrency, "--concurrency");
assertNonNegativeInteger(retries, "--retries");

await main();

async function main() {
  await mkdir(outputDir, { recursive: true });

  const pokemonFiles = await listPokemonFiles(sourceDir);
  const selectedFiles = pokemonFiles.slice(
    offset,
    limit === undefined ? undefined : offset + limit,
  );

  const manifest = {
    sourceDir,
    outputDir,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    sourceCount: pokemonFiles.length,
    selectedOffset: offset,
    selectedLimit: limit ?? null,
    selectedCount: selectedFiles.length,
    pokemons: [],
  };

  console.log(`Source: ${sourceDir}`);
  console.log(`Output: ${outputDir}`);
  console.log(`Selected: ${selectedFiles.length}/${pokemonFiles.length} from offset ${offset}`);
  console.log(`Concurrency: ${concurrency}`);
  console.log(`Scope: ${includeAllImages ? "all image URLs" : "pokemon sprite URLs"}`);

  for (const [index, filePath] of selectedFiles.entries()) {
    const result = await downloadPokemonImages(filePath, offset + index + 1, pokemonFiles.length);
    manifest.pokemons.push(result);
    await writeJson(path.join(outputDir, "manifest.json"), manifest);
  }

  manifest.finishedAt = new Date().toISOString();
  await writeJson(path.join(outputDir, "manifest.json"), manifest);
  console.log("Done.");
}

async function listPokemonFiles(dir) {
  const entries = await readdir(dir);
  return entries
    .filter((entry) => entry.endsWith(".json"))
    .sort(comparePokemonFileNames)
    .map((entry) => path.join(dir, entry));
}

async function downloadPokemonImages(filePath, position, total) {
  const pokemon = JSON.parse(await readFile(filePath, "utf8"));
  const id = pokemon.id ?? idFromFileName(filePath);
  const name = pokemon.name ?? nameFromFileName(filePath);
  const label = `${id}-${name}`;
  const pokemonOutputDir = path.join(outputDir, safeFilePart(label));
  const metadataPath = path.join(pokemonOutputDir, "images.json");
  const imageRefs = extractImageRefs(pokemon, includeAllImages);

  await mkdir(pokemonOutputDir, { recursive: true });

  console.log(`[${position}/${total}] ${label}: ${imageRefs.length} image urls`);

  const previousStats = await readJsonIfExists(metadataPath);
  const previouslyFailed = failedAssetKeys(previousStats);
  const stats = {
    id,
    name,
    sourceFile: filePath,
    outputDir: pokemonOutputDir,
    found: imageRefs.length,
    downloaded: 0,
    skipped: 0,
    skippedFailed: 0,
    currentFailed: 0,
    failed: previousStats?.failed ?? [],
    files: [],
  };

  await mapLimit(imageRefs, concurrency, async (imageRef, imageIndex) => {
    const fileName = imageFileName(imageRef, imageIndex);
    const outputPath = path.join(pokemonOutputDir, fileName);

    if (previouslyFailed.has(imageRef.url) || previouslyFailed.has(fileName)) {
      console.log(`[${position}/${total}] ${label}: skip failed ${fileName}`);
      stats.skipped += 1;
      stats.skippedFailed += 1;
      stats.files.push({ ...imageRef, fileName, outputPath, status: "skipped-failed" });
      return;
    }

    if (!force && existsSync(outputPath)) {
      console.log(`[${position}/${total}] ${label}: skip ${fileName}`);
      stats.skipped += 1;
      stats.files.push({ ...imageRef, fileName, outputPath, status: "skipped" });
      return;
    }

    try {
      console.log(`[${position}/${total}] ${label}: fetch ${fileName}`);
      const bytes = await fetchBytes(imageRef.url);
      await writeFile(outputPath, bytes);
      stats.downloaded += 1;
      stats.files.push({ ...imageRef, fileName, outputPath, status: "downloaded" });
    } catch (error) {
      stats.failed.push({ ...imageRef, fileName, outputPath, error: error.message });
      stats.currentFailed += 1;
      console.warn(`[${position}/${total}] ${label}: failed ${fileName}: ${error.message}`);
    }
  });

  await writeJson(metadataPath, stats);
  console.log(
    `[${position}/${total}] ${label}: downloaded ${stats.downloaded}, skipped ${stats.skipped}, skipped failed ${stats.skippedFailed}, failed now ${stats.currentFailed}`,
  );

  return stats;
}

function extractImageRefs(pokemon, includeAll) {
  const byUrl = new Map();

  const visitImageUrl = (currentValue, pathParts) => {
    if (typeof currentValue !== "string" || !IMAGE_URL_PATTERN.test(currentValue)) {
      return;
    }

    if (byUrl.has(currentValue)) {
      return;
    }

    byUrl.set(currentValue, {
      url: currentValue,
      jsonPath: pathParts.join("."),
    });
  };

  if (includeAll) {
    walk(pokemon, [], visitImageUrl);
    return [...byUrl.values()];
  }

  for (const root of pokemonSpriteRoots(pokemon)) {
    walk(root.value, root.path, visitImageUrl);
  }

  return [...byUrl.values()];
}

function pokemonSpriteRoots(pokemon) {
  const endpoints = pokemon.endpoints ?? {};
  const roots = [];

  addRoot(roots, ["endpoints", "pokemon", "sprites"], endpoints.pokemon?.sprites);

  for (const [index, form] of (endpoints.forms ?? []).entries()) {
    addRoot(roots, ["endpoints", "forms", String(index), "sprites"], form?.sprites);
  }

  for (const [index, variety] of (endpoints.varieties ?? []).entries()) {
    addRoot(roots, ["endpoints", "varieties", String(index), "sprites"], variety?.sprites);
  }

  for (const [index, form] of (endpoints.varietyForms ?? []).entries()) {
    addRoot(roots, ["endpoints", "varietyForms", String(index), "sprites"], form?.sprites);
  }

  return roots;
}

function addRoot(roots, pathParts, value) {
  if (value && typeof value === "object") {
    roots.push({ path: pathParts, value });
  }
}

function walk(value, pathParts, visitor) {
  visitor(value, pathParts);

  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, [...pathParts, String(index)], visitor));
    return;
  }

  if (value && typeof value === "object") {
    for (const [key, childValue] of Object.entries(value)) {
      walk(childValue, [...pathParts, key], visitor);
    }
  }
}

async function fetchBytes(url) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          "user-agent": USER_AGENT,
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt === retries) {
        break;
      }

      const delayMs = 500 * 2 ** attempt;
      console.warn(`Retry ${attempt + 1}/${retries} after ${delayMs}ms: ${url}`);
      await sleep(delayMs);
    }
  }

  throw new Error(`Failed to fetch ${url}: ${lastError.message}`);
}

async function mapLimit(items, limit, worker) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const current = cursor;
      cursor += 1;
      await worker(items[current], current);
    }
  });

  await Promise.all(workers);
}

async function writeJson(filePath, payload) {
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

async function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) {
    return null;
  }

  return JSON.parse(await readFile(filePath, "utf8"));
}

function failedAssetKeys(stats) {
  const keys = new Set();

  for (const failure of stats?.failed ?? []) {
    if (failure.url) {
      keys.add(failure.url);
    }

    if (failure.fileName) {
      keys.add(failure.fileName);
    }
  }

  for (const file of stats?.files ?? []) {
    if (file.status !== "failed") {
      continue;
    }

    if (file.url) {
      keys.add(file.url);
    }

    if (file.fileName) {
      keys.add(file.fileName);
    }
  }

  return keys;
}

function imageFileName(imageRef, index) {
  const url = new URL(imageRef.url);
  const extension = path.extname(url.pathname) || ".img";
  const pathName = safeFilePart(imageRef.jsonPath);
  const urlName = safeFilePart(path.basename(url.pathname, extension));
  return `${String(index + 1).padStart(3, "0")}-${pathName}-${urlName}${extension}`;
}

function comparePokemonFileNames(left, right) {
  const leftId = Number(idFromFileName(left));
  const rightId = Number(idFromFileName(right));

  if (Number.isFinite(leftId) && Number.isFinite(rightId) && leftId !== rightId) {
    return leftId - rightId;
  }

  return left.localeCompare(right);
}

function idFromFileName(filePath) {
  return path.basename(filePath, ".json").split("-", 1)[0];
}

function nameFromFileName(filePath) {
  return path.basename(filePath, ".json").replace(/^\d+-/, "");
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

    if (["force", "help", "include-all-images"].includes(rawKey)) {
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

function safeFilePart(value) {
  return String(value).replace(/[^a-z0-9._-]+/gi, "_");
}

function camelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function printHelp() {
  console.log(`
Usage:
  node scripts/download-pokemon-images.mjs [options]

Default behavior:
  1. Read accumulated Pokemon JSON files from ${DEFAULT_SOURCE_DIR}.
  2. Extract Pokemon sprite URLs from each JSON file.
  3. Save images to ${DEFAULT_OUTPUT_DIR}/[id]-[name]/.
  4. Save per-Pokemon image metadata to images.json.

Options:
  --source <dir>       Source Pokemon JSON directory. Default: ${DEFAULT_SOURCE_DIR}
  --output <dir>       Output image directory. Default: ${DEFAULT_OUTPUT_DIR}
  --limit <number>     Process only N Pokemon from the selected offset.
  --offset <number>    Start from this Pokemon file offset. Default: 0
  --concurrency <n>    Parallel image downloads per Pokemon. Default: ${DEFAULT_CONCURRENCY}
  --retries <number>   Retry count per image. Default: ${DEFAULT_RETRIES}
  --force              Re-download image files that already exist.
  --include-all-images Extract every image URL from the JSON, including repeated type/item icons.
  --help               Show this help.

Examples:
  node scripts/download-pokemon-images.mjs --limit 10
  node scripts/download-pokemon-images.mjs --limit 40
  node scripts/download-pokemon-images.mjs --offset 40 --limit 40
`);
}
