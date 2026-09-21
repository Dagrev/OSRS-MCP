/**
 * De I/O-kant van het run-bestand: lezen, atomisch schrijven en archiveren.
 *
 * De tekstbewerking zelf staat in `run.ts` en is puur. Hier zit alles wat de map
 * aanraakt, zodat één plek verantwoordelijk is voor de vijf uitkomsten die de andere
 * tools ook kennen — map weg, geen rechten, read-only mount, onleesbaar, geschreven.
 *
 * **Het onderscheid dat dit bestand moet bewaken** (ORS-024, acceptatiecriterium 4):
 * "de datamap is onbereikbaar" en "er loopt geen run" zien er in de syscall hetzelfde
 * uit — beide geven ENOENT. Ze betekenen het tegenovergestelde. Wie ze verwart,
 * adviseert een nieuwe run te beginnen terwijl er een loopt, en schrijft die dan over
 * de lopende heen. Dezelfde bug is aan de stapcoach-kant gerepareerd in OSC-007.
 * Daarom wordt de map altijd apart gecontroleerd vóór het bestand.
 */

import { readdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  DATA_DIR_ENV,
  PluginDataError,
  dataDir,
  dataDirIsConfigured,
  inspectDataDir,
} from "./plugindata.js";
import { CURRENT_RUN_FILE, RUNS_DIR, RunFileError, archiveName, runLabel } from "./run.js";

/** Waar `runs/` staat, afgeleid van de datamap. */
export const runsDir = (): string => join(dataDir(), RUNS_DIR);

/** Het pad van de lopende run. */
export const currentRunPath = (): string => join(runsDir(), CURRENT_RUN_FILE);

export type RunWriteErrorKind = "not_writable";

export class RunWriteError extends Error {
  constructor(
    readonly kind: RunWriteErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "RunWriteError";
  }
}

/**
 * Controleert de datamap zelf. Gooit `PluginDataError` met kind `dir_unavailable`
 * als hij niet te lezen is — dat is een andere uitkomst dan een ontbrekend run-bestand
 * en mag nooit als "er loopt geen run" bij de aanroeper aankomen.
 */
export const requireDataDir = async (): Promise<void> => {
  await inspectDataDir(dataDir());
};

const hint = (dir: string): string =>
  dataDirIsConfigured()
    ? `${DATA_DIR_ENV} staat op "${dir}".`
    : `Er is geen ${DATA_DIR_ENV} gezet, dus het standaardpad "${dir}" is gebruikt.`;

/**
 * De inhoud van `runs/`, of een lege lijst als de map er nog niet is.
 *
 * Een ontbrekende `runs/`-map is geen fout: hij ontstaat bij de eerste run. De
 * datamap eromheen moet dan wél bestaan, en dat is hierboven al vastgesteld.
 */
export const listRuns = async (): Promise<string[]> => {
  try {
    return await readdir(runsDir());
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];

    const dir = runsDir();
    if (code === "EACCES" || code === "EPERM") {
      throw new PluginDataError(
        "dir_unavailable",
        `Geen leesrechten op "${dir}". ${hint(dataDir())} Of er een run loopt is dus ` +
          "niet vast te stellen — dat is iets anders dan geen run.",
      );
    }
    throw new PluginDataError(
      "dir_unavailable",
      `De map "${dir}" is niet te lezen (${code ?? "onbekende fout"}). ${hint(dataDir())} ` +
        "Bij een netwerkmount wijst dit meestal op een verbroken verbinding.",
    );
  }
};

/**
 * De lopende run, of `null` als er geen is.
 *
 * `null` betekent hier écht "de map is bereikbaar en er ligt geen run" — de datamap is
 * vóór deze aanroep gecontroleerd, dus een onbereikbare map is er al uit gefilterd als
 * fout. Dat onderscheid is de hele reden dat deze functie de map niet zelf overslaat.
 */
export const readCurrentRun = async (): Promise<string | null> => {
  await requireDataDir();

  const path = currentRunPath();
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "EACCES" || code === "EPERM") {
      throw new PluginDataError(
        "dir_unavailable",
        `Geen leesrechten op "${path}". ${hint(dataDir())} Er staat mogelijk wél een run; ` +
          "dit is geen reden om een nieuwe te beginnen.",
      );
    }
    throw new PluginDataError(
      "file_unreadable",
      `"${path}" is niet te lezen (${code ?? "onbekende fout"}). ${hint(dataDir())}`,
    );
  }

  if (raw.trim().length === 0) {
    throw new PluginDataError(
      "file_unreadable",
      `"${path}" bestaat maar is leeg. Dat is geen lopende run en ook geen lege map — ` +
        "waarschijnlijk is een schrijfactie halverwege afgebroken. Corrigeer het bestand " +
        "met de hand of archiveer het; er wordt hier niets overheen geschreven.",
    );
  }

  return raw;
};

/**
 * Schrijft de run atomisch: tijdelijk bestand in dezelfde map, dan hernoemen.
 *
 * Dezelfde route als `writeStep` en om dezelfde reden: een lezer aan de andere kant
 * van de keten (NFS naar SMB) mag nooit een half bestand zien.
 */
export const writeCurrentRun = async (text: string): Promise<string> => {
  const target = currentRunPath();
  const temporary = `${target}.tmp`;

  try {
    await writeFile(temporary, text, "utf8");
    await rename(temporary, target);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    const dir = runsDir();

    if (code === "EROFS") {
      throw new RunWriteError(
        "not_writable",
        `"${dir}" is read-only (${code}). Sinds ORS-016 hoort het \`/data\`-volume in ` +
          "`docker-compose.yml` zonder `:ro` te staan; is dat teruggedraaid, dan kan deze " +
          "tool niets vastleggen. Er is niets geschreven.",
      );
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new RunWriteError(
        "not_writable",
        `Geen schrijfrechten op "${dir}" (${code}). ${hint(dataDir())} Let op dat een lezer ` +
          "die het bestand open houdt op een SMB-share dezelfde fout oplevert — dat is in " +
          "ORS-013 en ORS-015 gemeten. Er is niets geschreven.",
      );
    }

    throw new RunWriteError(
      "not_writable",
      `Kon de run niet wegschrijven naar "${dir}" (${code ?? "onbekende fout"}). ` +
        `${hint(dataDir())} Bij een netwerkmount wijst dit meestal op een verbroken ` +
        "verbinding. Er is niets geschreven.",
    );
  }

  return target;
};

/**
 * Hernoemt `current-run.md` naar `YYYY-MM-DD doel.md`.
 *
 * Een rename en geen verwijdering: er verdwijnt niets, ook niet als de naam al bestaat
 * — dan komt er ` (2)` achter. Dat is bewust, want een run bevat het enige verslag van
 * wat er die avond gebeurd is.
 */
export const archiveCurrentRun = async (options: {
  goal: string;
  date: string;
}): Promise<string> => {
  const taken = await listRuns();
  const name = archiveName({
    date: options.date,
    label: runLabel(options.goal),
    taken,
  });
  const target = join(runsDir(), name);

  try {
    await rename(currentRunPath(), target);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new RunWriteError(
      "not_writable",
      `Kon de run niet archiveren naar "${target}" (${code ?? "onbekende fout"}). ` +
        `${hint(dataDir())} \`current-run.md\` staat er nog onveranderd; er is niets kwijt.`,
    );
  }

  return name;
};

/**
 * Gooit de lopende run weg in plaats van hem te archiveren.
 *
 * Contract paragraaf 7: afronden archiveert, weggooien kan alleen als uitgesproken
 * keuze op het moment van afronden. Deze functie raakt daarom uitsluitend
 * `current-run.md` — een bestand dat al gearchiveerd is, is voor de tools onaanraakbaar,
 * en er is geen opruimregel op leeftijd of aantal. "Niet meer nodig" is niets om te
 * gokken; dat weet alleen wie de run afsluit.
 */
export const discardCurrentRun = async (): Promise<string> => {
  const target = currentRunPath();
  try {
    await unlink(target);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new RunWriteError(
      "not_writable",
      `Kon de lopende run niet weggooien ("${target}", ${code ?? "onbekende fout"}). ` +
        `${hint(dataDir())} Het bestand staat er nog; er is niets kwijt.`,
    );
  }
  return target;
};

/** Ruimt een blijven staan tijdelijk bestand op. Faalt nooit hard — het is opruimwerk. */
export const discardTemporary = async (): Promise<void> => {
  try {
    await unlink(`${currentRunPath()}.tmp`);
  } catch {
    // Er was niets op te ruimen, of het mocht niet. Beide zijn hier geen probleem.
  }
};

export { PluginDataError, RunFileError };
