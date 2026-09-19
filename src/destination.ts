/**
 * Het commandokanaal: de enige plek waar deze server iets naar de client stuurt.
 *
 * Alle andere modules lezen. De plugin schrijft bank, inventory en spelstaat naar de
 * gedeelde map en wij lezen die; er is geen weg terug. Voor een bestemming moet die weg
 * er wél zijn, en dit bestand is hem: de server legt `command.json` neer, de plugin kijkt
 * daar elke seconde naar en post een `PluginMessage` naar Shortest Path, die de lijn op
 * de kaart tekent.
 *
 * **Wat er over dit kanaal kan, is precies één ding.** Een opdracht zet of wist een
 * bestemming. Er is geen veld voor een klik, een menu-actie of een looppad, en de plugin
 * heeft er ook geen code voor. Het account beweegt niet vanzelf; er komt alleen een lijn
 * op de kaart te staan waar de speler zelf langs loopt.
 *
 * Het lastigste aan dit kanaal is niet het schrijven maar het wéten dat het aankwam. Een
 * `PluginMessage` aan een plugin die niet draait verdwijnt zonder foutmelding — dan zou
 * hier "bestemming gezet" terugkomen terwijl er niets gebeurde. Daarom antwoordt de
 * plugin op elke opdracht in `command-ack.json` met een eigen status per manier waarop
 * het mis kan gaan, en wacht deze module op dat antwoord voor hij iets meldt.
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { DATA_DIR_ENV, PluginDataError, dataDir, inspectDataDir } from "./plugindata.js";

/** De bestandsnamen die `ItemCheckConfig` standaard gebruikt. */
export const COMMAND_FILE = "command.json";
export const ACK_FILE = "command-ack.json";
export const ROUTE_FILE = "route.json";

/** Hoe vaak de plugin naar een nieuwe opdracht kijkt (`COMMAND_POLL_SECONDS`). */
export const PLUGIN_POLL_SECONDS = 1;

/**
 * Hoe lang er op een antwoord gewacht wordt.
 *
 * Twintig seconden. De plugin pollt elke seconde, dus normaal is het antwoord er binnen
 * twee; de rest is marge voor een trage netwerkshare aan beide kanten. Korter zou een
 * SMB-hapering laten doorkomen als "geen antwoord", en dat is een veel alarmerender
 * melding dan de situatie verdient.
 */
export const ACK_TIMEOUT_MS = 20_000;

/**
 * Hoe lang er daarna nog op de route gewacht wordt.
 *
 * De ack zegt dat het bericht is aangekomen; de route komt pas als Shortest Path klaar is
 * met rekenen, en dat duurt bij een pad door het halve continent merkbaar langer dan bij
 * een bank om de hoek. Loopt dit af, dan staat de lijn er wel — alleen de tekst ontbreekt.
 */
export const ROUTE_TIMEOUT_MS = 15_000;

const POLL_INTERVAL_MS = 250;

/** Dezelfde uitkomsten als `CommandAck.Status` in de plugin. */
export type CommandStatus =
  | "ok"
  | "shortest_path_missing"
  | "shortest_path_disabled"
  | "not_logged_in"
  | "bad_command"
  | "channel_disabled";

export interface CommandResult {
  seq: number;
  status: CommandStatus;
  /** De uitleg van de plugin, bedoeld om ongewijzigd door te geven. */
  message: string;
  handledAt: string;
  /** Hoe lang er op het antwoord gewacht is — zegt iets over de share. */
  waitedMs: number;
}

export interface RouteLeg {
  from: { x: number; y: number; plane: number };
  to: { x: number; y: number; plane: number };
  /** Wat je aanklikt, zoals `"Travel Spirit tree 26261"`. */
  objectInfo: string | null;
  /** De naam die Shortest Path toont, zoals `"Varrock Teleport"`. */
  displayInfo: string | null;
}

export interface Route {
  timestamp: string;
  /** Het loopnummer van de opdracht waar deze route bij hoort. */
  seq: number;
  legs: RouteLeg[];
  ageSeconds: number | null;
}

export interface Point {
  x: number;
  y: number;
  plane: number;
}

/**
 * Er gaat iets mis in het kanaal zelf, niet in het spel.
 *
 * Apart van `PluginDataError` omdat de oorzaak en de oplossing anders zijn: daar is de
 * bron onleesbaar, hier is hij onbeschrijfbaar of blijft het antwoord uit.
 */
export class CommandChannelError extends Error {
  constructor(
    readonly kind: "not_writable" | "no_answer" | "unreadable",
    message: string,
  ) {
    super(message);
    this.name = "CommandChannelError";
  }
}

const filePath = (name: string): string => join(dataDir(), name);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** JSON uit de gedeelde map, of null als het er niet (goed) staat. */
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
    // Half geschreven bestand. Beide kanten schrijven atomisch, dus dit hoort niet voor
    // te komen; over een kwart seconde staat er iets geldigs en de wachtlus komt terug.
    return null;
  }
};

const numberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Het volgende loopnummer.
 *
 * Neemt het hoogste van het commandobestand en het antwoordbestand, zodat het nummer ook
 * blijft oplopen als een van de twee is opgeruimd. Het nummer hoeft niet uniek te zijn
 * over de eeuwigheid, alleen hoger dan wat de plugin het laatst zag — daar hangt de hele
 * "is deze opdracht nieuw"-beslissing aan.
 */
const nextSeq = async (): Promise<number> => {
  const command = await readJson(filePath(COMMAND_FILE));
  const ack = await readJson(filePath(ACK_FILE));
  const highest = Math.max(
    numberOrNull(command?.["seq"]) ?? 0,
    numberOrNull(ack?.["seq"]) ?? 0,
  );
  return highest + 1;
};

/**
 * Schrijft het commandobestand atomisch: eerst een tijdelijk bestand, dan hernoemen.
 *
 * Dezelfde volgorde als de plugin gebruikt, en om dezelfde reden: de plugin kijkt elke
 * seconde en mag nooit een half geschreven opdracht zien. Een `rename` binnen dezelfde
 * map is op NFS atomair.
 */
const writeCommand = async (command: Record<string, unknown>): Promise<void> => {
  const target = filePath(COMMAND_FILE);
  const temporary = `${target}.tmp`;

  try {
    await writeFile(temporary, `${JSON.stringify(command, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    const dir = dataDir();

    if (code === "EROFS" || code === "EACCES" || code === "EPERM") {
      throw new CommandChannelError(
        "not_writable",
        `De datamap "${dir}" is niet beschrijfbaar (${code}). Dit is de enige tool ` +
          "die daar iets neerzet; alle andere lezen alleen, en de mount stond daarom " +
          "read-only. Om bestemmingen te kunnen zetten moet de map schrijfbaar zijn: " +
          "in `docker-compose.yml` het `:ro` van het `/data`-volume halen (en de " +
          "NFS-export op de NAS read-write laten staan). Er is niets gewijzigd in het " +
          "spel — de opdracht is nooit vertrokken.",
      );
    }

    throw new CommandChannelError(
      "not_writable",
      `Kon de opdracht niet wegschrijven naar "${dir}" (${code ?? "onbekende fout"}). ` +
        `${DATA_DIR_ENV} wijst daarheen. Bij een netwerkmount wijst dit meestal op een ` +
        "verbroken verbinding. De opdracht is niet vertrokken.",
    );
  }
};

/** Wacht tot het antwoordbestand bij dit loopnummer hoort. */
const waitForAck = async (seq: number): Promise<CommandResult> => {
  const started = Date.now();
  const path = filePath(ACK_FILE);

  while (Date.now() - started < ACK_TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);

    const ack = await readJson(path);
    if (ack === null || numberOrNull(ack["seq"]) !== seq) continue;

    const status = typeof ack["status"] === "string" ? ack["status"] : "";
    const message = typeof ack["message"] === "string" ? ack["message"] : "";
    if (status.length === 0 || message.length === 0) {
      throw new CommandChannelError(
        "unreadable",
        `De plugin antwoordde op opdracht ${seq}, maar het antwoord mist een status of ` +
          "een toelichting. Mogelijk lopen de plugin en deze server uit de pas qua " +
          "versie. Of de bestemming gezet is, is hiermee niet vast te stellen.",
      );
    }

    return {
      seq,
      status: status as CommandStatus,
      message,
      handledAt: typeof ack["handledAt"] === "string" ? ack["handledAt"] : "onbekend",
      waitedMs: Date.now() - started,
    };
  }

  throw new CommandChannelError(
    "no_answer",
    `De opdracht staat in "${filePath(COMMAND_FILE)}", maar er kwam binnen ` +
      `${Math.round(ACK_TIMEOUT_MS / 1000)} seconden geen antwoord van de plugin. De ` +
      "plugin kijkt elke seconde, dus dit betekent vrijwel zeker dat RuneLite niet " +
      "draait, dat de plugin \"OSRS Item Check\" uit staat, dat hij naar een andere map " +
      "kijkt dan deze server, of dat de optie \"Accept destination commands\" uit staat. " +
      "Controleer met get_player_state of de client überhaupt nog schrijft. **Er is niet " +
      "vast te stellen of de bestemming gezet is** — ga ervan uit van niet.",
  );
};

/**
 * Zet of wist een bestemming, en wacht op het antwoord van de plugin.
 *
 * Er wordt bewust gewacht. Zonder wachten zou deze functie altijd slagen, ook als er geen
 * client draait, en dan is het antwoord "bestemming gezet" een gok die er als een feit
 * uitziet. Dat is precies de stille fout die dit ticket wilde uitsluiten.
 */
export const sendCommand = async (
  action: "path" | "clear",
  target: Point | null,
  start: Point | null,
): Promise<CommandResult> => {
  // Dezelfde drie gevallen als bij het lezen: map weg, map leeg, of gewoon goed. Hier
  // vooral om een verkeerde mount te betrappen vóór er een opdracht in het niets belandt.
  await inspectDataDir(dataDir());

  const seq = await nextSeq();
  await writeCommand({
    seq,
    issuedAt: new Date().toISOString(),
    action,
    target,
    start,
    // Zonder deze vlag tekent Shortest Path wel de lijn maar meldt hij niet welke
    // transports erin zitten, en dan heeft plan_route niets om voor te lezen.
    postTransports: action === "path",
  });

  return await waitForAck(seq);
};

/** De route zoals de plugin hem laatst opving, of null als er nog geen ligt. */
export const readRoute = async (): Promise<Route | null> => {
  const raw = await readJson(filePath(ROUTE_FILE));
  if (raw === null) return null;

  const legs: RouteLeg[] = [];
  const rawLegs = raw["legs"];
  if (Array.isArray(rawLegs)) {
    for (const entry of rawLegs) {
      if (typeof entry !== "object" || entry === null) continue;
      const leg = entry as Record<string, unknown>;
      const fromX = numberOrNull(leg["fromX"]);
      const fromY = numberOrNull(leg["fromY"]);
      const toX = numberOrNull(leg["toX"]);
      const toY = numberOrNull(leg["toY"]);
      if (fromX === null || fromY === null || toX === null || toY === null) continue;

      legs.push({
        from: { x: fromX, y: fromY, plane: numberOrNull(leg["fromPlane"]) ?? 0 },
        to: { x: toX, y: toY, plane: numberOrNull(leg["toPlane"]) ?? 0 },
        objectInfo: typeof leg["objectInfo"] === "string" ? leg["objectInfo"] : null,
        displayInfo: typeof leg["displayInfo"] === "string" ? leg["displayInfo"] : null,
      });
    }
  }

  const timestamp = typeof raw["timestamp"] === "string" ? raw["timestamp"] : "onbekend";
  const parsed = Date.parse(timestamp);

  return {
    timestamp,
    seq: numberOrNull(raw["seq"]) ?? 0,
    legs,
    ageSeconds: Number.isNaN(parsed) ? null : Math.round((Date.now() - parsed) / 1000),
  };
};

/**
 * Wacht tot er een route ligt die bij deze opdracht hoort.
 *
 * Null betekent "niet binnen de tijd", niet "geen transports nodig". Die twee zijn hier
 * niet te onderscheiden — een route die helemaal te belopen is levert een lege lijst op,
 * en die komt wél binnen. Het verschil zit dus in óf er een bestand met dit loopnummer
 * verschijnt, niet in hoeveel etappes erin staan.
 */
export const waitForRoute = async (seq: number): Promise<Route | null> => {
  const started = Date.now();

  while (Date.now() - started < ROUTE_TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);
    const route = await readRoute();
    if (route !== null && route.seq >= seq) return route;
  }

  return null;
};

/** Het loopnummer van de laatst verstuurde opdracht, om een oude route te herkennen. */
export const lastCommandSeq = async (): Promise<number> => {
  const command = await readJson(filePath(COMMAND_FILE));
  return numberOrNull(command?.["seq"]) ?? 0;
};

export { PluginDataError };
