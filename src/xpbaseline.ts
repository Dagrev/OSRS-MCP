/**
 * De XP-basis voor een relatief XP-doel (`xpGain`), uit `skills.json`.
 *
 * Dit stond tot ORS-029 in `step.ts`, naast het schrijven van `current-step.json`. Die
 * schrijfkant is met versie 1 verdwenen; deze omrekening niet — `create_task` heeft haar
 * nog steeds nodig voor een stap met een relatief XP-doel (contract §3.3). Vandaar een
 * eigen, neutrale module in plaats van deze functie in `step.ts` te laten hangen naast
 * code die verder alleen nog dood gewicht was, of haar in `taskfile.ts` te dupliceren.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { dataDir } from "./plugindata.js";

/** Geschreven door de plugin (ORS-019). Alleen nodig voor een relatief XP-doel. */
export const SKILLS_FILE = "skills.json";

/**
 * Hoe oud `skills.json` hoogstens mag zijn om als XP-basis te dienen.
 *
 * Honderdtwintig seconden, dezelfde grens die het contract voor versheid hanteert en
 * het dubbele van de hartslag. Een basis uit een dode client is erger dan geen basis:
 * de stand van een half uur geleden levert een drempel op die de speler allang gehaald
 * heeft (dan is de stap meteen "klaar" zonder dat er iets gebeurd is) of juist een die
 * er nooit komt.
 */
export const XP_BASELINE_MAX_AGE_SECONDS = 120;

/** De conditie deugt, maar de XP-basis om hem mee om te rekenen ontbreekt. */
export class XpBaselineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XpBaselineError";
  }
}

const filePath = (name: string): string => join(dataDir(), name);

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

const numberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * De XP-stand van een skill uit `skills.json`, als die vers genoeg is.
 *
 * Gooit in plaats van null terug te geven omdat elke manier waarop dit misgaat een
 * eigen uitleg verdient: het bestand bestaat nog niet (ORS-019 is er nog niet door),
 * het is oud (client staat uit), of de skill staat er niet in. Alle drie leiden tot
 * dezelfde uitkomst — de taak wordt niet geschreven — maar niet tot dezelfde actie.
 */
export const xpBaseline = async (skill: string): Promise<{ xp: number; at: string }> => {
  const path = filePath(SKILLS_FILE);
  const raw = await readJson(path);

  if (raw === null) {
    throw new XpBaselineError(
      `Een relatief XP-doel heeft de huidige stand nodig, en die staat in "${path}" — ` +
        "dat bestand is er niet of is niet te lezen. De plugin schrijft het sinds " +
        "ORS-019; draait daar nog een oudere versie, dan komt het er niet. Geef " +
        "zolang een absolute drempel met `minXp`, of gebruik een andere conditie.",
    );
  }

  const timestamp = typeof raw["timestamp"] === "string" ? raw["timestamp"] : null;
  const parsed = timestamp === null ? NaN : Date.parse(timestamp);
  if (Number.isNaN(parsed)) {
    throw new XpBaselineError(
      `"${path}" heeft geen leesbaar tijdstempel, dus er is niet vast te stellen of de ` +
        "XP-stand van nu is. Er is niets geschreven.",
    );
  }

  const ageSeconds = Math.round((Date.now() - parsed) / 1000);
  if (ageSeconds > XP_BASELINE_MAX_AGE_SECONDS) {
    throw new XpBaselineError(
      `De XP-stand in "${path}" is ${ageSeconds} seconden oud en mag hoogstens ` +
        `${XP_BASELINE_MAX_AGE_SECONDS} seconden oud zijn. Zo oud betekent dat de client ` +
        "niet meer draait, en een drempel op die stand is óf allang gehaald óf komt er " +
        "nooit. Start de client, of geef een absolute drempel met `minXp`.",
    );
  }

  const skills = raw["skills"];
  if (typeof skills !== "object" || skills === null || Array.isArray(skills)) {
    throw new XpBaselineError(
      `"${path}" heeft geen skills-object zoals het contract beschrijft. Mogelijk lopen ` +
        "de plugin en deze server uit de pas qua versie. Er is niets geschreven.",
    );
  }

  const entry = (skills as Record<string, unknown>)[skill];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new XpBaselineError(
      `${skill} staat niet in "${path}". De plugin schrijft alle 23 skills weg, dus dit ` +
        "wijst op een ouder formaat. Er is niets geschreven.",
    );
  }

  const xp = numberOrNull((entry as Record<string, unknown>)["xp"]);
  if (xp === null) {
    throw new XpBaselineError(
      `${skill} heeft geen leesbare \`xp\` in "${path}". Er is niets geschreven.`,
    );
  }

  return { xp, at: timestamp! };
};
