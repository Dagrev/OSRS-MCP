/**
 * Welke bron gelijk heeft als er twee zijn.
 *
 * Sinds ORS-019 en ORS-020 weten twee bronnen hetzelfde over levels en quests: de
 * plugin-snapshot op de gedeelde map, en de publieke bronnen (hiscores, WikiSync). Ze zijn
 * het geregeld oneens — de hiscores verversen niet real-time, en WikiSync verstuurt alleen
 * bij het inloggen. Zonder expliciete keuze bepaalt de volgorde in de code welk antwoord er
 * uitkomt, en dat is precies het soort stille fout dat dit project elders heeft uitgebannen.
 *
 * De regel, in drie zinnen:
 *
 * 1. Gaat de vraag over de speler zelf en is de snapshot vers, dan wint de snapshot. Die
 *    komt rechtstreeks uit de draaiende client en kan per definitie niet achterlopen.
 * 2. In alle andere gevallen wint de publieke bron. Een andere accountnaam, een client die
 *    uit staat, een mount die weg is: dan is de snapshot er niet of zegt hij niets over de
 *    gevraagde speler.
 * 3. De publieke bron verdwijnt nooit helemaal. Hij weet dingen die de plugin niet weet —
 *    de rank in de hiscores, en de diaries, combat achievements en muziek in WikiSync — en
 *    hij is de enige weg naar de gegevens van een groepslid.
 *
 * Wat deze module níét doet is samenvoegen. Waar beide bronnen hetzelfde veld kennen wint er
 * één, en als ze het oneens zijn wordt dat gemeld. Een antwoord dat per skill een andere
 * bron gebruikt is niet uit te leggen en niet te controleren.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { dataDir } from "./plugindata.js";

export const SKILLS_FILE = "skills.json";
export const QUESTS_FILE = "quests.json";
export const PLAYER_STATE_FILE = "player-state.json";

/**
 * Hoe vers een snapshot moet zijn om voorrang te krijgen. Eén grens voor alle tools.
 *
 * Honderdtwintig seconden, en dat getal komt niet van het XP-bestand zelf. Dat is de
 * valkuil: XP en queststatus veranderen alleen als de speler iets doet, dus "al een uur
 * geen XP" is een volstrekt normale toestand tijdens een lange quest — daar kun je geen
 * versheid aan afmeten. Wat wél meet of de client leeft is de hartslag: `player-state.json`
 * en `skills.json` schrijven allebei elke zestig seconden, ook als er niets gebeurt. Twee
 * hartslagen is dus de grens waarboven de client aantoonbaar niet meer draait, en dat is
 * dezelfde grens die het Stapcontract in §5 hanteert.
 *
 * Merk op dat `playerstate.ts` voor `get_player_state` 150 seconden aanhoudt. Dat is geen
 * tegenspraak maar een andere vraag: daar gaat het om hoe een leeftijd aan de gebruiker
 * beschreven wordt, met marge voor één mislukte schrijfreeks. Hier gaat het om een keuze
 * tussen twee bronnen, en dan is de strengere grens de juiste — bij twijfel de bron
 * gebruiken die hoe dan ook een antwoord geeft.
 */
export const SNAPSHOT_MAX_AGE_SECONDS = 120;

/** Waar een antwoord vandaan kwam, en waarom. */
export interface SourceChoice {
  /** `snapshot` = de draaiende client, `public` = hiscores of WikiSync. */
  use: "snapshot" | "public";
  /** Eén zin voor in de uitvoer: waarom deze bron en niet de andere. */
  reason: string;
  /** Leeftijd van de snapshot in seconden, als die er was. */
  snapshotAgeSeconds: number | null;
}

export interface SkillsSnapshot {
  timestamp: string;
  ageSeconds: number;
  /** Sleutel is de skillnaam in hoofdletters, zoals het contract voorschrijft. */
  skills: Record<string, { level: number; xp: number; boostedLevel?: number }>;
}

export interface QuestsSnapshot {
  timestamp: string;
  ageSeconds: number;
  /** Sleutel is de `Quest`-enumconstante, waarde `NOT_STARTED`/`IN_PROGRESS`/`FINISHED`. */
  quests: Record<string, string>;
}

const filePath = (name: string): string => join(dataDir(), name);

/**
 * JSON uit de gedeelde map, of null.
 *
 * Elke storing wordt hier tot null teruggebracht, en dat is precies goed andersom dan in
 * `plugindata.ts`. Daar is een onleesbaar bestand een fout, omdat er geen alternatief is en
 * "leeg" een verkeerd antwoord zou zijn. Hier is er wél een alternatief: kan de snapshot
 * niet gelezen worden, dan valt de tool terug op de publieke bron en krijgt de gebruiker
 * gewoon antwoord, met de bron erbij.
 */
const readJson = async (path: string): Promise<Record<string, unknown> | null> => {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
};

/** Leeftijd in seconden uit een ISO-tijdstempel, of null als het onleesbaar is. */
const ageOf = (record: Record<string, unknown>): number | null => {
  const timestamp = record["timestamp"];
  if (typeof timestamp !== "string") return null;
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, Math.round((Date.now() - parsed) / 1000));
};

/**
 * Accountnamen vergelijken zoals OSRS ze behandelt.
 *
 * In het spel zijn een spatie en een underscore inwisselbaar en telt hoofdlettergebruik
 * niet. `Mr Bilel`, `mr_bilel` en `MR BILEL` zijn hetzelfde account, en wie dat verschil
 * laat meetellen krijgt stilzwijgend de publieke bron voor zijn eigen account.
 */
const sameAccount = (a: string, b: string): boolean =>
  a.trim().toLowerCase().replace(/_/g, " ") === b.trim().toLowerCase().replace(/_/g, " ");

/** De naam van de speler in de draaiende client, of null. */
export const localPlayerName = async (): Promise<string | null> => {
  const state = await readJson(filePath(PLAYER_STATE_FILE));
  const name = state?.["playerName"];
  return typeof name === "string" && name.length > 0 ? name : null;
};

export const readSkillsSnapshot = async (): Promise<SkillsSnapshot | null> => {
  const raw = await readJson(filePath(SKILLS_FILE));
  if (raw === null) return null;

  const age = ageOf(raw);
  const skills = raw["skills"];
  if (age === null || typeof skills !== "object" || skills === null || Array.isArray(skills)) {
    return null;
  }

  const out: SkillsSnapshot["skills"] = {};
  for (const [name, value] of Object.entries(skills as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const level = entry["level"];
    const xp = entry["xp"];
    if (typeof level !== "number" || typeof xp !== "number") continue;
    out[name] = {
      level,
      xp,
      ...(typeof entry["boostedLevel"] === "number"
        ? { boostedLevel: entry["boostedLevel"] }
        : {}),
    };
  }

  if (Object.keys(out).length === 0) return null;
  return { timestamp: String(raw["timestamp"]), ageSeconds: age, skills: out };
};

export const readQuestsSnapshot = async (): Promise<QuestsSnapshot | null> => {
  const raw = await readJson(filePath(QUESTS_FILE));
  if (raw === null) return null;

  const age = ageOf(raw);
  const quests = raw["quests"];
  if (age === null || typeof quests !== "object" || quests === null || Array.isArray(quests)) {
    return null;
  }

  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(quests as Record<string, unknown>)) {
    if (typeof value === "string") out[name] = value;
  }

  if (Object.keys(out).length === 0) return null;
  return { timestamp: String(raw["timestamp"]), ageSeconds: age, quests: out };
};

/**
 * Beslist welke bron voorrang heeft voor deze vraag.
 *
 * De drie afwijzingsgronden staan expres uit elkaar: "dit is een ander account" is iets
 * heel anders dan "de client staat uit", en de gebruiker die zich afvraagt waarom hij oude
 * hiscore-data ziet heeft aan één woord niet genoeg.
 */
export const chooseSource = async (
  username: string,
  snapshotAgeSeconds: number | null,
): Promise<SourceChoice> => {
  const local = await localPlayerName();

  if (local === null) {
    return {
      use: "public",
      reason:
        "De publieke bron, want er is geen spelstaat op de gedeelde map — de client draait " +
        "niet, of de datamap is niet bereikbaar.",
      snapshotAgeSeconds,
    };
  }

  if (!sameAccount(local, username)) {
    return {
      use: "public",
      reason:
        `De publieke bron, want de vraag gaat over "${username}" en de client is ingelogd ` +
        `als "${local}". Over een ander account weet de plugin niets.`,
      snapshotAgeSeconds,
    };
  }

  if (snapshotAgeSeconds === null) {
    return {
      use: "public",
      reason:
        "De publieke bron, want de plugin heeft hier nog geen snapshot van weggeschreven " +
        "of hij was niet te lezen.",
      snapshotAgeSeconds,
    };
  }

  if (snapshotAgeSeconds > SNAPSHOT_MAX_AGE_SECONDS) {
    return {
      use: "public",
      reason:
        `De publieke bron, want de snapshot is ${snapshotAgeSeconds} seconden oud en de ` +
        `grens ligt op ${SNAPSHOT_MAX_AGE_SECONDS}. Zo oud betekent dat de client niet meer ` +
        "draait; de hartslag schrijft namelijk ook als er niets verandert.",
      snapshotAgeSeconds,
    };
  }

  return {
    use: "snapshot",
    reason:
      `De plugin-snapshot van ${snapshotAgeSeconds} seconden oud, rechtstreeks uit de ` +
      "draaiende client. Die kan niet achterlopen op het spel; de publieke bronnen wel.",
    snapshotAgeSeconds,
  };
};

/**
 * De enumconstante die bij een weergavenaam hoort.
 *
 * WikiSync geeft `Cook's Assistant`, de plugin schrijft `COOKS_ASSISTANT`. Om die twee
 * naast elkaar te kunnen leggen moet er één kant omgerekend worden, en de weergavenaam is
 * de kant die informatie verliest (leestekens verdwijnen) in plaats van erbij verzint.
 *
 * Dit is een heuristiek en geen afspraak — het contract legt alleen de enumconstante vast.
 * Namen die er niet op passen worden daarom niet geraden maar overgeslagen, en de tool
 * meldt hoeveel dat er waren.
 */
export const questKey = (displayName: string): string =>
  displayName
    .trim()
    .toUpperCase()
    // Eerst alles weg wat geen letter, cijfer of spatie is, en pas daarná spaties naar
    // underscores — in die volgorde, en zonder reeksen samen te vouwen. Dat laatste is
    // geen detail: de enum houdt de spaties rond een weggevallen teken alle twee aan, dus
    // "Recipe for Disaster - Evil Dave" wordt RECIPE_FOR_DISASTER__EVIL_DAVE met twee
    // underscores, en "Romeo & Juliet" wordt ROMEO__JULIET. Een regex die `[^A-Z0-9]+`
    // in één keer op `_` zet, maakt daar één underscore van en koppelt dertien quests
    // niet meer — gemeten tegen de echte WikiSync-respons.
    .replace(/[^A-Z0-9 ]/g, "")
    .replace(/ /g, "_")
    .replace(/^_+|_+$/g, "");

/**
 * Een enumconstante terug naar iets leesbaars, als laatste redmiddel.
 *
 * Alleen gebruikt als de snapshot een quest kent die WikiSync niet teruggaf — dan is er
 * geen weergavenaam om te tonen. De apostrof komt niet terug; `COOKS_ASSISTANT` wordt
 * `Cooks Assistant`. Dat is lelijk maar eerlijk, en beter dan een apostrof op de gok.
 */
export const prettifyQuestKey = (key: string): string =>
  key
    .toLowerCase()
    .split("_")
    .map((word) => (word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1)))
    .join(" ");
