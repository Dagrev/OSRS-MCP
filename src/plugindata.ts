/**
 * Lokale plugindata — bank en inventory uit de RuneLite-plugin.
 *
 * De plugin "OSRS Item Check" (repo `/home/damian/code/osrs/OSRS item check`)
 * schrijft bij elke containerwijziging een JSON-snapshot weg. Deze module leest
 * die bestanden; hij schrijft nooit.
 *
 * Het belangrijkste onderscheid in dit bestand is dat tussen "leeg" en
 * "onbekend". Een lege lijst teruggeven bij een storing laat Claude
 * concluderen dat de speler niets heeft — een fout antwoord op een technisch
 * probleem. Daarom heeft elke manier waarop het mis kan gaan zijn eigen
 * `PluginDataErrorKind` met een eigen uitleg.
 *
 * Er zit bewust GEEN cache op. De hele waarde van deze bron is dat hij de
 * stand van nu weergeeft; een lokale of gemounte bestandslezing is goedkoop
 * genoeg om elke keer te doen.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Welke container er opgevraagd wordt; tegelijk de bestandsnaam. */
/**
 * Naast de containers hieronder schrijft de plugin `player-state.json` in
 * dezelfde map. Dat is geen container maar één snapshotobject, dus het heeft
 * zijn eigen module: `playerstate.ts`.
 */
export const CONTAINERS = {
  inventory: { file: "inventory.json", label: "inventory" },
  bank: { file: "bank.json", label: "bank" },
} as const;

export type ContainerKind = keyof typeof CONTAINERS;

/**
 * De environment-variabele waarmee de datamap wordt gezet. In de container is
 * dat de NAS-mount (ORS-012), op de desktop de map waar de plugin standaard
 * schrijft.
 */
export const DATA_DIR_ENV = "OSRS_MCP_DATA_DIR";

/**
 * Standaardpad: waar `ItemCheckConfig` ook standaard naartoe schrijft. Draait
 * de server op dezelfde machine als RuneLite, dan werkt het zonder configuratie.
 */
const defaultDataDir = (): string => join(homedir(), ".runelite", "osrs-item-check");

export const dataDir = (): string => {
  const configured = process.env[DATA_DIR_ENV]?.trim();
  return configured && configured.length > 0 ? configured : defaultDataDir();
};

/** Of de map uit de env-variabele komt — relevant voor de foutmelding. */
export const dataDirIsConfigured = (): boolean => {
  const configured = process.env[DATA_DIR_ENV]?.trim();
  return configured !== undefined && configured.length > 0;
};

export type PluginDataErrorKind =
  /** De datamap bestaat niet of is niet leesbaar: verkeerd pad of mount weg. */
  | "dir_unavailable"
  /** De map bestaat en is leeg — typisch een CIFS-mount die niet aanhaakte. */
  | "dir_empty"
  /** De map heeft inhoud, maar dit bestand niet: de plugin schreef nog nooit. */
  | "file_missing"
  /** Het bestand staat er, maar is geen geldige snapshot (half geschreven). */
  | "file_unreadable";

export class PluginDataError extends Error {
  constructor(
    readonly kind: PluginDataErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "PluginDataError";
  }
}

export interface ContainerItem {
  id: number;
  name: string;
  quantity: number;
}

export interface ContainerData {
  kind: ContainerKind;
  /** Het pad dat gelezen is — zodat een verkeerde mount zichtbaar wordt. */
  path: string;
  /** Tijdstempel uit het bestand zelf (ISO 8601), gezet door de plugin. */
  timestamp: string;
  /** Leeftijd in seconden, of null als het tijdstempel onleesbaar was. */
  ageSeconds: number | null;
  /** Wijzigingstijd van het bestand, als tweede aanwijzing naast `timestamp`. */
  fileModified: string;
  items: ContainerItem[];
  /** Regels die zijn overgeslagen omdat ze niet op een item leken. */
  skippedItemCount: number;
}

/**
 * Data ouder dan dit krijgt een expliciete waarschuwing mee. Het is een hint,
 * geen hard oordeel: voor de inventory is vijftien minuten oud vrijwel zeker
 * verouderd (die verandert continu tijdens het spelen), voor de bank is het
 * volstrekt normaal — die wordt alleen bij een geopende bank herschreven.
 */
export const STALE_AFTER_SECONDS = 15 * 60;

/**
 * Onderscheidt "map weg" van "map leeg" van "bestand weg".
 *
 * Geëxporteerd omdat `playerstate.ts` uit dezelfde map leest en precies
 * dezelfde drie gevallen moet kunnen onderscheiden.
 */
export const inspectDataDir = async (dir: string): Promise<string[]> => {
  try {
    return await readdir(dir);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    const hint = dataDirIsConfigured()
      ? `${DATA_DIR_ENV} staat op "${dir}".`
      : `Er is geen ${DATA_DIR_ENV} gezet, dus het standaardpad "${dir}" is gebruikt.`;

    if (code === "ENOENT") {
      throw new PluginDataError(
        "dir_unavailable",
        `De datamap bestaat niet: "${dir}". ${hint} Dit zegt niets over wat ` +
          "de plugin heeft weggeschreven — de bron is simpelweg niet te " +
          "vinden. Controleer of de map klopt en, in de container, of de " +
          "NAS-mount er nog is.",
      );
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new PluginDataError(
        "dir_unavailable",
        `Geen leesrechten op de datamap "${dir}". ${hint} De data is dus niet ` +
          "op te vragen; dat is iets anders dan een lege bank of een speler " +
          "die nergens staat.",
      );
    }
    throw new PluginDataError(
      "dir_unavailable",
      `De datamap "${dir}" is niet te lezen (${code ?? "onbekende fout"}). ${hint} ` +
        "Bij een netwerkmount wijst dit meestal op een verbroken verbinding.",
    );
  }
};

const parseSnapshot = (
  raw: string,
  kind: ContainerKind,
  path: string,
): { timestamp: unknown; items: unknown[] } => {
  if (raw.trim().length === 0) {
    throw new PluginDataError(
      "file_unreadable",
      `Het bestand "${path}" is leeg. Waarschijnlijk is het net half ` +
        "weggeschreven. Probeer het over een paar seconden opnieuw.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    throw new PluginDataError(
      "file_unreadable",
      `Het bestand "${path}" is geen geldige JSON (${
        error instanceof Error ? error.message : String(error)
      }). De plugin schrijft atomisch, dus dit hoort niet voor te komen; het is ` +
        "geen aanwijzing dat de " +
        CONTAINERS[kind].label +
        " leeg is. Probeer het opnieuw, en blijft het fout, dan is het bestand " +
        "beschadigd.",
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PluginDataError(
      "file_unreadable",
      `Het bestand "${path}" bevat geen snapshot-object zoals de plugin ` +
        "wegschrijft. Mogelijk is het formaat van de plugin gewijzigd.",
    );
  }

  const record = parsed as Record<string, unknown>;
  const items = record["items"];
  if (!Array.isArray(items)) {
    throw new PluginDataError(
      "file_unreadable",
      `Het bestand "${path}" heeft geen items-lijst. Mogelijk is het formaat ` +
        "van de plugin gewijzigd; deze server verwacht " +
        '{ "timestamp": ..., "items": [...] }.',
    );
  }

  return { timestamp: record["timestamp"], items };
};

/**
 * Items defensief inlezen. Het formaat komt uit een andere repo, dus een regel
 * die niet aan de verwachting voldoet wordt geteld en overgeslagen in plaats
 * van de hele lezing te laten mislukken.
 */
const toItems = (raw: unknown[]): { items: ContainerItem[]; skipped: number } => {
  const items: ContainerItem[] = [];
  let skipped = 0;

  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      skipped += 1;
      continue;
    }
    const record = entry as Record<string, unknown>;
    const id = record["id"];
    const quantity = record["quantity"];
    if (typeof id !== "number" || typeof quantity !== "number") {
      skipped += 1;
      continue;
    }
    const name = record["name"];
    items.push({
      id,
      name: typeof name === "string" && name.length > 0 ? name : `onbekend item ${id}`,
      quantity,
    });
  }

  return { items, skipped };
};

export const readContainer = async (kind: ContainerKind): Promise<ContainerData> => {
  const dir = dataDir();
  const entries = await inspectDataDir(dir);

  if (entries.length === 0) {
    throw new PluginDataError(
      "dir_empty",
      `De datamap "${dir}" bestaat wel, maar is helemaal leeg. Dat is een ander ` +
        "probleem dan een ontbrekend bestand: als álles ontbreekt is de mount " +
        "waarschijnlijk niet aangehaakt (een mislukte CIFS-mount laat een lege " +
        "map achter). Het zegt niets over de inhoud van de bank of inventory.",
    );
  }

  const file = CONTAINERS[kind].file;
  const path = join(dir, file);

  if (!entries.includes(file)) {
    throw new PluginDataError(
      "file_missing",
      `"${file}" staat niet in "${dir}", terwijl de map wel andere bestanden ` +
        `heeft (${entries.slice(0, 5).join(", ")}). De map is dus bereikbaar; de ` +
        `plugin heeft de ${CONTAINERS[kind].label} alleen nog nooit ` +
        "weggeschreven. " +
        (kind === "bank"
          ? "De bank wordt pas geschreven als die in-game geopend is."
          : "De inventory wordt bij de eerste wijziging na inloggen geschreven.") +
        " Dit betekent niet dat hij leeg is.",
    );
  }

  let raw: string;
  let fileModified: string;
  try {
    // Eerst stat, dan lezen: de wijzigingstijd is de enige aanwijzing die niet
    // van de plugin zelf komt en dus onafhankelijk te vertrouwen is.
    fileModified = (await stat(path)).mtime.toISOString();
    raw = await readFile(path, "utf8");
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    // Een race met de atomische rename van de plugin: net tussen readdir en
    // read verplaatst. Dat is een leesprobleem, geen lege container.
    throw new PluginDataError(
      "file_unreadable",
      `"${path}" stond in de map maar is niet te lezen (${code ?? "onbekende fout"}). ` +
        "Mogelijk werd het bestand net vervangen; probeer het opnieuw.",
    );
  }

  const snapshot = parseSnapshot(raw, kind, path);
  const { items, skipped } = toItems(snapshot.items);

  const timestamp =
    typeof snapshot.timestamp === "string" && snapshot.timestamp.length > 0
      ? snapshot.timestamp
      : null;
  const parsedTime = timestamp === null ? NaN : Date.parse(timestamp);
  const ageSeconds = Number.isNaN(parsedTime)
    ? null
    : Math.max(0, Math.round((Date.now() - parsedTime) / 1000));

  return {
    kind,
    path,
    timestamp: timestamp ?? "onbekend",
    ageSeconds,
    fileModified,
    items,
    skippedItemCount: skipped,
  };
};
