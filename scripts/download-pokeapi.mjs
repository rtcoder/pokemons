#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const API_ROOT = "https://pokeapi.co/api/v2/";
const DEFAULT_OUTPUT_DIR = "data/pokeapi";
const DEFAULT_POKEMON_CONCURRENCY = 2;
const DEFAULT_REFERENCE_CONCURRENCY = 8;
const DEFAULT_RETRIES = 4;
const DEFAULT_PAGE_LIMIT = 100000;
const USER_AGENT = "pokemons-catalog-downloader/2.0";

const args = parseArgs(process.argv.slice(2));
const outputDir = path.resolve(args.output ?? DEFAULT_OUTPUT_DIR);
const pokemonDir = path.join(outputDir, "pokemons");
const pokemonListPath = path.join(outputDir, "pokemon-list.json");
const manifestPath = path.join(outputDir, "manifest.json");

const limit = optionalPositiveInteger(args.limit, "--limit");
const offset = Number(args.offset ?? 0);
const pokemonConcurrency = Number(args.concurrency ?? DEFAULT_POKEMON_CONCURRENCY);
const referenceConcurrency = Number(args.referenceConcurrency ?? DEFAULT_REFERENCE_CONCURRENCY);
const retries = Number(args.retries ?? DEFAULT_RETRIES);
const pageLimit = Number(args.pageLimit ?? DEFAULT_PAGE_LIMIT);
const force = Boolean(args.force);
const refreshList = Boolean(args.refreshList);

if (args.help) {
  printHelp();
  process.exit(0);
}

assertNonNegativeInteger(offset, "--offset");
assertPositiveInteger(pokemonConcurrency, "--concurrency");
assertPositiveInteger(referenceConcurrency, "--reference-concurrency");
assertNonNegativeInteger(retries, "--retries");
assertPositiveInteger(pageLimit, "--page-limit");

await main();

async function main() {
  await mkdir(pokemonDir, { recursive: true });

  const startedAt = new Date().toISOString();
  const pokemonList = await loadPokemonList();
  const selectedPokemon = pokemonList.results.slice(
    offset,
    limit === undefined ? undefined : offset + limit,
  );

  const manifest = {
    apiRoot: API_ROOT,
    startedAt,
    finishedAt: null,
    pokemonCount: pokemonList.count,
    selectedOffset: offset,
    selectedLimit: limit ?? null,
    selectedCount: selectedPokemon.length,
    downloaded: 0,
    skipped: 0,
    failed: [],
  };

  console.log(`Output: ${outputDir}`);
  console.log(`Pokemon list: ${pokemonListPath}`);
  console.log(`Pokemon files: ${pokemonDir}`);
  console.log(`Selected: ${selectedPokemon.length}/${pokemonList.count} from offset ${offset}`);
  console.log(`Pokemon concurrency: ${pokemonConcurrency}`);
  console.log(`Reference concurrency: ${referenceConcurrency}`);

  await mapLimit(selectedPokemon, pokemonConcurrency, async (resource, indexInSelection) => {
    const listIndex = offset + indexInSelection + 1;
    try {
      const result = await downloadPokemon(resource, listIndex, pokemonList.count);
      manifest[result.status] += 1;
      await writeJson(manifestPath, manifest);
    } catch (error) {
      manifest.failed.push({
        name: resource.name,
        url: resource.url,
        error: error.message,
      });
      await writeJson(manifestPath, manifest);
      throw error;
    }
  });

  manifest.finishedAt = new Date().toISOString();
  await writeJson(manifestPath, manifest);

  console.log(
    `Done. Downloaded ${manifest.downloaded}, skipped ${manifest.skipped}, failed ${manifest.failed.length}.`,
  );
}

async function loadPokemonList() {
  if (!refreshList && existsSync(pokemonListPath)) {
    console.log(`[list] using cached ${pokemonListPath}`);
    return JSON.parse(await readFile(pokemonListPath, "utf8"));
  }

  console.log("[list] fetching all pokemon");
  const list = await fetchResourceList(`${API_ROOT}pokemon/?limit=${pageLimit}&offset=0`);
  const payload = {
    endpoint: "pokemon",
    url: `${API_ROOT}pokemon/`,
    count: list.count,
    downloadedAt: new Date().toISOString(),
    results: list.results.map((resource) => ({
      id: resourceIdFromUrl(resource.url),
      name: resource.name,
      url: resource.url,
    })),
  };

  await writeJson(pokemonListPath, payload);
  console.log(`[list] saved ${payload.results.length}/${payload.count} pokemon`);
  return payload;
}

async function downloadPokemon(resource, listIndex, totalCount) {
  const idFromList = resource.id ?? resourceIdFromUrl(resource.url);
  const filePath = path.join(pokemonDir, `${idFromList}-${safeFilePart(resource.name)}.json`);
  const label = `${idFromList}-${resource.name}`;

  if (!force && existsSync(filePath)) {
    console.log(`[${listIndex}/${totalCount}] ${label}: skip, already exists`);
    return { status: "skipped" };
  }

  const context = {
    label,
    cache: new Map(),
  };

  console.log(`[${listIndex}/${totalCount}] ${label}: pokemon`);
  const pokemon = await fetchNamedJson(context, "pokemon", resource.url);

  console.log(`[${listIndex}/${totalCount}] ${label}: pokemon-species`);
  const species = pokemon.species?.url
    ? await fetchNamedJson(context, "pokemon-species", pokemon.species.url)
    : null;

  console.log(`[${listIndex}/${totalCount}] ${label}: evolution-chain`);
  const evolutionChain = species?.evolution_chain?.url
    ? await fetchNamedJson(context, "evolution-chain", species.evolution_chain.url)
    : null;

  console.log(`[${listIndex}/${totalCount}] ${label}: encounters`);
  const encounters = pokemon.location_area_encounters
    ? await fetchNamedJson(context, "location-area-encounters", pokemon.location_area_encounters)
    : [];

  console.log(`[${listIndex}/${totalCount}] ${label}: forms`);
  const forms = await fetchNamedResourceList(context, "pokemon-form", pokemon.forms);

  console.log(`[${listIndex}/${totalCount}] ${label}: varieties`);
  const varietyPokemon = await fetchNamedResourceList(
    context,
    "pokemon-variety",
    species?.varieties?.map((variety) => variety.pokemon) ?? [],
  );

  const varietyForms = await fetchVarietyForms(context, varietyPokemon);

  console.log(`[${listIndex}/${totalCount}] ${label}: abilities`);
  const abilities = await fetchNamedResourceList(
    context,
    "ability",
    pokemon.abilities?.map((entry) => entry.ability) ?? [],
  );

  console.log(`[${listIndex}/${totalCount}] ${label}: moves (${pokemon.moves?.length ?? 0})`);
  const moves = await fetchNamedResourceList(
    context,
    "move",
    pokemon.moves?.map((entry) => entry.move) ?? [],
  );

  console.log(`[${listIndex}/${totalCount}] ${label}: types`);
  const types = await fetchNamedResourceList(
    context,
    "type",
    pokemon.types?.map((entry) => entry.type) ?? [],
  );

  console.log(`[${listIndex}/${totalCount}] ${label}: held-items`);
  const heldItems = await fetchNamedResourceList(
    context,
    "item",
    pokemon.held_items?.map((entry) => entry.item) ?? [],
  );

  console.log(`[${listIndex}/${totalCount}] ${label}: stats`);
  const stats = await fetchNamedResourceList(
    context,
    "stat",
    pokemon.stats?.map((entry) => entry.stat) ?? [],
  );

  const payload = {
    id: pokemon.id,
    name: pokemon.name,
    sourceListItem: resource,
    downloadedAt: new Date().toISOString(),
    endpoints: {
      pokemon,
      pokemonSpecies: species,
      evolutionChain,
      encounters,
      forms,
      varieties: varietyPokemon,
      varietyForms,
      abilities,
      moves,
      types,
      heldItems,
      stats,
    },
  };

  await writeJson(filePath, payload);
  console.log(`[${listIndex}/${totalCount}] ${label}: saved ${filePath}`);

  return { status: "downloaded" };
}

async function fetchVarietyForms(context, varietyPokemon) {
  const seen = new Map();

  for (const variety of varietyPokemon) {
    for (const form of variety.forms ?? []) {
      seen.set(form.url, form);
    }
  }

  if (seen.size > 0) {
    console.log(`[${context.label}] variety forms (${seen.size})`);
  }

  return fetchNamedResourceList(context, "pokemon-form", [...seen.values()]);
}

async function fetchNamedResourceList(context, endpointName, resources) {
  const uniqueResources = uniqueNamedResources(resources);
  return mapLimit(uniqueResources, referenceConcurrency, (resource) =>
    fetchNamedJson(context, endpointName, resource.url),
  );
}

async function fetchNamedJson(context, endpointName, url) {
  if (context.cache.has(url)) {
    return context.cache.get(url);
  }

  const promise = fetchJson(url);
  context.cache.set(url, promise);

  try {
    return await promise;
  } catch (error) {
    context.cache.delete(url);
    throw new Error(`${context.label}: failed ${endpointName} ${url}: ${error.message}`);
  }
}

async function fetchJson(url) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: "application/json",
          "user-agent": USER_AGENT,
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      return await response.json();
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

async function fetchResourceList(firstUrl) {
  const results = [];
  let count = 0;
  let nextUrl = firstUrl;

  while (nextUrl) {
    const page = await fetchJson(nextUrl);
    count = page.count;
    results.push(...(page.results ?? []));
    nextUrl = page.next;
  }

  return { count, results };
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const current = cursor;
      cursor += 1;
      results[current] = await worker(items[current], current);
    }
  });

  await Promise.all(workers);
  return results;
}

async function writeJson(filePath, payload) {
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
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

function uniqueNamedResources(resources) {
  const unique = new Map();

  for (const resource of resources ?? []) {
    if (!resource?.url) {
      continue;
    }

    unique.set(resource.url, resource);
  }

  return [...unique.values()];
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

function resourceIdFromUrl(url) {
  const parts = stripTrailingSlash(url).split("/");
  return parts.at(-1);
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function safeFilePart(value) {
  return value.replace(/[^a-z0-9._-]+/gi, "_");
}

function camelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function printHelp() {
  console.log(`
Usage:
  node scripts/download-pokeapi.mjs [options]

Default behavior:
  1. Download or reuse cached full pokemon list: ${DEFAULT_OUTPUT_DIR}/pokemon-list.json
  2. Iterate through that list.
  3. For each pokemon, fetch related PokeAPI data and save one accumulated file:
     ${DEFAULT_OUTPUT_DIR}/pokemons/[id]-[name].json

Included per pokemon:
  pokemon, pokemon-species, evolution-chain, encounters, forms, species varieties,
  variety forms, abilities, moves, types, held items, and stats.

Options:
  --output <dir>                    Output directory. Default: ${DEFAULT_OUTPUT_DIR}
  --limit <number>                  Download only first N pokemon from the selected offset.
  --offset <number>                 Start from this pokemon-list offset. Default: 0
  --concurrency <number>            Parallel pokemon downloads. Default: ${DEFAULT_POKEMON_CONCURRENCY}
  --reference-concurrency <number>  Parallel referenced endpoint downloads per pokemon.
                                    Default: ${DEFAULT_REFERENCE_CONCURRENCY}
  --retries <number>                Retry count per request. Default: ${DEFAULT_RETRIES}
  --page-limit <number>             Pokemon-list page size. Default: ${DEFAULT_PAGE_LIMIT}
  --force                           Re-download pokemon files that already exist.
  --refresh-list                    Re-download ${DEFAULT_OUTPUT_DIR}/pokemon-list.json.
  --help                            Show this help.

Examples:
  node scripts/download-pokeapi.mjs --limit 10
  node scripts/download-pokeapi.mjs --limit 40
  node scripts/download-pokeapi.mjs --offset 40 --limit 40
  node scripts/download-pokeapi.mjs --output data/pokeapi --concurrency 1
`);
}
