/**
 * Genereert `src/landmarkdata.ts`: de landmark- en regiotabel voor de leesbare
 * plaatsaanduiding van `get_player_state` (ORS-015).
 *
 * Bron is de Shortest Path-plugin van Skretzo, die zijn kaartkennis als TSV in
 * de repo heeft staan. Wij halen daar twee dingen uit:
 *
 *   - **Benoemde punten** — bankchests, altaren en teleportbestemmingen. Die
 *     hebben een coördinaat én een naam, en dat is precies wat "±40 tiles NO
 *     van de bank van Varrock" nodig heeft.
 *   - **Region-ID naar gebiedsnaam** — `leagues/regions.tsv` dekt 1441
 *     region-ID's af met elf grove gebieden. Dat is de terugval als er geen
 *     benoemd punt in de buurt ligt.
 *
 * Draaien: `node scripts/build-landmarks.mjs`. Het resultaat is een `.ts` en
 * geen `.json`, want de Dockerfile kopieert alleen `src/` — een JSON-bestand
 * zou in de container ontbreken. Gegenereerd, dus niet met de hand bijwerken.
 */

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const RAW = "https://raw.githubusercontent.com/Skretzo/shortest-path/master/src/main/resources";

/**
 * Welke bestanden er meedoen. `nameColumn` is de kop waar de leesbare naam in
 * staat; die wordt in de header opgezocht in plaats van op een vast
 * kolomnummer, zodat een extra kolom bij Skretzo dit script niet stil sloopt.
 */
const SOURCES = [
  { path: "destinations/game_features/bank.tsv", nameColumn: "Info", category: "bank" },
  { path: "destinations/game_features/altar.tsv", nameColumn: "Info", category: "altaar" },
  { path: "transports/teleportation_spells.tsv", nameColumn: "Display info", category: "teleport" },
  { path: "transports/teleportation_spells_home.tsv", nameColumn: "Display info", category: "teleport" },
  { path: "transports/teleportation_minigames.tsv", nameColumn: "Display info", category: "teleport" },
];

const REGIONS = "leagues/regions.tsv";

/**
 * Namen die geen plek op de kaart zijn. "Teleport to House" heeft in de TSV wel
 * een coördinaat, maar die is een plaatshouder — het huis staat waar de speler
 * het neerzet. Als landmark zou hij wijzen naar een plek die niemand kent.
 */
const EXCLUDED_NAMES = [/^Teleport to House\b/i];

/** De league-regionamen staan in kapitalen; dit is hoe een mens ze schrijft. */
const REGION_LABELS = {
  ASGARNIA: "Asgarnia",
  DESERT: "de woestijn (Kharidian Desert)",
  FREMENNIK: "de Fremennik-landen",
  KANDARIN: "Kandarin",
  KARAMJA: "Karamja",
  KOUREND: "Great Kourend",
  MISTHALIN: "Misthalin",
  MORYTANIA: "Morytania",
  TIRANNWN: "Tirannwn",
  VARLAMORE: "Varlamore",
  WILDERNESS: "de Wilderness",
};

const fetchTsv = async (path) => {
  const url = `${RAW}/${path}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} gaf HTTP ${response.status}`);
  }
  return await response.text();
};

/** De eerste `#`-regel is de header; latere `#`-regels zijn toelichting. */
const headerColumns = (lines) => {
  const header = lines.find((line) => line.startsWith("#"));
  if (header === undefined) {
    throw new Error("geen headerregel gevonden");
  }
  return header.replace(/^#\s*/, "").split("\t").map((column) => column.trim());
};

/** "3213 3424 0" → [3213, 3424, 0]; alles wat daar niet op lijkt wordt null. */
const parsePoint = (cell) => {
  const parts = cell.trim().split(/\s+/);
  if (parts.length !== 3) return null;
  const numbers = parts.map(Number);
  return numbers.every((value) => Number.isInteger(value)) ? numbers : null;
};

/**
 * "Varrock Teleport" → "Varrock", "Varrock Teleport: Grand Exchange" →
 * "Varrock: Grand Exchange". De teleportbestanden zetten er een soort achter
 * die voor een plaatsaanduiding alleen ruis is; de plek is wat overblijft.
 */
const cleanName = (raw) =>
  raw
    .replace(/\s*\b(?:Home|Minigame)?\s*Teleport\b(?=\s*(?::|$))/i, "")
    .replace(/\s+/g, " ")
    .trim();

const readLandmarks = async () => {
  const seen = new Set();
  const landmarks = [];

  for (const source of SOURCES) {
    const lines = (await fetchTsv(source.path)).split("\n");
    const columns = headerColumns(lines);
    const destinationColumn = columns.indexOf("Destination");
    const nameColumn = columns.indexOf(source.nameColumn);
    if (destinationColumn === -1 || nameColumn === -1) {
      throw new Error(
        `${source.path}: kolom "Destination" of "${source.nameColumn}" ontbreekt ` +
          `(kolommen: ${columns.join(", ")})`,
      );
    }

    let kept = 0;
    for (const line of lines) {
      if (line.startsWith("#") || line.trim().length === 0) continue;
      const cells = line.split("\t");
      const point = parsePoint(cells[destinationColumn] ?? "");
      if (point === null) continue;
      const name = cleanName(cells[nameColumn] ?? "");
      if (name.length === 0) continue;
      if (EXCLUDED_NAMES.some((pattern) => pattern.test(name))) continue;

      // Dezelfde plek staat vaak meermaals in de TSV — per chest, per varbit,
      // per spellbook. Voor "wat ligt hier in de buurt" is dat één punt.
      const key = `${point.join(",")}|${name}|${source.category}`;
      if (seen.has(key)) continue;
      seen.add(key);
      landmarks.push({ x: point[0], y: point[1], plane: point[2], name, category: source.category });
      kept += 1;
    }
    console.log(`${source.path}: ${kept} punt(en)`);
  }

  landmarks.sort((a, b) => a.x - b.x || a.y - b.y || a.name.localeCompare(b.name, "en"));
  return landmarks;
};

const readRegions = async () => {
  const lines = (await fetchTsv(REGIONS)).split("\n");
  const regions = new Map();
  const unknown = new Set();

  for (const line of lines) {
    if (line.startsWith("#") || line.trim().length === 0) continue;
    const [rawId, rawName] = line.split("\t");
    const id = Number(rawId?.trim());
    const name = rawName?.trim();
    if (!Number.isInteger(id) || name === undefined || name.length === 0) continue;
    const label = REGION_LABELS[name];
    if (label === undefined) {
      unknown.add(name);
      continue;
    }
    regions.set(id, label);
  }

  if (unknown.size > 0) {
    // Hard stoppen: een naam die hier niet in staat zou stil verdwijnen uit de
    // tabel, en dan vertelt de server "onbekend gebied" over een gebied dat
    // Skretzo wél kent.
    throw new Error(
      `onbekende regionamen in ${REGIONS}: ${[...unknown].join(", ")} — vul ` +
        "REGION_LABELS aan in dit script",
    );
  }

  console.log(`${REGIONS}: ${regions.size} region-ID's`);
  return [...regions.entries()].sort((a, b) => a[0] - b[0]);
};

const landmarks = await readLandmarks();
const regions = await readRegions();

const categories = [...new Set(landmarks.map((landmark) => landmark.category))].sort();
const quote = (value) => JSON.stringify(value);

const out = `/**
 * Landmark- en regiotabel voor de leesbare plaatsaanduiding van
 * \`get_player_state\`. **Gegenereerd bestand — niet met de hand bijwerken.**
 *
 * Opnieuw opbouwen: \`node scripts/build-landmarks.mjs\`. Dat script legt uit
 * waar de data vandaan komt en waarom het een \`.ts\` en geen \`.json\` is.
 *
 * Bron: de Shortest Path-plugin van Skretzo, tak \`master\`.
 * Opgebouwd op ${new Date().toISOString().slice(0, 10)}.
 */

/** Soort punt, als index in \`LANDMARKS\`. */
export const LANDMARK_CATEGORIES = [${categories.map(quote).join(", ")}] as const;

export type LandmarkCategory = (typeof LANDMARK_CATEGORIES)[number];

/**
 * \`[x, y, plane, naam, categorie-index]\`. Een tuple en geen object: het zijn
 * ${landmarks.length} punten en die worden bij elke lookup lineair doorlopen.
 */
export const LANDMARKS: readonly (readonly [number, number, number, string, number])[] = [
${landmarks
  .map(
    (landmark) =>
      `  [${landmark.x}, ${landmark.y}, ${landmark.plane}, ${quote(landmark.name)}, ` +
      `${categories.indexOf(landmark.category)}],`,
  )
  .join("\n")}
];

/**
 * Region-ID naar gebiedsnaam. Dit zijn de *league*-gebieden van Shortest Path:
 * grove blokken, geen exacte geografie, maar ze dekken de hele kaart en dat is
 * wat een terugval nodig heeft.
 */
export const REGION_NAMES: Readonly<Record<number, string>> = {
${regions.map(([id, name]) => `  ${id}: ${quote(name)},`).join("\n")}
};
`;

const target = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "landmarkdata.ts");
await writeFile(target, out, "utf8");
console.log(`\n${landmarks.length} landmarks en ${regions.length} regions geschreven naar ${target}`);
