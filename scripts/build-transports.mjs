/**
 * Genereert `src/transportdata.ts`: welke items, quests en skills een transport vraagt.
 *
 * Shortest Path post na elke berekening de transports van de route terug, maar dat
 * bericht bevat alleen coördinaten en twee namen — niet wat je ervoor nodig hebt. De
 * eisen staan wél in de TSV's waar diezelfde plugin zijn kaartkennis uit haalt. Dit
 * script haalt ze daar op, zodat `plan_route` per etappe kan zeggen "hiervoor heb je een
 * Ardougne cloak nodig, en die ligt in je bank".
 *
 * **De sleutel is de tekst die het bericht meestuurt.** `Display info` komt ongewijzigd
 * in het `transports`-bericht terecht (alleen POH-portalen worden herschreven), en de
 * kolom `menuOption menuTarget objectID` idem als `objectInfo`. Op die twee strings is
 * dus te koppelen zonder de hele kaart mee te nemen — wij hebben geen pathfinder en
 * willen er ook geen.
 *
 * Draaien: `node scripts/build-transports.mjs`. Resultaat is een `.ts` en geen `.json`,
 * om dezelfde reden als bij `build-landmarks.mjs`: de Dockerfile kopieert alleen `src/`.
 */

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const RAW = "https://raw.githubusercontent.com/Skretzo/shortest-path/master/src/main/resources";

/**
 * Alle transportbestanden. Niet elk bestand heeft elke kolom — een fairy ring vraagt
 * geen items, een agility shortcut heeft geen `Display info` — en dat is geen fout maar
 * de normale toestand. Ontbrekende kolommen worden overgeslagen, een ontbrekend bestand
 * niet: dat betekent dat Skretzo iets hernoemd heeft en dan moet dit script stuk.
 */
const FILES = [
  "agility_shortcuts",
  "boats",
  "canoes",
  "charter_ships",
  "fairy_rings",
  "gnome_gliders",
  "hot_air_balloons",
  "magic_carpets",
  "magic_mushtrees",
  "minecarts",
  "quetzal_whistle",
  "quetzals",
  "seasonal_transports",
  "ships",
  "spirit_trees",
  "teleportation_boxes",
  "teleportation_items",
  "teleportation_levers",
  "teleportation_minigames",
  "teleportation_portals",
  "teleportation_portals_poh",
  "teleportation_spells",
  "teleportation_spells_home",
  "transports",
  "wilderness_obelisks",
];

const fetchTsv = async (name) => {
  const url = `${RAW}/transports/${name}.tsv`;
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
  return header
    .replace(/^#\s*/, "")
    .split("\t")
    .map((column) => column.trim());
};

/**
 * `"13121=1||13122=1"` → `[[[13121, 1]], [[13122, 1]]]`.
 *
 * `||` scheidt *alternatieven*: elke Ardougne cloak van 2 tot en met 4 doet het, je hebt
 * er één nodig. Binnen een alternatief scheidt `;` de items die je allemaal moet hebben.
 * In de huidige data komt dat tweede geval niet voor, maar het staat er wel in omdat de
 * varbit-kolommen het wél gebruiken en de dag dat Skretzo het hier ook doet mag dit
 * script niet stilletjes het verkeerde antwoord geven.
 */
const parseItems = (cell) => {
  const raw = cell?.trim() ?? "";
  if (raw.length === 0) return [];

  const alternatives = [];
  for (const group of raw.split("||")) {
    const items = [];
    for (const part of group.split(";")) {
      const match = /^(\d+)\s*=\s*(\d+)$/.exec(part.trim());
      if (match === null) continue;
      items.push([Number(match[1]), Number(match[2])]);
    }
    if (items.length > 0) alternatives.push(items);
  }
  return alternatives;
};

/** Quests en skills staan als vrije tekst, met `;` ertussen. */
const parseList = (cell) => {
  const raw = cell?.trim() ?? "";
  if (raw.length === 0) return [];
  return raw
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
};

/** Twee eisenpakketten zijn hetzelfde als hun JSON gelijk is — genoeg voor ontdubbelen. */
const fingerprint = (requirement) => JSON.stringify(requirement);

const build = async () => {
  /** sleutel (displayInfo of objectInfo) → lijst met onderscheidbare eisenpakketten. */
  const entries = new Map();
  let rowCount = 0;

  const remember = (key, requirement) => {
    const trimmed = key?.trim() ?? "";
    if (trimmed.length === 0) return;
    // Een eisenpakket zonder enige eis voegt niets toe: "geen items nodig" is ook het
    // antwoord als de sleutel helemaal niet in de tabel staat.
    if (
      requirement.items.length === 0 &&
      requirement.quests.length === 0 &&
      requirement.skills.length === 0
    ) {
      return;
    }

    const existing = entries.get(trimmed) ?? [];
    if (existing.some((other) => fingerprint(other) === fingerprint(requirement))) return;
    existing.push(requirement);
    entries.set(trimmed, existing);
  };

  for (const name of FILES) {
    const lines = (await fetchTsv(name)).split("\n");
    const columns = headerColumns(lines);
    const displayColumn = columns.indexOf("Display info");
    const objectColumn = columns.indexOf("menuOption menuTarget objectID");
    const itemsColumn = columns.indexOf("Items");
    const questsColumn = columns.indexOf("Quests");
    const skillsColumn = columns.indexOf("Skills");

    if (displayColumn === -1 && objectColumn === -1) {
      throw new Error(
        `transports/${name}.tsv heeft geen "Display info" én geen ` +
          `"menuOption menuTarget objectID" — zonder een van die twee is er niets om ` +
          `het transports-bericht op te koppelen (kolommen: ${columns.join(", ")})`,
      );
    }

    let kept = 0;
    for (const line of lines) {
      if (line.startsWith("#") || line.trim().length === 0) continue;
      const cells = line.split("\t");
      rowCount += 1;

      const requirement = {
        items: itemsColumn === -1 ? [] : parseItems(cells[itemsColumn]),
        quests: questsColumn === -1 ? [] : parseList(cells[questsColumn]),
        skills: skillsColumn === -1 ? [] : parseList(cells[skillsColumn]),
      };

      const before = entries.size;
      if (displayColumn !== -1) remember(cells[displayColumn], requirement);
      if (objectColumn !== -1) remember(cells[objectColumn], requirement);
      if (entries.size !== before) kept += 1;
    }
    console.log(`transports/${name}.tsv: ${kept} nieuwe sleutel(s)`);
  }

  return { entries, rowCount };
};

const { entries, rowCount } = await build();

const quote = (value) => JSON.stringify(value);
const sorted = [...entries.entries()].sort((a, b) => a[0].localeCompare(b[0], "en"));

const renderRequirement = (requirement) =>
  `{ items: ${quote(requirement.items)}, quests: ${quote(requirement.quests)}, ` +
  `skills: ${quote(requirement.skills)} }`;

const out = `/**
 * Wat een transport van je vraagt, op de tekst waarmee Shortest Path hem aankondigt.
 * **Gegenereerd bestand — niet met de hand bijwerken.**
 *
 * Opnieuw opbouwen: \`node scripts/build-transports.mjs\`. Dat script legt uit waar de
 * data vandaan komt en waarom er op een string gekoppeld wordt.
 *
 * Bron: de Shortest Path-plugin van Skretzo, tak \`master\`.
 * Opgebouwd op ${new Date().toISOString().slice(0, 10)} uit ${rowCount} TSV-regels.
 */

/** \`[item-ID, aantal]\`. */
export type ItemRequirement = readonly [number, number];

export interface TransportRequirement {
  /**
   * Alternatieven: je hebt er één van nodig. Binnen één alternatief heb je alles nodig.
   * Een lege lijst betekent dat er geen item aan te pas komt.
   */
  readonly items: readonly (readonly ItemRequirement[])[];
  readonly quests: readonly string[];
  readonly skills: readonly string[];
}

/**
 * Sleutel is de \`displayInfo\` of de \`objectInfo\` uit het \`transports\`-bericht,
 * letterlijk. Meerdere eisenpakketten onder één sleutel betekent dat dezelfde tekst in
 * de TSV's bij verschillende eisen hoort — bijvoorbeeld hetzelfde object op twee plekken.
 * Ze worden dan allemaal getoond, want welke van de twee geldt is hier niet te bepalen.
 */
export const TRANSPORT_REQUIREMENTS: Readonly<Record<string, readonly TransportRequirement[]>> = {
${sorted
  .map(([key, requirements]) => `  ${quote(key)}: [${requirements.map(renderRequirement).join(", ")}],`)
  .join("\n")}
};
`;

const target = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "transportdata.ts");
await writeFile(target, out, "utf8");
console.log(`\n${sorted.length} sleutel(s) geschreven naar ${target}`);
