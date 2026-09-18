/**
 * De gedeelde laag onder alle wiki-tools: HTTP naar de OSRS Wiki, het bouwen
 * van Bucket-query's, en de hulpfuncties om veldwaarden veilig uit te lezen.
 *
 * Twee API's van dezelfde MediaWiki-installatie:
 *
 * 1. `action=bucket` — gestructureerde data uit de Bucket-extensie. Dat is
 *    waar de infoboxen, drop tables en recepten hun velden in wegschrijven,
 *    dus dit is de betrouwbare bron: geen HTML parsen, wel getypeerde velden.
 * 2. `action=query&list=search` — alleen om een naam die niets oplevert om te
 *    zetten in suggesties. Zoeken doet Bucket niet.
 *
 * Deze module stond eerst in `wiki.ts`. Hij is eruit gehaald toen `itemindex.ts`
 * en `recipes.ts` dezelfde plumbing nodig hadden (ORS-009); de inhoud is
 * ongewijzigd, op de paginering en de cache-schakelaar na — beide nodig om de
 * volledige item-ID-index op te halen zonder anderhalve megabyte ruwe JSON een
 * uur lang dubbel in het geheugen te houden.
 *
 * Endpoints, tabellen en veldnamen geverifieerd tegen de live wiki op
 * 2026-09-17 en opnieuw op 2026-09-18.
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

export const assertSafeName = (name: string, what: string): string => {
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

export interface BucketQuery {
  table: string;
  select: string[];
  where: WhereClause[];
  limit: number;
  /**
   * Bucket kapt elk antwoord af op 5000 rijen, ongeacht welke `limit` je
   * meegeeft (nagemeten 2026-09-18). Een hele tabel ophalen gaat dus in
   * blokken, met `offset` als cursor.
   */
  offset?: number;
}

/** Wat Bucket per antwoord maximaal teruggeeft, hoe hoog `limit` ook staat. */
export const BUCKET_MAX_ROWS = 5000;

const buildBucketQuery = ({ table, select, where, limit, offset }: BucketQuery): string => {
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
  parts.push(`.limit(${Math.trunc(limit)})`);
  if (offset !== undefined && offset > 0) parts.push(`.offset(${Math.trunc(offset)})`);
  parts.push(".run()");
  return parts.join("");
};

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

const cache = new Map<string, { at: number; value: unknown }>();

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `cacheable: false` is voor antwoorden die te groot zijn om een uur te
 * bewaren: de volledige item-index is ruim anderhalve megabyte ruwe JSON en
 * wordt door de aanroeper zelf al in verwerkte vorm gecached. Twee kopieën van
 * dezelfde data in een container van 512 MiB is zonde.
 */
async function apiGet(params: Record<string, string>, cacheable = true): Promise<unknown> {
  const url = new URL(API_URL);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");

  const key = url.search;
  if (cacheable) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  }

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

  if (cacheable) cache.set(key, { at: Date.now(), value: payload });
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

export async function runBucket(
  query: BucketQuery,
  cacheable = true,
): Promise<{
  rows: Record<string, unknown>[];
  cached: boolean;
}> {
  const params = { action: "bucket", query: buildBucketQuery(query) };
  const cached = cacheable && isCached(params);
  const payload = await apiGet(params, cacheable);

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
export async function searchNames(text: string, limit = 5): Promise<string[]> {
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
export async function pageExists(title: string): Promise<boolean> {
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

export const notFound = async (name: string, what: string): Promise<never> => {
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

export const asText = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

export const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export const asBool = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;

/** Repeated velden komen als array terug, maar niet gegarandeerd. */
export const asList = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string" && v.trim() !== "");
  }
  const single = asText(value);
  return single ? [single] : [];
};

/** Wiki-tekst als `[[My Arm's Big Adventure]]` terugbrengen tot platte tekst. */
export const stripWikitext = (value: string): string =>
  value
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/'''?/g, "")
    .trim();

