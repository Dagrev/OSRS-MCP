/**
 * De live spelstaat: waar staat de speler, en hoe staat hij ervoor.
 *
 * De plugin schrijft `player-state.json` naar dezelfde map als de bank en de
 * inventory (ORS-015). Anders dan die twee gebeurt dat niet op een event maar
 * op een tick, met een throttle van vijf seconden en een hartslag van zestig.
 * Dat maakt de leeftijd van dit bestand een heel ander signaal dan bij de bank:
 *
 *   - **jonger dan ~70 seconden** → de client draait en dit is de stand van nu;
 *   - **ouder dan twee minuten** → er wordt niet meer gespeeld, want de
 *     hartslag zou anders geschreven hebben.
 *
 * Juist die tweede conclusie is waar de hartslag voor bestaat, en daarom
 * behandelt deze module een oud bestand niet als "misschien verouderd" maar
 * als "de client draait niet meer". Stilstaan is geen uitzondering: ook wie
 * een uur niets doet krijgt elke minuut een nieuw tijdstempel.
 *
 * Net als `plugindata.ts`: geen cache, en een storing wordt nooit als een
 * geldige staat gepresenteerd.
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  DATA_DIR_ENV,
  PluginDataError,
  dataDir,
  inspectDataDir,
} from "./plugindata.js";
import { describePlace, type PlaceDescription } from "./landmarks.js";

/** De bestandsnaam die de plugin in zijn datamap gebruikt. */
export const PLAYER_STATE_FILE = "player-state.json";

/** De throttle van de plugin: korter dan dit kan het bestand niet verversen. */
export const WRITE_INTERVAL_SECONDS = 5;

/** De hartslag van de plugin. */
export const HEARTBEAT_SECONDS = 60;

/**
 * Vanaf hier heet de staat dood in plaats van oud. De hartslag is 60 seconden;
 * twee hartslagen plus wat marge vangt een tick die net te laat kwam, een
 * SMB-schrijfactie die eenmalig faalde en een klok die een paar seconden
 * verloopt. Het werklog van ORS-015 meet één mislukte schrijfreeks van vier
 * minuten, dus dit is een sterke hint en geen bewijs.
 */
export const DEAD_AFTER_SECONDS = 150;

export interface PlayerState {
  /** Het pad dat gelezen is — zodat een verkeerde mount zichtbaar wordt. */
  path: string;
  /** Tijdstempel uit het bestand (ISO 8601), wandklok van de spelmachine. */
  timestamp: string;
  /** Leeftijd in seconden, of null als het tijdstempel onleesbaar was. */
  ageSeconds: number | null;
  /** Wijzigingstijd van het bestand, als tweede aanwijzing naast `timestamp`. */
  fileModified: string;

  playerName: string | null;
  world: number | null;
  x: number;
  y: number;
  plane: number;
  regionId: number;
  inInstance: boolean;
  runEnergy: number | null;
  hpCurrent: number | null;
  hpMax: number | null;
  prayerCurrent: number | null;
  prayerMax: number | null;
  combatLevel: number | null;

  /** De leesbare plaatsaanduiding bij deze coördinaat. */
  place: PlaceDescription;

  /** Velden die het bestand niet had of die geen getal waren. */
  missingFields: string[];
}

/** Een getal uit het bestand, of null als het er niet (goed) in stond. */
const optionalNumber = (
  record: Record<string, unknown>,
  key: string,
  missing: string[],
): number | null => {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    missing.push(key);
    return null;
  }
  return value;
};

/**
 * De vier velden die de staat zijn betekenis geven. Ontbreekt er één, dan is er
 * geen plaatsbepaling meer en is een half antwoord erger dan een foutmelding —
 * dan zou Claude op een coördinaat van 0,0 gaan rekenen.
 */
const requiredNumber = (
  record: Record<string, unknown>,
  key: string,
  path: string,
): number => {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PluginDataError(
      "file_unreadable",
      `"${path}" heeft geen geldige "${key}". Deze server verwacht de velden ` +
        "die de plugin wegschrijft (x, y, plane, regionId, ...). Mogelijk is " +
        "het formaat van de plugin gewijzigd; er is dus geen positie bekend, " +
        "wat iets anders is dan een speler die niet ingelogd is.",
    );
  }
  return value;
};

export const readPlayerState = async (): Promise<PlayerState> => {
  const dir = dataDir();
  const entries = await inspectDataDir(dir);

  if (entries.length === 0) {
    throw new PluginDataError(
      "dir_empty",
      `De datamap "${dir}" bestaat wel, maar is helemaal leeg. Als álles ` +
        "ontbreekt is de mount waarschijnlijk niet aangehaakt (een mislukte " +
        "CIFS- of NFS-mount laat een lege map achter). Het zegt dus niets over " +
        "waar de speler staat.",
    );
  }

  const path = join(dir, PLAYER_STATE_FILE);

  if (!entries.includes(PLAYER_STATE_FILE)) {
    throw new PluginDataError(
      "file_missing",
      `"${PLAYER_STATE_FILE}" staat niet in "${dir}", terwijl de map wel andere ` +
        `bestanden heeft (${entries.slice(0, 5).join(", ")}). De map is dus ` +
        "bereikbaar; de plugin heeft de spelstaat alleen nog nooit " +
        "weggeschreven. Dat gebeurt op de eerste tick na inloggen. Controleer " +
        "of de plugin actueel is (de spelstaat kwam er later bij dan de bank " +
        "en de inventory) en of zijn pad naar deze map wijst.",
    );
  }

  let raw: string;
  let fileModified: string;
  try {
    fileModified = (await stat(path)).mtime.toISOString();
    raw = await readFile(path, "utf8");
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    // De plugin schrijft dit bestand eens per vijf seconden en vervangt het via
    // een atomische rename. Precies daartussen lezen is hier dus waarschijnlijker
    // dan bij de bank; opnieuw proberen helpt.
    throw new PluginDataError(
      "file_unreadable",
      `"${path}" stond in de map maar is niet te lezen (${code ?? "onbekende fout"}). ` +
        "De plugin vervangt dit bestand eens per vijf seconden, dus mogelijk " +
        "werd het net verplaatst. Probeer het opnieuw.",
    );
  }

  if (raw.trim().length === 0) {
    throw new PluginDataError(
      "file_unreadable",
      `"${path}" is leeg. Waarschijnlijk is het net half weggeschreven; probeer ` +
        "het over een paar seconden opnieuw.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    throw new PluginDataError(
      "file_unreadable",
      `"${path}" is geen geldige JSON (${
        error instanceof Error ? error.message : String(error)
      }). De plugin schrijft atomisch, dus dit hoort niet voor te komen. ` +
        "Probeer het opnieuw; blijft het fout, dan is het bestand beschadigd.",
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PluginDataError(
      "file_unreadable",
      `"${path}" bevat geen spelstaat-object zoals de plugin wegschrijft. ` +
        "Mogelijk is het formaat van de plugin gewijzigd.",
    );
  }

  const record = parsed as Record<string, unknown>;
  const missingFields: string[] = [];

  const x = requiredNumber(record, "x", path);
  const y = requiredNumber(record, "y", path);
  const plane = requiredNumber(record, "plane", path);
  const regionId = requiredNumber(record, "regionId", path);

  const timestamp =
    typeof record["timestamp"] === "string" && record["timestamp"].length > 0
      ? record["timestamp"]
      : null;
  const parsedTime = timestamp === null ? NaN : Date.parse(timestamp);
  const ageSeconds = Number.isNaN(parsedTime)
    ? null
    : Math.max(0, Math.round((Date.now() - parsedTime) / 1000));
  // Ook een tijdstempel dat er wél staat maar niet te parsen is, telt als
  // ontbrekend: zonder leeftijd valt niet te zeggen of de client nog draait, en
  // dat is bij dit bestand de belangrijkste vraag.
  if (ageSeconds === null) missingFields.push("timestamp");

  const playerName =
    typeof record["playerName"] === "string" && record["playerName"].length > 0
      ? record["playerName"]
      : null;
  if (playerName === null) missingFields.push("playerName");

  // `inInstance` hoort een boolean te zijn. Is hij dat niet, dan wordt hij
  // false — maar dan telt hij wel als ontbrekend veld, want de aanname "niet in
  // een instance" is precies de aanname die de plaatsaanduiding fout maakt.
  const rawInstance = record["inInstance"];
  if (typeof rawInstance !== "boolean") missingFields.push("inInstance");
  const inInstance = rawInstance === true;

  const state: PlayerState = {
    path,
    timestamp: timestamp ?? "onbekend",
    ageSeconds,
    fileModified,
    playerName,
    world: optionalNumber(record, "world", missingFields),
    x,
    y,
    plane,
    regionId,
    inInstance,
    runEnergy: optionalNumber(record, "runEnergy", missingFields),
    hpCurrent: optionalNumber(record, "hpCurrent", missingFields),
    hpMax: optionalNumber(record, "hpMax", missingFields),
    prayerCurrent: optionalNumber(record, "prayerCurrent", missingFields),
    prayerMax: optionalNumber(record, "prayerMax", missingFields),
    combatLevel: optionalNumber(record, "combatLevel", missingFields),
    place: describePlace(x, y, plane, regionId, inInstance),
    missingFields,
  };

  return state;
};

/** Waar de tool naar wijst als er niets te lezen valt. */
export const playerStateHint = (): string =>
  `De spelstaat wordt gelezen uit ${join(dataDir(), PLAYER_STATE_FILE)} ` +
  `(map instelbaar met ${DATA_DIR_ENV}).`;
