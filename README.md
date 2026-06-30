# pokemons
simple pokemon database

## Download PokeAPI data

Download accumulated JSON files, one file per Pokemon:

```sh
node scripts/download-pokeapi.mjs --limit 10
```

By default files are written to `data/pokeapi`:

- `pokemon-list.json` - cached list of all Pokemon, so the script does not fetch it again
- `pokemons/[id]-[name].json` - accumulated Pokemon data
- `manifest.json` - last run summary

Each Pokemon file includes core Pokemon data, species, evolution chain, encounters,
forms, varieties, variety forms, abilities, moves, types, held items, and stats.

The script skips existing Pokemon files, so you can grow the local dataset:

```sh
node scripts/download-pokeapi.mjs --limit 10
node scripts/download-pokeapi.mjs --limit 40
```

See all options:

```sh
node scripts/download-pokeapi.mjs --help
```

## Download Pokemon images

Extract Pokemon sprite URLs from downloaded Pokemon JSON files and save them per Pokemon:

```sh
node scripts/download-pokemon-images.mjs --limit 10
```

Images are written to `data/images/[id]-[name]/`. By default the script downloads
Pokemon sprites, form sprites, variety sprites, and variety form sprites. Each
directory also gets an `images.json` file with source URL, JSON path, local
filename, and download status.

The script skips existing files and URLs that previously failed, so you can grow
the image dataset:

```sh
node scripts/download-pokemon-images.mjs --limit 10
node scripts/download-pokemon-images.mjs --limit 40
```

## Download Pokemon 3D models

Download GLB models from `https://pokemon-3d-api.onrender.com/v1/pokemon`:

```sh
node scripts/download-pokemon-models.mjs --limit 10
```

Models are written to `data/models/[id]-[name]/`. Each directory also gets a
`models.json` file with form name, source URL, local filename, and download
status. The script skips existing files and URLs that previously failed, so you
can grow the model dataset:

```sh
node scripts/download-pokemon-models.mjs --limit 10
node scripts/download-pokemon-models.mjs --limit 40
```

## Build compact app data

Build normalized data for the app from downloaded PokeAPI JSON files, images, and
models:

```sh
node scripts/build-data-v2.mjs
```

Output is written to `data-v2`:

- `pokemons/[id]-[name].json` - compact Pokemon records for the app
- `evolutions/*.json` - shared evolution chains referenced by Pokemon records
- `manifest.json` - last build summary

The compact records omit encounters, held items, and moves. Stats and abilities
are simplified, forms include local image references, and models are attached only
when the local model file exists and was not marked as failed.

## Run full data flow

Run the complete local data pipeline in order:

```sh
node scripts/run-full-flow.mjs
```

Preview the commands without running them:

```sh
node scripts/run-full-flow.mjs --dry-run
```

Useful variants:

```sh
node scripts/run-full-flow.mjs --limit 20 --skip-models
node scripts/run-full-flow.mjs --skip-pokeapi --skip-images --skip-models
```

## Review small raster images

Move small raster images into per-Pokemon `ready-to-delete` folders for manual
review. SVG files are ignored.

```sh
node scripts/move-small-images.mjs --dry-run --limit 5
node scripts/move-small-images.mjs --min-width 128 --min-height 128
```

By default images smaller than `128x128` are moved to
`data/images/[id]-[name]/ready-to-delete/`. A `small-images-manifest.json` summary
is written in the image root.

## Review mostly transparent PNGs

Move PNG images where the visible Pokemon is tiny because most pixels are
transparent. SVG, GIF, JPG, JPEG, and WebP files are ignored.

```sh
node scripts/move-transparent-images.mjs --dry-run --limit 5
node scripts/move-transparent-images.mjs --ratio 0.6
```

By default PNGs with more than `60%` fully transparent pixels are moved to
`data/images/[id]-[name]/ready-to-delete/`. A `transparent-images-manifest.json`
summary is written in the image root.

## Clean missing image references

Remove image references from compact Pokemon JSON files when the local image file
no longer exists.

```sh
node scripts/clean-data-v2-missing-images.mjs --dry-run --limit 10
node scripts/clean-data-v2-missing-images.mjs
node scripts/clean-missing-image-refs.mjs --dry-run --limit 10
node scripts/clean-missing-image-refs.mjs
```

By default the script scans `data-v2/pokemons` and removes missing
`forms[].images` entries. A `missing-image-refs-manifest.json` summary is written
in the Pokemon JSON directory.
