/**
 * OSRS Wiki — items, monsters en drop tables ophalen.
 *
 * Twee API's van dezelfde MediaWiki-installatie:
 *
 * 1. `action=bucket` — gestructureerde data uit de Bucket-extensie. Dat is
 *    waar de infoboxen en drop tables hun velden in wegschrijven, dus dit is
 *    de betrouwbare bron: geen HTML parsen, wel getypeerde velden.
 * 2. `action=query&list=search` — alleen om een naam die niets oplevert om te
 *    zetten in suggesties. Zoeken doet Bucket niet.
 *
 * Endpoints, tabellen en veldnamen geverifieerd tegen de live wiki op
 * 2026-09-17.
 */

import { USER_AGENT } from "./useragent.js";

const API_URL = "https://oldschool.runescape.wiki/api.php";

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Ruim langer dan de hiscores (60 s) en WikiSync (5 min): dit is
 * wiki-inhoud. Een drop rate verandert alleen bij een game-update, en één
 * gesprek vraagt dezelfde lookup vaak meerdere keren op.
 */
const CACHE_TTL_MS = 3_600_000;

/** Fout met een melding die rechtstreeks aan de gebruiker getoond kan worden. */
export class WikiError extends Error {}

/**
 * Een naam die niets opleverde, mét suggesties uit de wiki-zoekmachine.
 * Eigen type zodat de tool het verschil kan tonen tussen "bestaat niet" en
 * "bestaat niet, maar bedoelde je dit".
 */
export class WikiNotFoundError extends WikiError {
  constructor(
    message: string,
    readonly suggestions: string[],
  ) {
    super(message);
  }
}

/* ------------------------------------------------------------------ *
 * Bucket-query's bouwen
 * ------------------------------------------------------------------ */

/**
 * De Bucket-API neemt geen JSON aan maar een **Lua-expressie** als string:
 * `bucket("x").select("y").where("z", "waarde").limit(3).run()`. Geverifieerd
 * op 2026-09-17; JSON erin gooien geeft een Lua-parsefout.
 *
 * Dat betekent dat gebruikersinvoer in Lua-broncode terechtkomt, dus die moet
 * hier ontsnapt worden — een losse `"` in een itemnaam zou anders de expressie
 * openbreken. Alleen escapen is niet genoeg om zorgeloos te zijn, daarom
 * weigert `assertSafeName` verdachte invoer er bovenop.
 */
const luaString = (value: string): string =>
  `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")}"`;

/**
 * OSRS-namen bevatten letters, cijfers, spaties en interpunctie als `'`, `-`,
 * `(`, `)`, `#` en `.` — denk aan "Ava's attractor" of "Abyssal whip (Last Man
 * Standing)". Alles daarbuiten (aanhalingstekens, backslashes, haakjes van
 * Lua) is geen wiki-naam en gaat er hier uit, vóór het de query bereikt.
 */
const NAME_PATTERN = /^[\p{L}\p{N} '\-()#,.!?&:+/]+$/u;

const assertSafeName = (name: string, what: string): string => {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new WikiError(`Geef een ${what} op; de naam was leeg.`);
  }
  if (trimmed.length > 120) {
    throw new WikiError(`Die ${what} is te lang om een wiki-pagina te zijn.`);
  }
  if (!NAME_PATTERN.test(trimmed)) {
    throw new WikiError(
      `"${trimmed}" bevat tekens die niet in een OSRS-naam voorkomen. ` +
        "Gebruik de naam zoals hij in het spel of op de wiki staat.",
    );
  }
  return trimmed;
};

/** Eén `where`-paar; de waarde mag tekst of een boolean zijn. */
type WhereClause = [field: string, value: string | boolean];

interface BucketQuery {
  table: string;
  select: string[];
  where: WhereClause[];
  limit: number;
}

const buildBucketQuery = ({ table, select, where, limit }: BucketQuery): string => {
  const parts = [`bucket(${luaString(table)})`];
  parts.push(`.select(${select.map(luaString).join(",")})`);
  for (const [field, value] of where) {
    // Tekstwaarden gaan als kleine letters de query in. Bucket matcht toch
    // hoofdletterongevoelig — nagemeten op 2026-09-17 voor zowel TEXT- als
    // PAGE-velden — en de rijen komen met hun echte schrijfwijze terug. Door
    // te normaliseren krijgen "Twisted bow" en "twisted BOW" dezelfde
    // cachesleutel in plaats van twee calls voor hetzelfde antwoord.
    const rendered =
      typeof value === "boolean" ? String(value) : luaString(value.toLowerCase());
    parts.push(`.where(${luaString(field)},${rendered})`);
  }
  parts.push(`.limit(${Math.trunc(limit)})`, ".run()");
  return parts.join("");
};

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

const cache = new Map<string, { at: number; value: unknown }>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function apiGet(params: Record<string, string>): Promise<unknown> {
  const url = new URL(API_URL);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");

  const key = url.search;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new WikiError(
        `De OSRS Wiki reageerde niet binnen ${REQUEST_TIMEOUT_MS / 1000} seconden. ` +
          "Probeer het zo nog eens.",
      );
    }
    throw new WikiError(
      `Kon de OSRS Wiki niet bereiken: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (response.status === 403 || response.status === 429) {
    throw new WikiError(
      `De OSRS Wiki weigerde het verzoek (HTTP ${response.status}). Dat is meestal ` +
        "rate limiting of een blokkade op de user-agent. Wacht even en probeer opnieuw.",
    );
  }
  if (!response.ok) {
    throw new WikiError(`De OSRS Wiki gaf een onverwachte status terug (HTTP ${response.status}).`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    throw new WikiError(
      "De OSRS Wiki gaf een antwoord terug dat geen geldige JSON was. Mogelijk is " +
        "de wiki tijdelijk uit de lucht.",
    );
  }

  cache.set(key, { at: Date.now(), value: payload });
  return payload;
}

/** true als deze exacte query uit de cache komt in plaats van van de wiki. */
const isCached = (params: Record<string, string>): boolean => {
  const url = new URL(API_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");
  const hit = cache.get(url.search);
  return hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS;
};

async function runBucket(query: BucketQuery): Promise<{
  rows: Record<string, unknown>[];
  cached: boolean;
}> {
  const params = { action: "bucket", query: buildBucketQuery(query) };
  const cached = isCached(params);
  const payload = await apiGet(params);

  if (!isRecord(payload)) {
    throw new WikiError("De Bucket-API gaf een antwoord in een onverwacht formaat.");
  }

  // Bucket meldt fouten in een eigen `error`-veld (string), niet via HTTP.
  if (typeof payload.error === "string") {
    throw new WikiError(
      `De Bucket-API wees de query af: ${payload.error} Mogelijk is de indeling van ` +
        "de wiki-tabellen gewijzigd.",
    );
  }

  const rows = payload.bucket;
  if (!Array.isArray(rows)) {
    // Bij een query die Bucket niet begrijpt echoot hij de geparseerde tabel
    // terug in plaats van een rij-array. Dat is een bug aan onze kant.
    throw new WikiError(
      "De Bucket-API gaf geen rijen terug. Waarschijnlijk klopt de opgebouwde query niet.",
    );
  }

  return { rows: rows.filter(isRecord), cached };
}

/**
 * Namen waar de wiki-zoekmachine op uitkomt voor een tekst die niets exact
 * matchte. `list=search` is hier bewust gekozen boven `action=opensearch`:
 * opensearch doet prefix-matching en geeft bij een typefout niets terug
 * (nagemeten op 2026-09-17 met "abbysal whipp" → leeg), terwijl `list=search`
 * dan "Abyssal whip" vindt.
 */
async function searchNames(text: string, limit = 5): Promise<string[]> {
  try {
    const payload = await apiGet({
      action: "query",
      list: "search",
      srsearch: text,
      srnamespace: "0",
      srlimit: String(limit),
    });
    if (!isRecord(payload) || !isRecord(payload.query)) return [];
    const results = payload.query.search;
    if (!Array.isArray(results)) return [];
    return results
      .filter(isRecord)
      .map((r) => r.title)
      .filter((t): t is string => typeof t === "string");
  } catch {
    // Suggesties zijn een extraatje; als zoeken faalt blijft de hoofdmelding staan.
    return [];
  }
}

/**
 * Of er een gewone wiki-pagina met deze exacte titel bestaat. Nodig omdat het
 * ontbreken van een Bucket-rij twee dingen kan betekenen: de pagina bestaat
 * niet, óf de pagina bestaat wel maar vult die infobox niet in. Hans is zo'n
 * geval: een NPC zonder monster-infobox en zonder drop table.
 */
async function pageExists(title: string): Promise<boolean> {
  try {
    const payload = await apiGet({ action: "query", titles: title, prop: "info" });
    if (!isRecord(payload) || !isRecord(payload.query)) return false;
    const pages = payload.query.pages;
    if (!Array.isArray(pages)) return false;
    return pages.filter(isRecord).some((page) => page.missing !== true);
  } catch {
    return false;
  }
}

const notFound = async (name: string, what: string): Promise<never> => {
  const suggestions = await searchNames(name);
  const tail =
    suggestions.length > 0
      ? ` De wiki-zoekmachine komt uit op: ${suggestions.map((s) => `"${s}"`).join(", ")}.`
      : " De wiki-zoekmachine vindt er ook niets op dat lijkt.";
  throw new WikiNotFoundError(
    `Geen ${what} gevonden op de OSRS Wiki met de naam "${name}".${tail} ` +
      "Let op dat wiki-namen soms afwijken van de naam in het spel, en dat " +
      "varianten een achtervoegsel tussen haakjes hebben.",
    suggestions,
  );
};

/* ------------------------------------------------------------------ *
 * Hulpfuncties voor veldwaarden
 * ------------------------------------------------------------------ */

const asText = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const asBool = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;

/** Repeated velden komen als array terug, maar niet gegarandeerd. */
const asList = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string" && v.trim() !== "");
  }
  const single = asText(value);
  return single ? [single] : [];
};

/** Wiki-tekst als `[[My Arm's Big Adventure]]` terugbrengen tot platte tekst. */
const stripWikitext = (value: string): string =>
  value
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/'''?/g, "")
    .trim();

/* ------------------------------------------------------------------ *
 * Items
 * ------------------------------------------------------------------ */

const ITEM_FIELDS = [
  "page_name",
  "item_name",
  "version_anchor",
  "default_version",
  "item_id",
  "examine",
  "value",
  "high_alchemy_value",
  "weight",
  "tradeable",
  "is_members_only",
  "buy_limit",
  "quest",
  "release_date",
  "removal_date",
] as const;

const BONUS_FIELDS = [
  "page_name",
  "equipment_slot",
  "combat_style",
  "weapon_attack_speed",
  "weapon_attack_range",
  "stab_attack_bonus",
  "slash_attack_bonus",
  "crush_attack_bonus",
  "magic_attack_bonus",
  "range_attack_bonus",
  "stab_defence_bonus",
  "slash_defence_bonus",
  "crush_defence_bonus",
  "magic_defence_bonus",
  "range_defence_bonus",
  "strength_bonus",
  "ranged_strength_bonus",
  "magic_damage_bonus",
  "prayer_bonus",
] as const;

export interface EquipmentBonuses {
  slot: string | null;
  combatStyle: string | null;
  attackSpeed: number | null;
  attackRange: string | null;
  attack: Record<string, number | null>;
  defence: Record<string, number | null>;
  other: Record<string, number | null>;
}

export interface ItemVersion {
  pageName: string;
  itemName: string;
  versionAnchor: string | null;
  isDefault: boolean;
  itemIds: string[];
  examine: string | null;
  value: number | null;
  highAlchemyValue: number | null;
  weight: number | null;
  tradeable: boolean | null;
  membersOnly: boolean | null;
  buyLimit: number | null;
  quest: string | null;
  releaseDate: string | null;
  removalDate: string | null;
  bonuses: EquipmentBonuses | null;
  /** true als dit het item op de pagina zonder achtervoegsel is. */
  isBaseItem: boolean;
  /** true als deze pagina meer dan één versie van het item bevat. */
  hasSiblingVersions: boolean;
}

export interface ItemLookup {
  requestedName: string;
  versions: ItemVersion[];
  cached: boolean;
}

const readBonuses = (row: Record<string, unknown>): EquipmentBonuses => ({
  slot: asText(row.equipment_slot),
  combatStyle: asText(row.combat_style),
  attackSpeed: asNumber(row.weapon_attack_speed),
  attackRange: asText(row.weapon_attack_range),
  attack: {
    Stab: asNumber(row.stab_attack_bonus),
    Slash: asNumber(row.slash_attack_bonus),
    Crush: asNumber(row.crush_attack_bonus),
    Magic: asNumber(row.magic_attack_bonus),
    Ranged: asNumber(row.range_attack_bonus),
  },
  defence: {
    Stab: asNumber(row.stab_defence_bonus),
    Slash: asNumber(row.slash_defence_bonus),
    Crush: asNumber(row.crush_defence_bonus),
    Magic: asNumber(row.magic_defence_bonus),
    Ranged: asNumber(row.range_defence_bonus),
  },
  other: {
    "Strength bonus": asNumber(row.strength_bonus),
    "Ranged strength": asNumber(row.ranged_strength_bonus),
    "Magic damage %": asNumber(row.magic_damage_bonus),
    "Prayer bonus": asNumber(row.prayer_bonus),
  },
});

export async function lookupItem(name: string): Promise<ItemLookup> {
  const wanted = assertSafeName(name, "itemnaam");

  // Bucket matcht hoofdletterongevoelig op tekstvelden (nagemeten 2026-09-17),
  // dus "abyssal whip" vindt "Abyssal whip" zonder eigen normalisatie.
  let { rows, cached } = await runBucket({
    table: "infobox_item",
    select: [...ITEM_FIELDS],
    where: [["item_name", wanted]],
    limit: 25,
  });

  // Varianten staan onder een eigen paginanaam met achtervoegsel, waarbij
  // `item_name` de gewone naam blijft. Levert dat niets op, dan is de invoer
  // misschien juist zo'n paginanaam ("Abyssal whip (Last Man Standing)").
  if (rows.length === 0) {
    const byPage = await runBucket({
      table: "infobox_item",
      select: [...ITEM_FIELDS],
      where: [["page_name", wanted]],
      limit: 25,
    });
    rows = byPage.rows;
    cached = cached && byPage.cached;
  }

  if (rows.length === 0) await notFound(wanted, "item");

  const bonusesByPage = new Map<string, EquipmentBonuses>();
  const pages = [...new Set(rows.map((r) => asText(r.page_name)).filter((p): p is string => !!p))];
  // Per pagina apart: Bucket heeft geen IN-operator die hier bruikbaar is, en
  // het zijn er in de praktijk een handvol.
  for (const page of pages.slice(0, 10)) {
    const bonus = await runBucket({
      table: "infobox_bonuses",
      select: [...BONUS_FIELDS],
      where: [["page_name", page]],
      limit: 1,
    });
    const row = bonus.rows[0];
    if (row) bonusesByPage.set(page, readBonuses(row));
    cached = cached && bonus.cached;
  }

  const versions: ItemVersion[] = rows.map((row) => {
    const pageName = asText(row.page_name) ?? wanted;
    const quest = asText(row.quest);
    return {
      pageName,
      itemName: asText(row.item_name) ?? wanted,
      versionAnchor: asText(row.version_anchor),
      isDefault: asBool(row.default_version) ?? false,
      itemIds: asList(row.item_id),
      examine: asText(row.examine),
      value: asNumber(row.value),
      highAlchemyValue: asNumber(row.high_alchemy_value),
      weight: asNumber(row.weight),
      tradeable: asBool(row.tradeable),
      membersOnly: asBool(row.is_members_only),
      buyLimit: asNumber(row.buy_limit),
      // "No" is hoe de infobox "geen quest-item" opschrijft; dat is geen info.
      quest: quest && quest.toLowerCase() !== "no" ? stripWikitext(quest) : null,
      releaseDate: asText(row.release_date),
      removalDate: asText(row.removal_date),
      bonuses: bonusesByPage.get(pageName) ?? null,
      // Hieronder gezet, zodra alle rijen bekend zijn.
      isBaseItem: false,
      hasSiblingVersions: false,
    };
  });

  /**
   * `default_version` geldt *binnen* een pagina, niet over pagina's heen: elke
   * variantpagina heeft zijn eigen standaardversie, dus dat veld kan niet
   * bepalen welke van drie "Abyssal whip"-items de gewone is. Daarvoor is de
   * paginanaam de aanwijzing — de gewone versie staat op de pagina zonder
   * achtervoegsel, en dat is de pagina die exact zo heet als het item.
   */
  const isBasePage = (version: ItemVersion): boolean =>
    version.pageName.toLowerCase() === version.itemName.toLowerCase();

  versions.sort(
    (a, b) =>
      Number(isBasePage(b)) - Number(isBasePage(a)) ||
      Number(b.isDefault) - Number(a.isDefault) ||
      a.pageName.localeCompare(b.pageName, "en"),
  );

  // Hoeveel rijen dezelfde pagina delen; alleen dán zegt `default_version` iets.
  const perPage = new Map<string, number>();
  for (const version of versions) {
    perPage.set(version.pageName, (perPage.get(version.pageName) ?? 0) + 1);
  }
  for (const version of versions) {
    version.hasSiblingVersions = (perPage.get(version.pageName) ?? 1) > 1;
    version.isBaseItem = isBasePage(version);
  }

  return { requestedName: wanted, versions, cached };
}

/* ------------------------------------------------------------------ *
 * Monsters
 * ------------------------------------------------------------------ */

const MONSTER_FIELDS = [
  "page_name",
  "name",
  "version_anchor",
  "default_version",
  "id",
  "examine",
  "is_members_only",
  "combat_level",
  "hitpoints",
  "max_hit",
  "attack_speed",
  "attack_style",
  "attribute",
  "size",
  "poisonous",
  "slayer_level",
  "slayer_experience",
  "slayer_category",
  "assigned_by",
  "attack_level",
  "strength_level",
  "defence_level",
  "ranged_level",
  "magic_level",
  "stab_attack_bonus",
  "slash_attack_bonus",
  "crush_attack_bonus",
  "magic_attack_bonus",
  "range_attack_bonus",
  "attack_bonus",
  "strength_bonus",
  "range_strength_bonus",
  "magic_damage_bonus",
  "stab_defence_bonus",
  "slash_defence_bonus",
  "crush_defence_bonus",
  "magic_defence_bonus",
  "range_defence_bonus",
  "light_range_defence_bonus",
  "standard_range_defence_bonus",
  "heavy_range_defence_bonus",
  "flat_armour",
  "elemental_weakness",
  "elemental_weakness_percent",
  "poison_resistance",
  "venom_resistance",
  "freeze_resistance",
  "cannon_immune",
  "thrall_immune",
  "burn_immune",
  "release_date",
] as const;

export interface MonsterVersion {
  pageName: string;
  name: string;
  versionAnchor: string | null;
  isDefault: boolean;
  monsterIds: string[];
  examine: string | null;
  membersOnly: boolean | null;
  combatLevel: number | null;
  hitpoints: number | null;
  maxHits: string[];
  attackSpeed: number | null;
  attackStyles: string[];
  attributes: string[];
  size: number | null;
  poisonous: string | null;
  slayer: {
    level: number | null;
    experience: number | null;
    categories: string[];
    assignedBy: string[];
  };
  combatStats: Record<string, number | null>;
  attackBonuses: Record<string, number | null>;
  defenceBonuses: Record<string, number | null>;
  /**
   * De generieke bonussen uit de infobox. Veel monsters vullen alleen deze in
   * en laten de bonussen per aanvalstype leeg, dus zonder dit blok lijkt een
   * monster ten onrechte nergens een aanvalsbonus te hebben.
   */
  otherBonuses: Record<string, number | null>;
  flatArmour: number | null;
  /**
   * De expliciete zwakte uit de infobox (element + percentage). Staat er niets,
   * dan zegt de wiki daar niets over — dat is iets anders dan "geen zwakte".
   */
  elementalWeakness: { element: string; percent: number | null } | null;
  resistances: Record<string, string | null>;
  releaseDate: string | null;
}

export interface MonsterLookup {
  requestedName: string;
  versions: MonsterVersion[];
  cached: boolean;
}

export async function lookupMonster(name: string): Promise<MonsterLookup> {
  const wanted = assertSafeName(name, "monsternaam");

  let { rows, cached } = await runBucket({
    table: "infobox_monster",
    select: [...MONSTER_FIELDS],
    where: [["name", wanted]],
    limit: 40,
  });

  if (rows.length === 0) {
    const byPage = await runBucket({
      table: "infobox_monster",
      select: [...MONSTER_FIELDS],
      where: [["page_name", wanted]],
      limit: 40,
    });
    rows = byPage.rows;
    cached = cached && byPage.cached;
  }

  if (rows.length === 0) await notFound(wanted, "monster");

  const versions: MonsterVersion[] = rows.map((row) => {
    const element = asText(row.elemental_weakness);
    return {
      pageName: asText(row.page_name) ?? wanted,
      name: asText(row.name) ?? wanted,
      versionAnchor: asText(row.version_anchor),
      isDefault: asBool(row.default_version) ?? false,
      monsterIds: asList(row.id),
      examine: asText(row.examine),
      membersOnly: asBool(row.is_members_only),
      combatLevel: asNumber(row.combat_level),
      hitpoints: asNumber(row.hitpoints),
      maxHits: asList(row.max_hit),
      attackSpeed: asNumber(row.attack_speed),
      attackStyles: asList(row.attack_style),
      attributes: asList(row.attribute),
      size: asNumber(row.size),
      poisonous: asText(row.poisonous),
      slayer: {
        level: asNumber(row.slayer_level),
        experience: asNumber(row.slayer_experience),
        categories: asList(row.slayer_category),
        assignedBy: asList(row.assigned_by),
      },
      combatStats: {
        Attack: asNumber(row.attack_level),
        Strength: asNumber(row.strength_level),
        Defence: asNumber(row.defence_level),
        Ranged: asNumber(row.ranged_level),
        Magic: asNumber(row.magic_level),
      },
      attackBonuses: {
        Stab: asNumber(row.stab_attack_bonus),
        Slash: asNumber(row.slash_attack_bonus),
        Crush: asNumber(row.crush_attack_bonus),
        Magic: asNumber(row.magic_attack_bonus),
        Ranged: asNumber(row.range_attack_bonus),
      },
      defenceBonuses: {
        Stab: asNumber(row.stab_defence_bonus),
        Slash: asNumber(row.slash_defence_bonus),
        Crush: asNumber(row.crush_defence_bonus),
        Magic: asNumber(row.magic_defence_bonus),
        Ranged: asNumber(row.range_defence_bonus),
        "Ranged (light)": asNumber(row.light_range_defence_bonus),
        "Ranged (standard)": asNumber(row.standard_range_defence_bonus),
        "Ranged (heavy)": asNumber(row.heavy_range_defence_bonus),
      },
      otherBonuses: {
        "Attack bonus": asNumber(row.attack_bonus),
        "Strength bonus": asNumber(row.strength_bonus),
        "Ranged strength": asNumber(row.range_strength_bonus),
        "Magic damage %": asNumber(row.magic_damage_bonus),
      },
      flatArmour: asNumber(row.flat_armour),
      elementalWeakness: element
        ? { element, percent: asNumber(row.elemental_weakness_percent) }
        : null,
      resistances: {
        Poison: asText(row.poison_resistance),
        Venom: asText(row.venom_resistance),
        Freeze: asText(row.freeze_resistance),
        Cannon: asText(row.cannon_immune),
        Thralls: asText(row.thrall_immune),
        Burn: asText(row.burn_immune),
      },
      releaseDate: asText(row.release_date),
    };
  });

  versions.sort((a, b) =>
    a.isDefault !== b.isDefault
      ? Number(b.isDefault) - Number(a.isDefault)
      : (a.versionAnchor ?? "").localeCompare(b.versionAnchor ?? "", "en"),
  );

  return { requestedName: wanted, versions, cached };
}

/* ------------------------------------------------------------------ *
 * Drop tables
 * ------------------------------------------------------------------ */

/**
 * Eén regel uit een drop table, zoals `{{DropsLine}}` hem heeft weggeschreven.
 *
 * De inhoud zit in het veld `drop_json` van de `dropsline`-tabel: één JSON-blob
 * per regel. Dat veld is in Bucket `index: false`, dus er kan niet op
 * gefilterd worden — filteren gaat op `page_name` (de bronpagina, dus het
 * monster) of `item_name` (het gedropte item).
 */
export interface DropLine {
  itemName: string;
  /** De bron zoals de wiki hem noteert, inclusief eventuele `#versie`. */
  droppedFrom: string | null;
  /** Versie-anker uit `Dropped from`, als het monster meerdere versies heeft. */
  version: string | null;
  /** Rauwe zeldzaamheid: een breuk als "3/128" of een woord als "Always". */
  rarity: string | null;
  /** De breuk als getal, zonder het aantal rolls erin. Null bij "Always"/"Varies". */
  chance: number | null;
  /**
   * De kans op minstens één exemplaar per kill. Bij meerdere rolls is dat
   * `1 - (1 - breuk)^rolls`, niet `breuk × rolls`: dat laatste is het
   * verwachte aántal drops en loopt boven de 100% uit zodra de breuk groot is
   * (twee rolls van 1/2 zou 100% geven in plaats van 75%).
   *
   * Dit is het getal om op te sorteren en te tonen. De wiki zelf combineert de
   * rolls niet en schrijft "2 × 3,33%"; die per-roll-breuk blijft in `rarity`
   * en `rolls` staan, zodat beide lezingen beschikbaar zijn.
   */
  chancePerKill: number | null;
  /** Aantal rolls; een drop met 2 rolls valt vaker dan de breuk suggereert. */
  rolls: number | null;
  /** true als de wiki de kans zelf als benadering markeert. */
  approximate: boolean;
  quantity: string | null;
  /** `combat`, `reward`, `thieving`, … — niet elke drop komt van een kill. */
  dropType: string | null;
  dropLevel: string | null;
  /** true als deze regel via de rare drop table binnenkomt, niet direct. */
  fromRareDropTable: boolean;
}

export interface DropTable {
  /** De bronnaam zoals gevraagd. */
  requestedName: string;
  lines: DropLine[];
  /** Hoeveel regels via de rare drop table zijn weggelaten. */
  rareDropTableExcluded: number;
  /** true als de limiet is geraakt en de lijst dus is afgekapt. */
  truncated: boolean;
  cached: boolean;
}

/**
 * Zet "3/128" of "1/2,000" om in een kans. Woorden als "Always", "Varies" en
 * "Random" leveren bewust null op in plaats van een verzonnen getal: de
 * uitvoer toont dan het woord zelf.
 *
 * Duizendscheidingstekens moeten eruit vóór het delen — "1/2,000" is 1/2000,
 * niet 1/2.
 */
const parseChance = (rarity: string | null): number | null => {
  if (!rarity) return null;
  const cleaned = rarity.replace(/,/g, "").trim();
  const fraction = /^([\d.]+)\s*\/\s*([\d.]+)$/.exec(cleaned);
  if (fraction) {
    const numerator = Number(fraction[1]);
    const denominator = Number(fraction[2]);
    if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0) {
      return numerator / denominator;
    }
  }
  const percent = /^([\d.]+)\s*%$/.exec(cleaned);
  if (percent) {
    const value = Number(percent[1]);
    if (Number.isFinite(value)) return value / 100;
  }
  return null;
};

const readDropLine = (row: Record<string, unknown>): DropLine | null => {
  const raw = asText(row.drop_json);
  if (!raw) return null;

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;

  const droppedFrom = asText(data["Dropped from"]);
  // `Dropped from` is "Monster#Versie" als het monster versies heeft.
  const hash = droppedFrom?.indexOf("#") ?? -1;
  const rarity = asText(data.Rarity);
  const chance = parseChance(rarity);
  const rolls = asNumber(data.Rolls);

  return {
    itemName: asText(row.item_name) ?? asText(data["Dropped item"]) ?? "(onbekend item)",
    droppedFrom,
    version:
      droppedFrom && hash > -1 ? droppedFrom.slice(hash + 1).replace(/_/g, " ") : null,
    rarity,
    chance,
    chancePerKill:
      chance === null
        ? null
        : rolls !== null && rolls > 1
          ? 1 - Math.pow(1 - Math.min(1, chance), rolls)
          : chance,
    rolls,
    approximate: data.Approx === true,
    quantity: asText(data["Drop Quantity"]),
    dropType: asText(data["Drop type"]),
    dropLevel: asText(data["Drop level"]),
    fromRareDropTable: asBool(row.rare_drop_table) ?? false,
  };
};

const DROP_LIMIT = 500;

export async function fetchDropTable(
  monsterName: string,
  includeRareDropTable: boolean,
): Promise<DropTable> {
  const wanted = assertSafeName(monsterName, "monsternaam");

  const { rows, cached } = await runBucket({
    table: "dropsline",
    select: ["page_name", "item_name", "rare_drop_table", "drop_json"],
    // Filter op de bronpagina: `{{DropsLine}}` staat op de monsterpagina.
    where: [["page_name", wanted]],
    limit: DROP_LIMIT,
  });

  if (rows.length === 0) {
    // Onderscheid maken tussen "bestaat niet" en "bestaat, maar heeft geen drop
    // table" — anders stuurt de melding de gebruiker de verkeerde kant op.
    // Hier telt het bestaan van de página, niet van een monster-infobox: een
    // NPC als Hans heeft die infobox niet en zou anders "niet gevonden" heten.
    if (!(await pageExists(wanted))) await notFound(wanted, "pagina");
    throw new WikiError(
      `De pagina "${wanted}" bestaat op de wiki, maar er staat geen drop table op. ` +
        "Dat klopt voor NPC's die je niet kunt aanvallen en voor monsters die niets " +
        "droppen; bij sommige bosses staat de buit op een aparte pagina.",
    );
  }

  const all = rows.map(readDropLine).filter((line): line is DropLine => line !== null);
  const lines = includeRareDropTable ? all : all.filter((l) => !l.fromRareDropTable);

  // Zekerste drops eerst; "Always" (chance null maar rarity gezet) bovenaan.
  // Sorteren op de kans mét rolls, want dat is ook wat de uitvoer laat zien.
  const weight = (line: DropLine): number => {
    if (line.rarity && /^always$/i.test(line.rarity)) return 2;
    return line.chancePerKill ?? -1;
  };
  lines.sort((a, b) => weight(b) - weight(a) || a.itemName.localeCompare(b.itemName, "en"));

  return {
    requestedName: wanted,
    lines,
    rareDropTableExcluded: includeRareDropTable ? 0 : all.length - lines.length,
    truncated: rows.length >= DROP_LIMIT,
    cached,
  };
}
