export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: unknown;
}

export interface NamedApiResource {
  name: string;
  url: string;
}

export interface PokemonListFile {
  endpoint: "pokemon";
  url: string;
  count: number;
  downloadedAt: string;
  results: PokemonListItem[];
}

export interface PokemonListItem extends NamedApiResource {
  id: string;
}

export interface PokemonDataFile {
  id: number;
  name: string;
  sourceListItem: PokemonListItem;
  downloadedAt: string;
  endpoints: PokemonDataEndpoints;
}

export interface PokemonDataEndpoints {
  pokemon: PokeApiPokemon;
  pokemonSpecies: PokeApiPokemonSpecies | null;
  evolutionChain: PokeApiEvolutionChain | null;
  encounters: PokeApiEncounter[];
  forms: PokeApiPokemonForm[];
  varieties: PokeApiPokemon[];
  varietyForms: PokeApiPokemonForm[];
  abilities: PokeApiAbility[];
  moves: PokeApiMove[];
  types: PokeApiType[];
  heldItems: PokeApiItem[];
  stats: PokeApiStat[];
}

export interface PokeApiPokemon extends JsonObject {
  id: number;
  name: string;
  base_experience: number | null;
  height: number;
  weight: number;
  order: number;
  is_default: boolean;
  location_area_encounters: string;
  species: NamedApiResource;
  abilities: PokemonAbilitySlot[];
  forms: NamedApiResource[];
  game_indices: JsonObject[];
  held_items: PokemonHeldItemSlot[];
  moves: PokemonMoveSlot[];
  past_abilities: JsonObject[];
  past_stats: JsonObject[];
  past_types: JsonObject[];
  sprites: PokemonSprites;
  stats: PokemonStatSlot[];
  types: PokemonTypeSlot[];
  cries: PokemonCries;
}

export interface PokemonAbilitySlot extends JsonObject {
  ability: NamedApiResource;
  is_hidden: boolean;
  slot: number;
}

export interface PokemonHeldItemSlot extends JsonObject {
  item: NamedApiResource;
  version_details: JsonObject[];
}

export interface PokemonMoveSlot extends JsonObject {
  move: NamedApiResource;
  version_group_details: PokemonMoveVersionDetail[];
}

export interface PokemonMoveVersionDetail extends JsonObject {
  level_learned_at: number;
  move_learn_method: NamedApiResource;
  order: number | null;
  version_group: NamedApiResource;
}

export interface PokemonStatSlot extends JsonObject {
  base_stat: number;
  effort: number;
  stat: NamedApiResource;
}

export interface PokemonTypeSlot extends JsonObject {
  slot: number;
  type: NamedApiResource;
}

export interface PokemonCries extends JsonObject {
  latest: string | null;
  legacy: string | null;
}

export interface PokemonSprites extends JsonObject {
  back_default: string | null;
  back_female: string | null;
  back_shiny: string | null;
  back_shiny_female: string | null;
  front_default: string | null;
  front_female: string | null;
  front_shiny: string | null;
  front_shiny_female: string | null;
  other: JsonObject;
  versions: JsonObject;
}

export interface PokeApiPokemonSpecies extends JsonObject {
  id: number;
  name: string;
  order: number;
  gender_rate: number;
  capture_rate: number;
  base_happiness: number | null;
  is_baby: boolean;
  is_legendary: boolean;
  is_mythical: boolean;
  hatch_counter: number | null;
  has_gender_differences: boolean;
  forms_switchable: boolean;
  color: NamedApiResource;
  shape: NamedApiResource | null;
  evolves_from_species: NamedApiResource | null;
  evolution_chain: { url: string };
  habitat: NamedApiResource | null;
  generation: NamedApiResource;
  egg_groups: NamedApiResource[];
  growth_rate: NamedApiResource;
  pal_park_encounters: JsonObject[];
  flavor_text_entries: FlavorTextEntry[];
  form_descriptions: DescriptionEntry[];
  genera: GenusEntry[];
  varieties: PokemonSpeciesVariety[];
  names: NameEntry[];
}

export interface PokemonSpeciesVariety extends JsonObject {
  is_default: boolean;
  pokemon: NamedApiResource;
}

export interface PokeApiEvolutionChain extends JsonObject {
  id: number;
  baby_trigger_item: NamedApiResource | null;
  chain: EvolutionChainLink;
}

export interface EvolutionChainLink extends JsonObject {
  is_baby: boolean;
  species: NamedApiResource;
  evolution_details: EvolutionDetail[];
  evolves_to: EvolutionChainLink[];
}

export interface EvolutionDetail extends JsonObject {
  gender: number | null;
  held_item: NamedApiResource | null;
  item: NamedApiResource | null;
  known_move: NamedApiResource | null;
  known_move_type: NamedApiResource | null;
  location: NamedApiResource | null;
  min_affection: number | null;
  min_beauty: number | null;
  min_happiness: number | null;
  min_level: number | null;
  needs_overworld_rain: boolean;
  party_species: NamedApiResource | null;
  party_type: NamedApiResource | null;
  relative_physical_stats: number | null;
  time_of_day: string;
  trade_species: NamedApiResource | null;
  trigger: NamedApiResource | null;
  turn_upside_down: boolean;
}

export interface PokeApiEncounter extends JsonObject {
  location_area: NamedApiResource;
  version_details: EncounterVersionDetail[];
}

export interface EncounterVersionDetail extends JsonObject {
  max_chance: number;
  version: NamedApiResource;
  encounter_details: EncounterDetail[];
}

export interface EncounterDetail extends JsonObject {
  chance: number;
  condition_values: NamedApiResource[];
  max_level: number;
  method: NamedApiResource;
  min_level: number;
}

export interface PokeApiPokemonForm extends JsonObject {
  id: number;
  name: string;
  order: number;
  form_order: number;
  is_default: boolean;
  is_battle_only: boolean;
  is_mega: boolean;
  form_name: string;
  pokemon: NamedApiResource;
  types: PokemonTypeSlot[];
  sprites: JsonObject;
  version_group: NamedApiResource;
  names: NameEntry[];
  form_names: NameEntry[];
}

export interface PokeApiAbility extends JsonObject {
  id: number;
  name: string;
  is_main_series: boolean;
  generation: NamedApiResource;
  names: NameEntry[];
  effect_entries: VerboseEffectEntry[];
  effect_changes: JsonObject[];
  flavor_text_entries: FlavorTextEntry[];
  pokemon: JsonObject[];
}

export interface PokeApiMove extends JsonObject {
  id: number;
  name: string;
  accuracy: number | null;
  effect_chance: number | null;
  pp: number | null;
  priority: number;
  power: number | null;
  contest_combos: JsonObject | null;
  contest_type: NamedApiResource | null;
  contest_effect: { url: string } | null;
  damage_class: NamedApiResource;
  effect_entries: VerboseEffectEntry[];
  effect_changes: JsonObject[];
  flavor_text_entries: FlavorTextEntry[];
  generation: NamedApiResource;
  learned_by_pokemon: NamedApiResource[];
  machines: JsonObject[];
  meta: JsonObject | null;
  names: NameEntry[];
  past_values: JsonObject[];
  stat_changes: JsonObject[];
  super_contest_effect: { url: string } | null;
  target: NamedApiResource;
  type: NamedApiResource;
}

export interface PokeApiType extends JsonObject {
  id: number;
  name: string;
  damage_relations: JsonObject;
  past_damage_relations: JsonObject[];
  game_indices: JsonObject[];
  generation: NamedApiResource;
  move_damage_class: NamedApiResource | null;
  names: NameEntry[];
  pokemon: JsonObject[];
  moves: NamedApiResource[];
}

export interface PokeApiItem extends JsonObject {
  id: number;
  name: string;
  cost: number;
  fling_power: number | null;
  fling_effect: NamedApiResource | null;
  attributes: NamedApiResource[];
  category: NamedApiResource;
  effect_entries: VerboseEffectEntry[];
  flavor_text_entries: FlavorTextEntry[];
  game_indices: JsonObject[];
  names: NameEntry[];
  sprites: JsonObject;
  held_by_pokemon: JsonObject[];
  baby_trigger_for: { url: string } | null;
  machines: JsonObject[];
}

export interface PokeApiStat extends JsonObject {
  id: number;
  name: string;
  game_index: number;
  is_battle_only: boolean;
  affecting_moves: JsonObject;
  affecting_natures: JsonObject;
  characteristics: { url: string }[];
  move_damage_class: NamedApiResource | null;
  names: NameEntry[];
}

export interface NameEntry extends JsonObject {
  name: string;
  language: NamedApiResource;
}

export interface GenusEntry extends JsonObject {
  genus: string;
  language: NamedApiResource;
}

export interface DescriptionEntry extends JsonObject {
  description: string;
  language: NamedApiResource;
}

export interface FlavorTextEntry extends JsonObject {
  flavor_text: string;
  language: NamedApiResource;
  version?: NamedApiResource;
  version_group?: NamedApiResource;
}

export interface VerboseEffectEntry extends JsonObject {
  effect: string;
  short_effect: string;
  language: NamedApiResource;
}

export interface DownloadManifestFile {
  apiRoot: string;
  startedAt: string;
  finishedAt: string | null;
  pokemonCount: number;
  selectedOffset: number;
  selectedLimit: number | null;
  selectedCount: number;
  downloaded: number;
  skipped: number;
  failed: DownloadFailure[];
}

export interface DownloadFailure {
  name: string;
  url: string;
  error: string;
}
