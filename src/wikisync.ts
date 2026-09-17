/**
 * WikiSync — questvoortgang (en wat er gratis meekomt) ophalen bij de OSRS Wiki.
 *
 * WikiSync is een RuneLite-plugin die bij het inloggen een momentopname van je
 * account naar de wiki pusht. Die opname is daarna publiek opvraagbaar per
 * speler. Dit is community-infrastructuur, geen officiële Jagex-API: het
 * formaat kan wijzigen, dus alles hieronder parst defensief en valt terug op
 * een nette melding in plaats van een crash.
 *
 * Endpoint en formaat geverifieerd tegen de live API op 2026-09-17.
 */

import { USER_AGENT } from "./useragent.js";

const BASE_URL = "https://sync.runescape.wiki/runelite/player";

/**
 * Het pad eindigt op een RuneLite-*wereldtype*, niet op een accounttype.
 * Geverifieerd op 2026-09-17: alleen `STANDARD` levert data; `IRONMAN`,
 * `GROUP_IRONMAN`, `DEADMAN`, `LEAGUE` en zelfs `standard` in kleine letters
 * geven allemaal HTTP 400 "Cannot query data for this world type."
 *
 * Dat is geen beperking: ironmen en group-ironmen spelen op gewone werelden en
 * staan dus óók onder `STANDARD`. Geverifieerd met een ironman-account
 * ("Iron Mammal"), dat gewoon via `STANDARD` terugkomt. Er is hier daarom
 * bewust geen accounttype-parameter — die zou alleen maar 400's opleveren.
 */
const WORLD_TYPE = "STANDARD";

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Ruimer dan de cache van de hiscores (60 s). WikiSync-data verandert alleen
 * op het moment dat de speler inlogt met de plugin aan; vaker ophalen levert
 * dus bijna altijd hetzelfde antwoord op.
 */
const CACHE_TTL_MS = 300_000;

export type QuestStatus = "not_started" | "in_progress" | "finished";

/**
 * De API geeft per quest een getal. Dat is de ordinal van RuneLite's
 * `QuestState`: 0 NOT_STARTED, 1 IN_PROGRESS, 2 FINISHED. Geverifieerd op
 * 2026-09-17 over meerdere accounts: er komen geen andere waarden voor, en de
 * quests die op 1 stonden waren aantoonbaar half afgemaakte quests.
 */
const QUEST_STATE_BY_CODE: Record<number, QuestStatus> = {
  0: "not_started",
  1: "in_progress",
  2: "finished",
};

export const QUEST_STATUS_LABEL: Record<QuestStatus, string> = {
  not_started: "Niet gestart",
  in_progress: "Bezig",
  finished: "Afgerond",
};

export interface QuestEntry {
  name: string;
  status: QuestStatus;
}

export interface DiarySummary {
  region: string;
  /** Tiers die volledig af zijn, in vaste volgorde. */
  completed: string[];
  /** Alle tiers die de wiki voor deze regio teruggaf. */
  all: string[];
}

/**
 * Wat er naast de quests in dezelfde respons zit. Bewust alleen samengevat:
 * het komt gratis mee, maar eigen tools ervoor zijn een apart ticket.
 */
export interface WikiSyncExtras {
  diaries: DiarySummary[];
  /** Aantal voltooide combat achievements, of null als het veld ontbreekt. */
  combatAchievements: number | null;
  musicTracks: { unlocked: number; total: number } | null;
  /** Levels zoals WikiSync ze zag; los van de hiscores. */
  levels: Record<string, number> | null;
}

export interface WikiSyncResult {
  username: string;
  /**
   * Het `timestamp`-veld uit de respons. Dat is NIET het moment van de laatste
   * sync maar het moment van het antwoord — nagemeten op 2026-09-17: twee
   * opvragingen van dezelfde speler een seconde na elkaar gaven twee
   * verschillende, actuele tijdstippen, en er zit geen `Last-Modified` op de
   * respons. Hoe oud de gesynchroniseerde data is, is dus niet te zien.
   */
  retrievedAt: string | null;
  quests: QuestEntry[];
  /** Questwaarden die niet 0, 1 of 2 waren — teken dat het formaat wijzigde. */
  unknownStateCount: number;
  extras: WikiSyncExtras;
  cached: boolean;
}

/** Fout met een melding die rechtstreeks aan de gebruiker getoond kan worden. */
export class WikiSyncError extends Error {}

const cache = new Map<string, { at: number; result: WikiSyncResult }>();

/** Vaste volgorde, zodat de uitvoer niet per regio anders oogt. */
const DIARY_TIER_ORDER = ["Easy", "Medium", "Hard", "Elite"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const summariseDiaries = (raw: unknown): DiarySummary[] => {
  if (!isRecord(raw)) return [];

  return Object.entries(raw)
    .map(([region, tiers]) => {
      if (!isRecord(tiers)) return { region, completed: [], all: [] };

      const names = Object.keys(tiers).sort((a, b) => {
        const ia = DIARY_TIER_ORDER.indexOf(a);
        const ib = DIARY_TIER_ORDER.indexOf(b);
        // Onbekende tiers achteraan, verder op de vaste volgorde.
        return (ia === -1 ? Number.MAX_SAFE_INTEGER : ia) - (ib === -1 ? Number.MAX_SAFE_INTEGER : ib);
      });

      const completed = names.filter((tier) => {
        const entry = tiers[tier];
        return isRecord(entry) && entry.complete === true;
      });

      return { region, completed, all: names };
    })
    .sort((a, b) => a.region.localeCompare(b.region, "nl"));
};

const summariseExtras = (payload: Record<string, unknown>): WikiSyncExtras => {
  const music = payload.music_tracks;
  const musicValues = isRecord(music) ? Object.values(music) : null;

  const levels = isRecord(payload.levels)
    ? Object.fromEntries(
        Object.entries(payload.levels).filter(
          (entry): entry is [string, number] => typeof entry[1] === "number",
        ),
      )
    : null;

  return {
    diaries: summariseDiaries(payload.achievement_diaries),
    combatAchievements: Array.isArray(payload.combat_achievements)
      ? payload.combat_achievements.length
      : null,
    musicTracks: musicValues
      ? { unlocked: musicValues.filter((v) => v === true).length, total: musicValues.length }
      : null,
    levels: levels && Object.keys(levels).length > 0 ? levels : null,
  };
};

/**
 * Leest de questlijst uit een WikiSync-respons.
 *
 * De respons bevat één lege sleutel `"."` — een placeholder uit RuneLite's
 * Quest-enum, geen echte quest. Die en alles zonder letters in de naam gaan
 * eruit; ze zouden alleen maar ruis in de lijst geven.
 */
export function parseQuests(raw: unknown): {
  quests: QuestEntry[];
  unknownStateCount: number;
} {
  if (!isRecord(raw)) {
    throw new WikiSyncError(
      "De WikiSync-respons bevatte geen questgegevens. Mogelijk is het formaat " +
        "van de wiki-API gewijzigd.",
    );
  }

  const quests: QuestEntry[] = [];
  let unknownStateCount = 0;

  for (const [name, value] of Object.entries(raw)) {
    if (!/[A-Za-z]/.test(name)) continue;

    const status = typeof value === "number" ? QUEST_STATE_BY_CODE[value] : undefined;
    if (!status) {
      unknownStateCount += 1;
      continue;
    }

    quests.push({ name, status });
  }

  if (quests.length === 0) {
    throw new WikiSyncError(
      "De WikiSync-respons bevatte een lege questlijst. Mogelijk is de sync " +
        "mislukt of is het formaat van de wiki-API gewijzigd.",
    );
  }

  quests.sort((a, b) => a.name.localeCompare(b.name, "nl"));
  return { quests, unknownStateCount };
}

/**
 * WikiSync matcht op de display name zelf, hoofdletterongevoelig, en rekent
 * een underscore NIET als spatie — `Mr_Bilel` geeft `NO_USER_DATA` terwijl
 * `Mr Bilel` data geeft. De hiscores zijn daar wél soepel in. Underscores
 * worden daarom omgezet; OSRS-namen bevatten ze niet, het is de oude
 * URL-vriendelijke schrijfwijze van een spatie.
 *
 * Spaties wegláten gebeurt bewust niet: `MrBilel` en `Mr Bilel` zijn twee
 * verschillende accounts (nagemeten op de hiscores, 2026-09-17). "Behulpzaam"
 * normaliseren zou dan stilletjes de data van een vreemde teruggeven.
 */
const normaliseName = (username: string): string =>
  username.trim().replace(/_/g, " ");

export async function fetchWikiSync(username: string): Promise<WikiSyncResult> {
  const name = normaliseName(username);
  const key = name.toLowerCase();

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { ...hit.result, cached: true };
  }

  const url = `${BASE_URL}/${encodeURIComponent(name)}/${WORLD_TYPE}`;

  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { "User-Agent": USER_AGENT },
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new WikiSyncError(
        `WikiSync reageerde niet binnen ${REQUEST_TIMEOUT_MS / 1000} seconden. ` +
          "Probeer het zo nog eens.",
      );
    }
    throw new WikiSyncError(
      `Kon WikiSync niet bereiken: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const body = await response.text();

  if (!response.ok) {
    // Een onbekende of nooit gesynchroniseerde speler is een HTTP 400 met
    // `code: "NO_USER_DATA"` — niet een 404. Dat is het enige foutgeval dat de
    // gebruiker zelf kan oplossen, dus dat krijgt een eigen uitleg.
    let code: unknown;
    try {
      const parsed: unknown = JSON.parse(body);
      if (isRecord(parsed)) code = parsed.code;
    } catch {
      // Geen JSON; dan blijft het bij de generieke melding hieronder.
    }

    if (code === "NO_USER_DATA") {
      throw new WikiSyncError(
        `WikiSync heeft nog nooit data ontvangen voor "${name}". Zo komt die er:\n` +
          "1. Installeer de plugin \"WikiSync\" uit de RuneLite Plugin Hub en zet hem aan.\n" +
          "2. Log één keer in op het account op een gewone wereld.\n" +
          "3. Probeer het daarna opnieuw — de sync gebeurt bij het inloggen.\n" +
          "Staat de plugin al aan? Dan is hij waarschijnlijk pas ná het inloggen " +
          "geladen; WikiSync verstuurt alleen op het inlogmoment, dus opnieuw " +
          "inloggen is genoeg.\n" +
          "Controleer ook de schrijfwijze: gebruik de character name, niet de naam " +
          "van het Jagex-account. WikiSync matcht op de display name zelf en telt " +
          "spaties mee — \"MrBilel\" en \"Mr Bilel\" zijn twee verschillende accounts.",
      );
    }

    throw new WikiSyncError(
      `WikiSync gaf een onverwachte status terug (HTTP ${response.status}).` +
        (body ? ` Antwoord: ${body.slice(0, 200)}` : ""),
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new WikiSyncError(
      "WikiSync gaf een antwoord terug dat geen geldige JSON was. Mogelijk is de " +
        "dienst tijdelijk uit de lucht.",
    );
  }

  if (!isRecord(payload)) {
    throw new WikiSyncError(
      "WikiSync gaf een antwoord terug in een onverwacht formaat.",
    );
  }

  const { quests, unknownStateCount } = parseQuests(payload.quests);

  const result: WikiSyncResult = {
    username: typeof payload.username === "string" ? payload.username : name,
    retrievedAt: typeof payload.timestamp === "string" ? payload.timestamp : null,
    quests,
    unknownStateCount,
    extras: summariseExtras(payload),
    cached: false,
  };

  cache.set(key, { at: Date.now(), result });
  return result;
}
