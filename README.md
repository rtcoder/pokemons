# Pokemon Database

Static Pokemon database built from local PokeAPI data, downloaded artwork, and
downloaded GLB models. The app is designed to run directly on GitHub Pages:
there is no server-side code, build server, database, or API required at runtime.

## What the app shows

- A searchable, filterable list of regular Pokemon.
- A details panel with stats, abilities, evolution chain, variants, artwork, and
  a 3D model when a local GLB exists.
- Variants such as Mega Charizard X are not shown as separate top-level cards,
  but they are available from the regular Pokemon details panel. When selected,
  a variant shows its own types, stats, artwork, and model.
- All runtime data is loaded from static JSON files in `data-v2`.

## Quick Start

Serve the repository over HTTP and open `index.html`:

```sh
python3 -m http.server 8765
```

Then open:

```text
http://localhost:8765/
```

Do not open `index.html` directly from the filesystem. The UI uses `fetch()` for
JSON files, so it needs HTTP, just like it will have on GitHub Pages.

## Full Data Flow

Run the complete data pipeline:

```sh
node scripts/run-full-flow.mjs
```

Preview the commands without changing anything:

```sh
node scripts/run-full-flow.mjs --dry-run
```

Useful variants:

```sh
node scripts/run-full-flow.mjs --limit 20 --skip-models
node scripts/run-full-flow.mjs --skip-pokeapi --skip-images --skip-models
```

The full flow runs, in order:

1. Download PokeAPI data into `data/pokeapi`.
2. Download Pokemon images into `data/images`.
3. Download Pokemon 3D models into `data/models`.
4. Build compact app data into `data-v2`.
5. Remove missing image references from `data-v2/pokemons`.
6. Build `data-v2/pokemon-index.json` for the static UI.

## Runtime Files

These files are needed by the GitHub Pages app:

- `index.html` - the whole UI.
- `data-v2/pokemon-index.json` - list/search index plus variant metadata.
- `data-v2/pokemons/*.json` - full Pokemon and variant records.
- `data-v2/evolutions/*.json` - evolution chains.
- `data/images/**` - local artwork and sprites.
- `data/models/**` - local GLB models.
- `vendor/three/**` - local Three.js, GLTFLoader, OrbitControls, and Draco
  decoder files used by the 3D viewer.

The app intentionally avoids CDN dependencies so GitHub Pages can serve it as a
self-contained static site.

## Data Model Notes

`data-v2/pokemon-index.json` contains all records needed for navigation:

- `count` - number of regular Pokemon shown in the main list.
- `entryCount` - number of all indexed records, including variants.
- `entries[]` - regular Pokemon and variants.

Each entry includes:

- `isDefault` - `true` for regular Pokemon shown in the main grid.
- `species` - used to group variants with their regular Pokemon.
- `image` and `images` - verified local image paths.
- `modelPath` and `modelName` - verified local GLB model info when available.
- `types`, `statsTotal`, `height`, `weight`, and `generation`.

The main grid filters to `isDefault: true`. The details panel can select any
entry, including variants, so a variant can show its own stats and model.

## Common Commands

### Build only app data

```sh
node scripts/build-data-v2.mjs
```

Writes:

- `data-v2/pokemons/[id]-[name].json`
- `data-v2/evolutions/*.json`
- `data-v2/manifest.json`

### Rebuild only the UI index

```sh
node scripts/build-ui-index.mjs
```

Run this after changing `data-v2`, images, or models.

### Remove missing image references

```sh
node scripts/clean-data-v2-missing-images.mjs --dry-run
node scripts/clean-data-v2-missing-images.mjs
```

This scans `data-v2/pokemons` and removes `forms[].images` entries whose local
files no longer exist. It writes `missing-image-refs-manifest.json` in the
Pokemon JSON directory.

### Download PokeAPI data

```sh
node scripts/download-pokeapi.mjs --limit 10
node scripts/download-pokeapi.mjs --help
```

Writes accumulated source data to `data/pokeapi`.

### Download images

```sh
node scripts/download-pokemon-images.mjs --limit 10
node scripts/download-pokemon-images.mjs --help
```

Writes images and `images.json` files to `data/images/[id]-[name]/`.

### Download 3D models

```sh
node scripts/download-pokemon-models.mjs --limit 10
node scripts/download-pokemon-models.mjs --help
```

Writes GLB models and `models.json` files to `data/models/[id]-[name]/`.

## Image Cleanup Helpers

These scripts help review noisy local assets before rebuilding `data-v2`.

### Small raster images

```sh
node scripts/move-small-images.mjs --dry-run --limit 5
node scripts/move-small-images.mjs --min-width 128 --min-height 128
```

Moves small raster images into `data/images/[id]-[name]/ready-to-delete/`.
SVG files are ignored.

### Mostly transparent PNGs

```sh
node scripts/move-transparent-images.mjs --dry-run --limit 5
node scripts/move-transparent-images.mjs --ratio 0.6
```

Moves PNGs with more than the configured transparent-pixel ratio into
`ready-to-delete/`. SVG, GIF, JPG, JPEG, and WebP files are ignored.

## GitHub Pages

The app can be deployed from the repository root. Make sure these are committed:

- `index.html`
- `data-v2/**`
- `data/images/**`
- `data/models/**`
- `vendor/three/**`

After any data refresh, run:

```sh
node scripts/run-full-flow.mjs --skip-pokeapi --skip-images --skip-models
```

That rebuilds compact data, removes missing image references, and refreshes the
UI index without re-downloading source assets.
