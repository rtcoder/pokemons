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
