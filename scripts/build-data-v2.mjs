#!/usr/bin/env node

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const DEFAULT_SOURCE_DIR = "data/pokeapi/pokemons";
const DEFAULT_IMAGES_DIR = "data/images";
const DEFAULT_MODELS_DIR = "data/models";
const DEFAULT_OUTPUT_DIR = "data-v2";

const args = parseArgs(process.argv.slice(2));
const sourceDir = path.resolve(args.source ?? DEFAULT_SOURCE_DIR);
const imagesDir = path.resolve(args.images ?? DEFAULT_IMAGES_DIR);
const modelsDir = path.resolve(args.models ?? DEFAULT_MODELS_DIR);
const outputDir = path.resolve(args.output ?? DEFAULT_OUTPUT_DIR);
const pokemonsOutputDir = path.join(outputDir, "pokemons");
const evolutionsOutputDir = path.join(outputDir, "evolutions");
const limit = optionalPositiveInteger(args.limit, "--limit");
const offset = Number(args.offset ?? 0);

if (args.help) {
  printHelp();
  process.exit(0);
}

assertNonNegativeInteger(offset, "--offset");

await main();

async function main() {
  await mkdir(pokemonsOutputDir, { recursive: true });
  await mkdir(evolutionsOutputDir, { recursive: true });

  const sourceFiles = await listPokemonFiles(sourceDir);
  const allPokemonIndex = await buildPokemonIndex(sourceFiles);
  const selectedFiles = sourceFiles.slice(
    offset,
    limit === undefined ? undefined : offset + limit,
  );
  const evolutionFileCache = await indexExistingEvolutionFiles();

  const manifest = {
    sourceDir,
    imagesDir,
    modelsDir,
    outputDir,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    sourceCount: sourceFiles.length,
    selectedOffset: offset,
    selectedLimit: limit ?? null,
    selectedCount: selectedFiles.length,
    written: 0,
  };

  console.log(`Source: ${sourceDir}`);
  console.log(`Images: ${imagesDir}`);
  console.log(`Models: ${modelsDir}`);
  console.log(`Output: ${outputDir}`);
  console.log(`Selected: ${selectedFiles.length}/${sourceFiles.length} from offset ${offset}`);

  for (const [index, filePath] of selectedFiles.entries()) {
    const pokemon = JSON.parse(await readFile(filePath, "utf8"));
    const record = await buildPokemonRecord(pokemon, allPokemonIndex, evolutionFileCache);
    const outputPath = path.join(pokemonsOutputDir, `${record.id}-${record.name}.json`);

    await writeJson(outputPath, record);
    manifest.written += 1;
    await writeJson(path.join(outputDir, "manifest.json"), manifest);

    console.log(
      `[${offset + index + 1}/${sourceFiles.length}] ${record.id}-${record.name}: forms ${record.forms.length}, evolution ${record.evolution.file}`,
    );
  }

  manifest.finishedAt = new Date().toISOString();
  await writeJson(path.join(outputDir, "manifest.json"), manifest);
  console.log(`Done. Written ${manifest.written}.`);
}

async function buildPokemonRecord(pokemon, allPokemonIndex, evolutionFileCache) {
  const sourcePokemon = pokemon.endpoints.pokemon;
  const species = pokemon.endpoints.pokemonSpecies;
  const evolutionFile = await getOrCreateEvolutionFile(
    pokemon.endpoints.evolutionChain,
    allPokemonIndex,
    evolutionFileCache,
  );
  const forms = await buildForms(pokemon);

  return {
    id: pokemon.id,
    name: pokemon.name,
    displayName: englishName(species?.names) ?? titleCaseName(pokemon.name),
    species: {
      id: species?.id ?? idFromUrl(sourcePokemon.species?.url),
      name: sourcePokemon.species?.name ?? species?.name ?? pokemon.name,
    },
    generation: species?.generation?.name ?? null,
    types: simplifyTypes(sourcePokemon.types),
    height: sourcePokemon.height,
    weight: sourcePokemon.weight,
    baseExperience: sourcePokemon.base_experience,
    isDefault: sourcePokemon.is_default,
    stats: simplifyStats(sourcePokemon.stats),
    abilities: simplifyAbilities(sourcePokemon.abilities, pokemon.endpoints.abilities),
    evolution: {
      file: relativePath(pokemonsOutputDir, evolutionFile.path),
      names: evolutionFile.names,
    },
    forms,
  };
}

async function buildForms(pokemon) {
  const forms = [];
  const varieties = pokemon.endpoints.varieties ?? [];
  const varietyForms = pokemon.endpoints.varietyForms ?? [];
  const modelFiles = await loadModelFilesForPokemon(pokemon);
  const currentImages = await readImageFiles(pokemon.id, pokemon.name);

  for (const [varietyIndex, variety] of varieties.entries()) {
    const formResources = variety.forms?.length ? variety.forms : [{ name: variety.name }];

    for (const formResource of formResources) {
      const formDetail = varietyForms.find((form) => form.name === formResource.name) ?? null;
      const directImages = await readImageFiles(variety.id, variety.name);
      const aggregateImages = imagesForForm(currentImages, varietyIndex, formDetail, variety, pokemon);
      const images = dedupeByPath([...directImages, ...aggregateImages]);
      const model = findBestModel(modelFiles, formResource.name, variety, formDetail);

      forms.push({
        id: variety.id,
        name: formResource.name,
        displayName: englishName(formDetail?.names) ?? titleCaseName(formResource.name),
        formName: formDetail?.form_name || variety.name,
        isDefault: Boolean(variety.is_default),
        isMega: Boolean(formDetail?.is_mega),
        isBattleOnly: Boolean(formDetail?.is_battle_only),
        types: simplifyTypes(formDetail?.types ?? variety.types ?? []),
        images,
        model,
      });
    }
  }

  return forms;
}

async function getOrCreateEvolutionFile(evolutionChain, allPokemonIndex, cache) {
  const chainNames = collectEvolutionNames(evolutionChain?.chain);
  const existing = findEvolutionFileForNames(cache, chainNames);

  if (existing) {
    return existing;
  }

  const fileName = `${chainNames.join("-") || `evolution-${evolutionChain?.id ?? "unknown"}`}.json`;
  const filePath = path.join(evolutionsOutputDir, safeFilePart(fileName));
  const payload = {
    id: evolutionChain?.id ?? null,
    names: chainNames,
    pokemon: chainNames.map((name) => {
      const indexed = allPokemonIndex.byName.get(name);
      return {
        id: indexed?.id ?? idFromSpeciesName(evolutionChain?.chain, name),
        name,
        file: indexed ? relativePath(evolutionsOutputDir, path.join(pokemonsOutputDir, indexed.fileName)) : null,
      };
    }),
    paths: collectEvolutionPaths(evolutionChain?.chain),
  };

  await writeJson(filePath, payload);

  const entry = { path: filePath, names: chainNames };
  cache.push(entry);
  return entry;
}

function collectEvolutionNames(chain) {
  const names = [];

  walkEvolution(chain, (node) => {
    if (node?.species?.name && !names.includes(node.species.name)) {
      names.push(node.species.name);
    }
  });

  return names;
}

function collectEvolutionPaths(chain) {
  const paths = [];

  function visit(node, currentPath) {
    if (!node?.species?.name) {
      return;
    }

    const nextPath = [...currentPath, node.species.name];
    if (!node.evolves_to?.length) {
      paths.push(nextPath);
      return;
    }

    for (const child of node.evolves_to) {
      visit(child, nextPath);
    }
  }

  visit(chain, []);
  return paths;
}

function walkEvolution(chain, visitor) {
  if (!chain) {
    return;
  }

  visitor(chain);

  for (const child of chain.evolves_to ?? []) {
    walkEvolution(child, visitor);
  }
}

function idFromSpeciesName(chain, name) {
  let id = null;

  walkEvolution(chain, (node) => {
    if (node?.species?.name === name) {
      id = idFromUrl(node.species.url);
    }
  });

  return id;
}

function findEvolutionFileForNames(cache, names) {
  return cache.find((entry) => names.some((name) => entry.names.includes(name)));
}

async function indexExistingEvolutionFiles() {
  if (!existsSync(evolutionsOutputDir)) {
    return [];
  }

  const files = (await readdir(evolutionsOutputDir)).filter((file) => file.endsWith(".json"));
  const entries = [];

  for (const file of files) {
    const filePath = path.join(evolutionsOutputDir, file);
    try {
      const payload = JSON.parse(await readFile(filePath, "utf8"));
      entries.push({ path: filePath, names: payload.names ?? namesFromEvolutionFileName(file) });
    } catch {
      entries.push({ path: filePath, names: namesFromEvolutionFileName(file) });
    }
  }

  return entries;
}

function namesFromEvolutionFileName(fileName) {
  return fileName.replace(/\.json$/i, "").split("-");
}

function simplifyStats(stats) {
  const values = {};
  const effort = {};

  for (const entry of stats ?? []) {
    const key = statKey(entry.stat?.name);
    values[key] = entry.base_stat;

    if (entry.effort > 0) {
      effort[key] = entry.effort;
    }
  }

  return {
    ...values,
    total: Object.values(values).reduce((sum, value) => sum + value, 0),
    effort,
  };
}

function statKey(name) {
  return (
    {
      hp: "hp",
      attack: "attack",
      defense: "defense",
      "special-attack": "specialAttack",
      "special-defense": "specialDefense",
      speed: "speed",
    }[name] ?? name
  );
}

function simplifyAbilities(slots, abilityDetails) {
  const byName = new Map((abilityDetails ?? []).map((ability) => [ability.name, ability]));

  return (slots ?? []).map((slot) => {
    const detail = byName.get(slot.ability?.name);
    const effect = englishEntry(detail?.effect_entries);
    const flavor = latestEnglishEntry(detail?.flavor_text_entries);

    return {
      id: detail?.id ?? idFromUrl(slot.ability?.url),
      name: slot.ability?.name,
      displayName: englishName(detail?.names) ?? titleCaseName(slot.ability?.name),
      slot: slot.slot,
      isHidden: Boolean(slot.is_hidden),
      shortEffect: cleanText(effect?.short_effect ?? null),
      effect: cleanText(effect?.effect ?? null),
      flavorText: cleanText(flavor?.flavor_text ?? null),
    };
  });
}

function englishEntry(entries) {
  return (entries ?? []).find((entry) => entry.language?.name === "en") ?? null;
}

function latestEnglishEntry(entries) {
  const english = (entries ?? []).filter((entry) => entry.language?.name === "en");
  return english.at(-1) ?? null;
}

function englishName(names) {
  return (names ?? []).find((entry) => entry.language?.name === "en")?.name ?? null;
}

function cleanText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : value;
}

function simplifyTypes(types) {
  return (types ?? [])
    .slice()
    .sort((left, right) => left.slot - right.slot)
    .map((entry) => entry.type?.name)
    .filter(Boolean);
}

async function readImageFiles(id, name) {
  const metadataPath = path.join(imagesDir, `${id}-${name}`, "images.json");
  const metadata = await readJsonIfExists(metadataPath);
  const files = [];

  for (const file of metadata?.files ?? []) {
    if (!isUsableAsset(file, file.outputPath)) {
      continue;
    }

    files.push({
      kind: imageKind(file.jsonPath),
      path: projectRelativePath(file.outputPath),
      url: file.url,
      jsonPath: file.jsonPath,
    });
  }

  return files;
}

function imagesForForm(files, varietyIndex, formDetail, variety, pokemon) {
  const prefixes = [`endpoints.varieties.${varietyIndex}.sprites`];
  const varietyFormIndex = (pokemon.endpoints.varietyForms ?? []).findIndex(
    (form) => form.name === formDetail?.name || form.name === variety.name,
  );

  if (variety.is_default) {
    prefixes.push("endpoints.pokemon.sprites", "endpoints.forms.0.sprites");
  }

  if (varietyFormIndex >= 0) {
    prefixes.push(`endpoints.varietyForms.${varietyFormIndex}.sprites`);
  }

  return files.filter((file) => prefixes.some((prefix) => file.jsonPath?.startsWith(prefix)));
}

function imageKind(jsonPath) {
  if (!jsonPath) {
    return "image";
  }

  if (jsonPath.includes("official-artwork")) {
    return jsonPath.includes("front_shiny") ? "officialArtworkShiny" : "officialArtwork";
  }

  if (jsonPath.includes("dream_world")) {
    return "dreamWorld";
  }

  if (jsonPath.includes("showdown")) {
    return "showdown";
  }

  if (jsonPath.includes("home")) {
    return "home";
  }

  if (jsonPath.includes("front_shiny")) {
    return "frontShiny";
  }

  if (jsonPath.includes("back_shiny")) {
    return "backShiny";
  }

  if (jsonPath.includes("front_default")) {
    return "front";
  }

  if (jsonPath.includes("back_default")) {
    return "back";
  }

  return "sprite";
}

async function loadModelFilesForPokemon(pokemon) {
  const modelIds = new Set([
    String(pokemon.id),
    String(pokemon.endpoints.pokemonSpecies?.id ?? ""),
    ...((pokemon.endpoints.varieties ?? []).map((variety) => String(variety.id))),
  ]);
  const files = [];

  for (const id of modelIds) {
    if (!id) {
      continue;
    }

    const pokemonName = pokemonNameForModelFolder(pokemon, id);
    const metadataPath = path.join(modelsDir, `${id}-${pokemonName}`, "models.json");
    const metadata = await readJsonIfExists(metadataPath);

    for (const file of metadata?.files ?? []) {
      if (!isUsableAsset(file, file.outputPath) || !file.model) {
        continue;
      }

      files.push({
        name: file.name,
        formName: file.formName,
        path: projectRelativePath(file.outputPath),
        url: file.model,
      });
    }
  }

  return dedupeByPath(files);
}

function pokemonNameForModelFolder(pokemon, id) {
  if (String(pokemon.id) === String(id)) {
    return pokemon.name;
  }

  const variety = (pokemon.endpoints.varieties ?? []).find((entry) => String(entry.id) === String(id));
  if (variety) {
    return variety.name;
  }

  return pokemon.endpoints.pokemonSpecies?.name ?? pokemon.name;
}

function findBestModel(modelFiles, formName, variety, formDetail) {
  if (!modelFiles.length) {
    return null;
  }

  const candidates = modelFiles.filter((file) => !normalizedTokens(file.name).includes("shiny"));
  const formTokens = normalizedTokens(formName);
  const varietyTokens = normalizedTokens(variety.name);
  const detailTokens = normalizedTokens(formDetail?.name);

  const scored = candidates.map((file) => ({
    file,
    score: modelScore(file, formTokens, varietyTokens, detailTokens, Boolean(variety.is_default)),
  }));
  scored.sort((left, right) => right.score - left.score);

  return scored[0]?.score > 0
    ? {
        name: scored[0].file.name,
        formName: scored[0].file.formName,
        path: scored[0].file.path,
        url: scored[0].file.url,
      }
    : null;
}

function modelScore(file, formTokens, varietyTokens, detailTokens, isDefault) {
  const fileTokens = normalizedTokens(`${file.name} ${file.formName}`);

  if (isDefault && file.formName === "regular") {
    return 100;
  }

  let score = 0;
  for (const tokenSet of [formTokens, varietyTokens, detailTokens]) {
    if (tokenSet.length && tokenSet.every((token) => fileTokens.includes(token))) {
      score += tokenSet.length * 10;
    }
  }

  if (file.formName === "regular") {
    score -= 5;
  }

  return score;
}

function normalizedTokens(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/g-max/g, "gmax")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isUsableAsset(file, outputPath) {
  return (
    file?.status !== "failed" &&
    file?.status !== "skipped-failed" &&
    outputPath &&
    existsSync(outputPath)
  );
}

function dedupeByPath(files) {
  const byPath = new Map();

  for (const file of files) {
    if (file?.path) {
      byPath.set(file.path, file);
    }
  }

  return [...byPath.values()];
}

async function buildPokemonIndex(sourceFiles) {
  const byName = new Map();

  for (const filePath of sourceFiles) {
    const fileName = path.basename(filePath);
    const id = Number(fileName.split("-", 1)[0]);
    const name = fileName.replace(/^\d+-/, "").replace(/\.json$/i, "");
    byName.set(name, { id, name, fileName });
  }

  return { byName };
}

async function listPokemonFiles(dir) {
  const entries = await readdir(dir);
  return entries
    .filter((entry) => entry.endsWith(".json"))
    .sort(comparePokemonFileNames)
    .map((entry) => path.join(dir, entry));
}

async function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) {
    return null;
  }

  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, payload) {
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function relativePath(fromDir, toPath) {
  return path.relative(fromDir, toPath).split(path.sep).join("/");
}

function projectRelativePath(absolutePath) {
  return path.relative(process.cwd(), absolutePath).split(path.sep).join("/");
}

function comparePokemonFileNames(left, right) {
  const leftId = Number(path.basename(left).split("-", 1)[0]);
  const rightId = Number(path.basename(right).split("-", 1)[0]);

  if (Number.isFinite(leftId) && Number.isFinite(rightId) && leftId !== rightId) {
    return leftId - rightId;
  }

  return left.localeCompare(right);
}

function idFromUrl(url) {
  if (!url) {
    return null;
  }

  return Number(String(url).replace(/\/+$/, "").split("/").at(-1));
}

function titleCaseName(name) {
  return String(name ?? "")
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
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

    if (["help"].includes(rawKey)) {
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
  node scripts/build-data-v2.mjs [options]

Default behavior:
  1. Read full Pokemon JSON files from ${DEFAULT_SOURCE_DIR}.
  2. Write compact Pokemon records to ${DEFAULT_OUTPUT_DIR}/pokemons/[id]-[name].json.
  3. Write shared evolution references to ${DEFAULT_OUTPUT_DIR}/evolutions/*.json.
  4. Attach already downloaded images and successful 3D models to each form.

Options:
  --source <dir>    Source Pokemon JSON directory. Default: ${DEFAULT_SOURCE_DIR}
  --images <dir>    Downloaded images directory. Default: ${DEFAULT_IMAGES_DIR}
  --models <dir>    Downloaded models directory. Default: ${DEFAULT_MODELS_DIR}
  --output <dir>    Output data-v2 directory. Default: ${DEFAULT_OUTPUT_DIR}
  --limit <number>  Process only N Pokemon from the selected offset.
  --offset <number> Start from this Pokemon file offset. Default: 0
  --help            Show this help.

Examples:
  node scripts/build-data-v2.mjs --limit 10
  node scripts/build-data-v2.mjs --limit 40
  node scripts/build-data-v2.mjs
`);
}
