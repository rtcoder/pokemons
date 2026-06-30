#!/usr/bin/env node

import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const POKEMON_DIR = "data-v2/pokemons";
const OUTPUT_FILE = "data-v2/pokemon-index.json";
const IMAGE_PRIORITY = [
  "officialArtwork",
  "home",
  "dreamWorld",
  "front",
  "showdown",
  "sprite",
];

const files = (await readdir(POKEMON_DIR, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
  .filter((entry) => entry.name !== "missing-image-refs-manifest.json")
  .map((entry) => entry.name)
  .sort(comparePokemonFileNames);

const entries = [];

for (const fileName of files) {
  const filePath = path.join(POKEMON_DIR, fileName);
  const pokemon = JSON.parse(await readFile(filePath, "utf8"));
  const currentForm = findCurrentForm(pokemon);
  const images = pickImages(currentForm.images ?? []);
  const image = images[0] ?? null;

  entries.push({
    id: pokemon.id,
    name: pokemon.name,
    displayName: currentForm.displayName ?? pokemon.displayName,
    file: `data-v2/pokemons/${fileName}`,
    isDefault: Boolean(pokemon.isDefault),
    species: pokemon.species ?? null,
    generation: pokemon.generation,
    types: pokemon.types ?? [],
    height: pokemon.height ?? null,
    weight: pokemon.weight ?? null,
    statsTotal: pokemon.stats?.total ?? null,
    image: image?.path ?? null,
    imageKind: image?.kind ?? null,
    images,
    formsCount: pokemon.forms?.length ?? 0,
    modelPath: modelPath(currentForm),
    modelName: currentForm.model?.name ?? currentForm.displayName ?? pokemon.displayName,
    hasModel: Boolean(modelPath(currentForm)),
  });
}

const listCount = entries.filter((entry) => entry.isDefault).length;
const index = {
  generatedAt: new Date().toISOString(),
  count: listCount,
  entryCount: entries.length,
  entries,
};

await writeFile(OUTPUT_FILE, `${JSON.stringify(index, null, 2)}\n`);
console.log(`Wrote ${OUTPUT_FILE} with ${listCount} list Pokemon and ${entries.length} total entries.`);

function findCurrentForm(pokemon) {
  return (
    pokemon.forms?.find((form) => form.id === pokemon.id) ??
    pokemon.forms?.find((form) => form.name === pokemon.name) ??
    pokemon.forms?.find((form) => form.isDefault) ??
    pokemon.forms?.[0] ??
    {}
  );
}

function modelPath(form) {
  return form.model?.path && existsSync(form.model.path) ? form.model.path : null;
}

function pickImages(images) {
  const picked = [];
  const seen = new Set();

  for (const kind of IMAGE_PRIORITY) {
    addMatches(picked, seen, images, (image) => isUsableRegularImage(image) && image.kind === kind);
  }

  for (const kind of IMAGE_PRIORITY) {
    addMatches(picked, seen, images, (image) => isUsableImage(image) && image.kind === kind);
  }

  addMatches(picked, seen, images, isUsableImage);

  return picked.slice(0, 18);
}

function addMatches(picked, seen, images, predicate) {
  for (const image of images) {
    if (!predicate(image) || seen.has(image.path)) {
      continue;
    }

    seen.add(image.path);
    picked.push({
      kind: image.kind ?? "image",
      path: image.path,
    });
  }
}

function isUsableRegularImage(image) {
  return isUsableImage(image) && !image.jsonPath?.includes("varieties");
}

function isUsableImage(image) {
  return Boolean(image.path && existsSync(image.path));
}

function comparePokemonFileNames(left, right) {
  const leftId = Number(left.split("-", 1)[0]);
  const rightId = Number(right.split("-", 1)[0]);

  if (Number.isFinite(leftId) && Number.isFinite(rightId) && leftId !== rightId) {
    return leftId - rightId;
  }

  return left.localeCompare(right);
}
