#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const MODEL_API_URL = "https://pokemon-3d-api.onrender.com/v1/pokemon";
const DEFAULT_POKEMON_LIST_PATH = "data/pokeapi/pokemon-list.json";
const DEFAULT_OUTPUT_DIR = "data/models";
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_RETRIES = 1;
const USER_AGENT = "pokemons-model-downloader/1.0";

const args = parseArgs(process.argv.slice(2));
const pokemonListPath = path.resolve(args.pokemonList ?? DEFAULT_POKEMON_LIST_PATH);
const outputDir = path.resolve(args.output ?? DEFAULT_OUTPUT_DIR);
const modelListPath = path.join(outputDir, "model-list.json");
const manifestPath = path.join(outputDir, "manifest.json");
const limit = optionalPositiveInteger(args.limit, "--limit");
const offset = Number(args.offset ?? 0);
const concurrency = Number(args.concurrency ?? DEFAULT_CONCURRENCY);
const retries = Number(args.retries ?? DEFAULT_RETRIES);
const force = Boolean(args.force);
const refreshList = Boolean(args.refreshList);

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

  const pokemonNamesById = await loadPokemonNamesById();
  const modelList = await loadModelList();
  const selectedModels = modelList.models.slice(
    offset,
    limit === undefined ? undefined : offset + limit,
  );

  const manifest = {
    apiUrl: MODEL_API_URL,
    outputDir,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    modelCount: modelList.models.length,
    selectedOffset: offset,
    selectedLimit: limit ?? null,
    selectedCount: selectedModels.length,
    downloaded: 0,
    skipped: 0,
    failed: [],
  };

  console.log(`API cache: ${modelListPath}`);
  console.log(`Output: ${outputDir}`);
  console.log(`Selected: ${selectedModels.length}/${modelList.models.length} from offset ${offset}`);
  console.log(`Concurrency: ${concurrency}`);

  for (const [index, modelEntry] of selectedModels.entries()) {
    const result = await downloadPokemonModels(
      modelEntry,
      pokemonNamesById,
      offset + index + 1,
      modelList.models.length,
    );

    manifest.downloaded += result.downloaded;
    manifest.skipped += result.skipped;
    if (result.currentFailed > 0) {
      manifest.failed.push(...result.failed.slice(-result.currentFailed));
    }
    await writeJson(manifestPath, manifest);
  }

  manifest.finishedAt = new Date().toISOString();
  await writeJson(manifestPath, manifest);
  console.log(
    `Done. Downloaded ${manifest.downloaded}, skipped ${manifest.skipped}, failed ${manifest.failed.length}.`,
  );
}

async function loadPokemonNamesById() {
  if (!existsSync(pokemonListPath)) {
    console.log(`[pokemon-list] not found: ${pokemonListPath}`);
    return new Map();
  }

  const pokemonList = JSON.parse(await readFile(pokemonListPath, "utf8"));
  const names = new Map();

  for (const resource of pokemonList.results ?? []) {
    names.set(String(resource.id), resource.name);
  }

  console.log(`[pokemon-list] loaded ${names.size} names`);
  return names;
}

async function loadModelList() {
  if (!refreshList && existsSync(modelListPath)) {
    console.log(`[models] using cached ${modelListPath}`);
    return JSON.parse(await readFile(modelListPath, "utf8"));
  }

  console.log(`[models] fetching ${MODEL_API_URL}`);
  const models = await fetchJson(MODEL_API_URL);
  const payload = {
    apiUrl: MODEL_API_URL,
    downloadedAt: new Date().toISOString(),
    count: models.length,
    models,
  };

  await writeJson(modelListPath, payload);
  console.log(`[models] saved ${payload.count} pokemon model entries`);
  return payload;
}

async function downloadPokemonModels(modelEntry, pokemonNamesById, position, total) {
  const id = String(modelEntry.id);
  const name = pokemonNamesById.get(id) ?? inferPokemonName(modelEntry) ?? `pokemon-${id}`;
  const label = `${id}-${name}`;
  const pokemonOutputDir = path.join(outputDir, safeFilePart(label));
  const metadataPath = path.join(pokemonOutputDir, "models.json");
  const forms = uniqueModelForms(modelEntry.forms ?? []);

  await mkdir(pokemonOutputDir, { recursive: true });

  console.log(`[${position}/${total}] ${label}: ${forms.length} model urls`);

  const previousStats = await readJsonIfExists(metadataPath);
  const previouslyFailed = failedAssetKeys(previousStats);
  const stats = {
    id: modelEntry.id,
    name,
    source: modelEntry,
    outputDir: pokemonOutputDir,
    found: forms.length,
    downloaded: 0,
    skipped: 0,
    skippedFailed: 0,
    currentFailed: 0,
    failed: previousStats?.failed ?? [],
    files: [],
  };

  await mapLimit(forms, concurrency, async (form, formIndex) => {
    const fileName = modelFileName(form, formIndex);
    const outputPath = path.join(pokemonOutputDir, fileName);

    if (previouslyFailed.has(form.model) || previouslyFailed.has(fileName)) {
      console.log(`[${position}/${total}] ${label}: skip failed ${fileName}`);
      stats.skipped += 1;
      stats.skippedFailed += 1;
      stats.files.push({ ...form, fileName, outputPath, status: "skipped-failed" });
      return;
    }

    if (!force && existsSync(outputPath)) {
      console.log(`[${position}/${total}] ${label}: skip ${fileName}`);
      stats.skipped += 1;
      stats.files.push({ ...form, fileName, outputPath, status: "skipped" });
      return;
    }

    try {
      console.log(`[${position}/${total}] ${label}: fetch ${fileName}`);
      const bytes = await fetchBytes(form.model);
      await writeFile(outputPath, bytes);
      stats.downloaded += 1;
      stats.files.push({ ...form, fileName, outputPath, status: "downloaded" });
    } catch (error) {
      const failure = { ...form, fileName, outputPath, error: error.message };
      stats.failed.push(failure);
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

function uniqueModelForms(forms) {
  const byUrl = new Map();

  for (const form of forms) {
    if (!form?.model) {
      continue;
    }

    byUrl.set(form.model, form);
  }

  return [...byUrl.values()];
}

function modelFileName(form, index) {
  const url = new URL(form.model);
  const extension = path.extname(url.pathname) || ".glb";
  const formName = safeFilePart(form.formName ?? "form");
  const displayName = safeFilePart(form.name ?? formName);
  return `${String(index + 1).padStart(2, "0")}-${formName}-${displayName}${extension}`;
}

function inferPokemonName(modelEntry) {
  const regularForm = modelEntry.forms?.find((form) => form.formName === "regular");
  const firstForm = regularForm ?? modelEntry.forms?.[0];
  return firstForm?.name ? normalizePokemonName(firstForm.name) : null;
}

function normalizePokemonName(name) {
  return name
    .replace(/^Shiny\s+/i, "")
    .replace(/^Mega\s+/i, "")
    .replace(/^G-Max\s+/i, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function fetchJson(url) {
  const bytes = await fetchBytes(url, "application/json");
  return JSON.parse(bytes.toString("utf8"));
}

async function fetchBytes(url, accept = "*/*") {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept,
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
    if (failure.model) {
      keys.add(failure.model);
    }

    if (failure.fileName) {
      keys.add(failure.fileName);
    }
  }

  for (const file of stats?.files ?? []) {
    if (file.status !== "failed") {
      continue;
    }

    if (file.model) {
      keys.add(file.model);
    }

    if (file.fileName) {
      keys.add(file.fileName);
    }
  }

  return keys;
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

    if (["force", "help", "refresh-list"].includes(rawKey)) {
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
  node scripts/download-pokemon-models.mjs [options]

Default behavior:
  1. Download or reuse cached model list: ${DEFAULT_OUTPUT_DIR}/model-list.json
  2. Match Pokemon IDs to names from ${DEFAULT_POKEMON_LIST_PATH} when available.
  3. Save 3D models to ${DEFAULT_OUTPUT_DIR}/[id]-[name]/.
  4. Save per-Pokemon model metadata to models.json.

Options:
  --pokemon-list <file>  Local pokemon-list.json path. Default: ${DEFAULT_POKEMON_LIST_PATH}
  --output <dir>         Output models directory. Default: ${DEFAULT_OUTPUT_DIR}
  --limit <number>       Download only N Pokemon model entries from the selected offset.
  --offset <number>      Start from this model-list offset. Default: 0
  --concurrency <n>      Parallel model downloads per Pokemon. Default: ${DEFAULT_CONCURRENCY}
  --retries <number>     Retry count per request. Default: ${DEFAULT_RETRIES}
  --force                Re-download model files that already exist.
  --refresh-list         Re-download ${DEFAULT_OUTPUT_DIR}/model-list.json.
  --help                 Show this help.

Examples:
  node scripts/download-pokemon-models.mjs --limit 10
  node scripts/download-pokemon-models.mjs --limit 40
  node scripts/download-pokemon-models.mjs --offset 40 --limit 40
`);
}
