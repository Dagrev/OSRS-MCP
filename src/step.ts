/**
 * De actieve stap: `current-step.json` op de gedeelde map.
 *
 * Dit is de tweede schrijfrichting van deze server, na het commandokanaal in
 * `destination.ts`. De overeenkomst is het atomaire schrijven; het verschil is dat er
 * hier **niet op een antwoord gewacht wordt**.
 *
 * Dat is een bewuste keuze en geen bezuiniging. `set_destination` wacht op
 * `command-ack.json` omdat een `PluginMessage` aan een plugin die niet draait spoorloos
 * verdwijnt — dan zou "bestemming gezet" een gok zijn die er als een feit uitziet. Hier
 * ligt dat anders: `current-step.json` is een bestand dat blijft staan, en de lezers
 * (de overlay uit ORS-022, het wachtscript uit OSC-003) pakken het op wanneer ze er
 * zijn. Er valt dus niets te bevestigen. Een ack-lus zou hier alleen kosten hebben: de
 * schrijfrichting server → plugin is de trage kant (NFS schrijven, SMB lezen), dus elke
 * stap zou seconden wachten op een bevestiging die niets toevoegt.
 *
 * Het volgnummer is wat een verse stap van een oude onderscheidt. Zelfde patroon als
 * `command.json`: lezen, optellen, schrijven. Staat het bestand er niet of is het stuk,
 * dan begint hij bij 1 — een lezer ziet dan een lager nummer dan hij kende en weet dat
 * er iets opnieuw begonnen is.
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Condition } from "./condition.js";
import { DATA_DIR_ENV, PluginDataError, dataDir, inspectDataDir } from "./plugindata.js";

/** Zoals het contract hem noemt; de plugin en het wachtscript lezen dezelfde naam. */
export const CURRENT_STEP_FILE = "current-step.json";

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

/** Precies de velden uit §2 van het contract, in die volgorde. */
export interface StepFile {
  seq: number;
  issuedAt: string;
  instruction: string | null;
  note: string | null;
  timeoutSeconds: number | null;
  condition: Condition | null;
}

/**
 * Er gaat iets mis bij het schrijven van de stap.
 *
 * Apart van `PluginDataError` om dezelfde reden als `CommandChannelError`: daar is de
 * bron onleesbaar, hier is de bestemming onbeschrijfbaar.
 */
export class StepWriteError extends Error {
  constructor(
    readonly kind: "not_writable" | "unreadable",
    message: string,
  ) {
    super(message);
    this.name = "StepWriteError";
  }
}

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
 * Het volgende volgnummer.
 *
 * Een onleesbaar of ontbrekend bestand is hier expres geen fout. Het contract zegt het
 * met zoveel woorden: dan begint hij bij 1. Weigeren zou betekenen dat één beschadigd
 * bestand op de share de hele coach blokkeert, terwijl de eerstvolgende schrijfactie
 * het vanzelf repareert.
 */
export const nextStepSeq = async (): Promise<number> => {
  const current = await readJson(filePath(CURRENT_STEP_FILE));
  return (numberOrNull(current?.["seq"]) ?? 0) + 1;
};

/** De vorige stap, voor zover leesbaar — voor de samenvatting in het antwoord. */
export const readCurrentStep = async (): Promise<StepFile | null> => {
  const raw = await readJson(filePath(CURRENT_STEP_FILE));
  if (raw === null) return null;

  const seq = numberOrNull(raw["seq"]);
  if (seq === null) return null;

  return {
    seq,
    issuedAt: typeof raw["issuedAt"] === "string" ? raw["issuedAt"] : "onbekend",
    instruction: typeof raw["instruction"] === "string" ? raw["instruction"] : null,
    note: typeof raw["note"] === "string" ? raw["note"] : null,
    timeoutSeconds: numberOrNull(raw["timeoutSeconds"]),
    condition: (raw["condition"] ?? null) as Condition | null,
  };
};

/**
 * De XP-stand van een skill uit `skills.json`, als die vers genoeg is.
 *
 * Gooit in plaats van null terug te geven omdat elke manier waarop dit misgaat een
 * eigen uitleg verdient: het bestand bestaat nog niet (ORS-019 is er nog niet door),
 * het is oud (client staat uit), of de skill staat er niet in. Alle drie leiden tot
 * dezelfde uitkomst — de stap wordt niet geschreven — maar niet tot dezelfde actie.
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

/**
 * Schrijft de stap atomisch: tijdelijk bestand, dan hernoemen.
 *
 * Dezelfde vijf uitkomsten als de bestaande tools — map weg, geen rechten, read-only
 * mount, onleesbaar en geschreven — omdat een lezer aan de andere kant van deze keten
 * (NFS naar SMB, over de NAS) alleen aan de foutmelding kan zien waar het vastzit.
 */
export const writeStep = async (step: StepFile): Promise<string> => {
  const target = filePath(CURRENT_STEP_FILE);
  const temporary = `${target}.tmp`;

  try {
    await writeFile(temporary, `${JSON.stringify(step, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    const dir = dataDir();

    if (code === "EROFS") {
      throw new StepWriteError(
        "not_writable",
        `De datamap "${dir}" is read-only (${code}). Sinds ORS-016 hoort het \`/data\`-volume ` +
          "in `docker-compose.yml` zonder `:ro` te staan; is dat teruggedraaid, dan kan " +
          "deze tool niets neerzetten. De stap is niet geschreven en de speler ziet niets.",
      );
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new StepWriteError(
        "not_writable",
        `Geen schrijfrechten op de datamap "${dir}" (${code}). ${DATA_DIR_ENV} wijst daarheen. ` +
          "Let op dat een lezer die het bestand open houdt op een SMB-share dezelfde fout " +
          "oplevert — dat is in ORS-013 en ORS-015 gemeten. De stap is niet geschreven.",
      );
    }

    throw new StepWriteError(
      "not_writable",
      `Kon de stap niet wegschrijven naar "${dir}" (${code ?? "onbekende fout"}). ` +
        `${DATA_DIR_ENV} wijst daarheen. Bij een netwerkmount wijst dit meestal op een ` +
        "verbroken verbinding. De stap is niet geschreven.",
    );
  }

  return target;
};

/** De bestanden die de plugin wegschrijft; hun aanwezigheid bewijst dat de mount haakt. */
const PLUGIN_FILES = [
  "player-state.json",
  "inventory.json",
  "bank.json",
  "equipment.json",
  SKILLS_FILE,
];

/**
 * Controleert de datamap vóór er iets geschreven wordt, en meldt of de plugin daar ooit
 * geweest is.
 *
 * Dat tweede is geen weigering, en dat is een bewuste grens. Een lezer die een lege map
 * aantreft móet weigeren — anders wordt "mount niet aangehaakt" gepresenteerd als "je
 * bank is leeg". Een schrijver heeft dat probleem niet: hij kan gewoon schrijven. Maar
 * hij kan wél in een lege map schrijven die niemand leest, want een mislukte CIFS-mount
 * laat precies zo'n lege map achter. Vandaar de waarschuwing: schrijven gebeurt, en er
 * staat bij dat er verder niets van de plugin in die map ligt.
 *
 * `set_destination` doet hier hetzelfde, en het ticket noemt "map leeg" niet bij de vijf
 * uitkomsten die deze tool moet kennen.
 */
export const checkDataDir = async (): Promise<{ pluginFilesPresent: boolean }> => {
  const entries = await inspectDataDir(dataDir());
  return { pluginFilesPresent: PLUGIN_FILES.some((file) => entries.includes(file)) };
};

export { PluginDataError };
