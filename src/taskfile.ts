/**
 * De I/O-kant van taken: `tasks/<id>.json` lezen en schrijven, `tasks/<id>.progress.json`
 * hoogstens lezen (paragraaf 8 en 9 van het Stapcontract).
 *
 * Naar het voorbeeld van `runfile.ts`: atomisch schrijven, en het onderscheid tussen
 * "de datamap is onbereikbaar" en "er is niets" nooit door elkaar halen. Bij taken is
 * dat tweede net iets anders dan bij het run-bestand: `tasks/` bestaat pas na de eerste
 * `create_task`, en dat is normaal — anders dan `runs/`, dat op de share al staat
 * voordat er ooit een taak was, hoeft niemand deze map vooraf aan te maken. Daarom
 * maakt `writeTaskDefinition` de map zelf aan als hij ontbreekt; `writeCurrentRun` doet
 * dat bewust niet (zie `runfile.ts`), maar daar was de map altijd al gezet.
 *
 * **Eén schrijver per bestand (contract §8/§9).** Deze module schrijft alleen de
 * definitie. Het voortgangsbestand wordt uitsluitend door de plugin geschreven; hier
 * wordt het hoogstens gelezen.
 */

import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  DATA_DIR_ENV,
  PluginDataError,
  dataDir,
  dataDirIsConfigured,
  inspectDataDir,
} from "./plugindata.js";

export const TASKS_DIR = "tasks";
export const DEFINITION_SUFFIX = ".json";
export const PROGRESS_SUFFIX = ".progress.json";

export const tasksDir = (): string => join(dataDir(), TASKS_DIR);
export const taskDefinitionPath = (id: string): string => join(tasksDir(), `${id}${DEFINITION_SUFFIX}`);
export const taskProgressPath = (id: string): string => join(tasksDir(), `${id}${PROGRESS_SUFFIX}`);

export type TaskWriteErrorKind = "not_writable";

export class TaskWriteError extends Error {
  constructor(
    readonly kind: TaskWriteErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "TaskWriteError";
  }
}

const hint = (dir: string): string =>
  dataDirIsConfigured()
    ? `${DATA_DIR_ENV} staat op "${dir}".`
    : `Er is geen ${DATA_DIR_ENV} gezet, dus het standaardpad "${dir}" is gebruikt.`;

/** Controleert alleen de datamap zelf — dezelfde eerste stap als bij het run-bestand. */
export const requireDataDir = async (): Promise<void> => {
  await inspectDataDir(dataDir());
};

/**
 * Alle taak-id's in `tasks/`, uit de bestandsnamen van de definities.
 *
 * Een ontbrekende `tasks/`-map is geen fout: hij ontstaat bij de eerste `create_task`.
 * De datamap eromheen moet dan wél bereikbaar zijn, en dat is hierboven al vastgesteld
 * — zo blijft "geen taken" onderscheiden van "map onbereikbaar", precies de eis uit het
 * ticket.
 */
export const listTaskIds = async (): Promise<string[]> => {
  await requireDataDir();

  let entries: string[];
  try {
    entries = await readdir(tasksDir());
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];

    const dir = tasksDir();
    if (code === "EACCES" || code === "EPERM") {
      throw new PluginDataError(
        "dir_unavailable",
        `Geen leesrechten op "${dir}". ${hint(dataDir())} Of er taken zijn, is dus niet ` +
          "vast te stellen — dat is iets anders dan geen taken.",
      );
    }
    throw new PluginDataError(
      "dir_unavailable",
      `De map "${dir}" is niet te lezen (${code ?? "onbekende fout"}). ${hint(dataDir())} ` +
        "Bij een netwerkmount wijst dit meestal op een verbroken verbinding.",
    );
  }

  return entries
    .filter((name) => name.endsWith(DEFINITION_SUFFIX) && !name.endsWith(PROGRESS_SUFFIX))
    .map((name) => name.slice(0, -DEFINITION_SUFFIX.length));
};

const readJsonFile = async (
  path: string,
  what: string,
): Promise<Record<string, unknown> | null> => {
  await requireDataDir();

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "EACCES" || code === "EPERM") {
      throw new PluginDataError(
        "dir_unavailable",
        `Geen leesrechten op "${path}". ${hint(dataDir())} Er staat mogelijk wél ${what}; ` +
          "dit is geen reden om aan te nemen dat die er niet is.",
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
      `"${path}" bestaat maar is leeg. Waarschijnlijk is een schrijfactie halverwege ` +
        "afgebroken. Er wordt hier niets overheen geschreven.",
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
      }). Schrijven gaat atomisch, dus dit hoort niet voor te komen.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PluginDataError(
      "file_unreadable",
      `"${path}" bevat geen object zoals het contract beschrijft.`,
    );
  }
  return parsed as Record<string, unknown>;
};

/** De ruwe taakdefinitie, of `null` als de taak niet bestaat. */
export const readTaskDefinitionRaw = async (id: string): Promise<Record<string, unknown> | null> =>
  readJsonFile(taskDefinitionPath(id), "een taakdefinitie");

/**
 * De ruwe voortgang, of `null` als de taak nog nooit door de plugin opgepakt is —
 * contract §9: "een taak die net is aangemaakt heeft nog geen voortgangsbestand".
 * Bestaat het bestand wél maar is het niet te lezen, dan is dát een fout: dat
 * onderscheid is precies waar het ticket om vraagt bij `get_task`.
 */
export const readTaskProgressRaw = async (
  id: string,
): Promise<{ data: Record<string, unknown>; fileModified: string } | null> => {
  await requireDataDir();
  const path = taskProgressPath(id);

  let fileModified: string;
  try {
    fileModified = (await stat(path)).mtime.toISOString();
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw new PluginDataError(
      "file_unreadable",
      `"${path}" is niet te benaderen (${code ?? "onbekende fout"}). ${hint(dataDir())}`,
    );
  }

  const data = await readJsonFile(path, "voortgang");
  if (data === null) return null; // race met de plugin die het net verwijderde/verplaatste
  return { data, fileModified };
};

/**
 * Schrijft de taakdefinitie atomisch. Maakt `tasks/` aan als die er nog niet is —
 * zie de uitleg bovenaan dit bestand voor waarom dat hier wél gebeurt en bij het
 * run-bestand niet.
 */
export const writeTaskDefinition = async (id: string, data: unknown): Promise<string> => {
  const dir = tasksDir();
  const target = taskDefinitionPath(id);
  const temporary = `${target}.tmp`;

  try {
    await mkdir(dir, { recursive: true });
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === "EROFS") {
      throw new TaskWriteError(
        "not_writable",
        `"${dir}" is read-only (${code}). Het \`/data\`-volume moet zonder \`:ro\` staan. ` +
          "Er is niets geschreven.",
      );
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new TaskWriteError(
        "not_writable",
        `Geen schrijfrechten op "${dir}" (${code}). ${hint(dataDir())} Er is niets geschreven.`,
      );
    }
    throw new TaskWriteError(
      "not_writable",
      `Kon de taak niet wegschrijven naar "${dir}" (${code ?? "onbekende fout"}). ` +
        `${hint(dataDir())} Bij een netwerkmount wijst dit meestal op een verbroken ` +
        "verbinding. Er is niets geschreven.",
    );
  }

  return target;
};

/**
 * Verwijdert definitie en voortgang. Het ontbreken van de voortgang is normaal (de
 * taak is dan nooit opgepakt) en wordt niet als fout behandeld; het ontbreken van de
 * definitie zelf hoort de aanroeper al met `readTaskDefinitionRaw` te hebben
 * vastgesteld, maar deze functie valt niet om als dat toch zo blijkt.
 */
export const deleteTask = async (id: string): Promise<{ progressExisted: boolean }> => {
  const definitionPath = taskDefinitionPath(id);
  const progressPath = taskProgressPath(id);

  const unlinkIgnoringMissing = async (path: string): Promise<boolean> => {
    try {
      await unlink(path);
      return true;
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return false;
      throw new TaskWriteError(
        "not_writable",
        `Kon "${path}" niet verwijderen (${code ?? "onbekende fout"}). ${hint(dataDir())}`,
      );
    }
  };

  await unlinkIgnoringMissing(definitionPath);
  const progressExisted = await unlinkIgnoringMissing(progressPath);
  return { progressExisted };
};

export { PluginDataError };
