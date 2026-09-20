/**
 * De gecombineerde vraag: "heb ik de materialen voor X?" (ORS-009).
 *
 * Hier komen drie bronnen samen die niets van elkaar weten:
 *
 * - de **plugin** weet wat er in de bank ligt, in de inventory zit en aan de
 *   speler hangt, in item-ID's;
 * - de **wiki** weet wat X nodig heeft, in namen;
 * - de **hiscores** weten welk skill-level je hebt.
 *
 * De koppeling loopt over `itemindex.ts`, dat item-ID's aan wiki-items hangt.
 *
 * De leidende regel in dit bestand: **onzekerheid is geen tekort.** Als de
 * bank niet te lezen is, of een materiaal niet aan een wiki-item te koppelen
 * is, dan is het antwoord "dat weet ik niet" — nooit "die heb je niet". Een
 * onterecht "je hebt het niet" is de duurste fout die deze server kan maken:
 * hij klinkt als een antwoord en stuurt de speler naar de Grand Exchange voor
 * iets dat al in zijn bank ligt.
 */

import {
  chooseSource,
  localPlayerName,
  readSkillsSnapshot,
  type SkillsSnapshot,
  type SourceChoice,
} from "./authority.js";
import {
  HiscoresError,
  fetchSkills,
  type AccountType,
  type HiscoresResult,
} from "./hiscores.js";
import {
  CONTAINERS,
  PluginDataError,
  readContainer,
  type ContainerData,
  type ContainerKind,
} from "./plugindata.js";
import {
  findHoldings,
  linkHolding,
  loadItemIndex,
  type HoldingMatch,
  type ItemIndex,
  type LinkedHolding,
} from "./itemindex.js";
import { fetchRecipes, type Recipe, type RecipeLookup, type RecipeMaterial } from "./recipes.js";

export type SourceSelection = "bank" | "inventory" | "equipment" | "all";

/** Eén container, gelezen of niet. Een mislukking is hier geen uitzondering. */
export interface SourceStatus {
  kind: ContainerKind;
  data: ContainerData | null;
  /** De uitleg van de plugindata-laag, die zelf al zegt wat er mis is. */
  error: string | null;
}

export type MaterialStatus =
  /** Genoeg om het te maken. */
  | "genoeg"
  /** Wel iets, maar niet genoeg. */
  | "te weinig"
  /** Nul gevonden, terwijl alle gevraagde bronnen leesbaar waren. */
  | "niets"
  /** Niet vast te stellen: een bron ontbrak of het aantal is onbekend. */
  | "onbekend";

export interface MaterialCheck {
  material: RecipeMaterial;
  /** Wat er nodig is voor het gevraagde aantal, of null als dat onbekend is. */
  needed: number | null;
  /** Naar boven afgerond, voor materialen met een gemiddeld aantal. */
  neededRounded: number | null;
  have: number;
  matches: HoldingMatch[];
  status: MaterialStatus;
  /** Alles wat de gebruiker moet weten om dit oordeel te wegen. */
  notes: string[];
}

export interface SkillCheck {
  name: string;
  required: number;
  actual: number | null;
  boostable: boolean | null;
  status: "gehaald" | "te laag" | "onbekend";
}

export interface RecipeCheck {
  recipe: Recipe;
  /** Hoe vaak het recept uitgevoerd moet worden voor het gevraagde aantal. */
  batches: number;
  materials: MaterialCheck[];
  skills: SkillCheck[];
  /** true als elk materiaal op "genoeg" staat. */
  complete: boolean;
  /**
   * true als er een gat in de waarneming zit: een bron die niet gelezen kon
   * worden, of een materiaal dat niet te koppelen was. Dan is `complete` geen
   * oordeel. Een ontbrekend skill-level telt hier bewust niet in mee — dat
   * maakt het antwoord op de materiaalvraag niet onzeker, en die twee door
   * elkaar halen levert een nodeloos vaag antwoord op.
   */
  uncertain: boolean;
}

export interface MaterialsReport {
  requestedItem: string;
  requestedQuantity: number;
  lookup: RecipeLookup;
  sources: SourceStatus[];
  index: { idCount: number; builtAt: number };
  /** Alle gelezen regels, gekoppeld of niet. */
  holdings: LinkedHolding[];
  /** De regels die niet aan een wiki-item te koppelen waren. */
  unlinked: LinkedHolding[];
  /** Regels die alleen op naam of via de noted-vorm gekoppeld zijn. */
  weakLinks: LinkedHolding[];
  checks: RecipeCheck[];
  skills: HiscoresResult | null;
  skillsError: string | null;
  /** Welke bron de skill-levels leverde, en waarom (ORS-023). */
  skillSource: SourceChoice;
  /** Waar de hiscores van een verse snapshot afweken. Leeg als er niets te vergelijken viel. */
  skillDifferences: string[];
}

/**
 * "all" is de zinnige standaard en niet één container: materiaal kan in de bank liggen,
 * in de inventory zitten of aan de speler hangen, en alleen die drie bij elkaar zijn
 * "wat ik heb". Tot ORS-017 heette dit "both" en waren het er twee — een gedragen item
 * telde toen als niet-bezit.
 */
const kindsFor = (selection: SourceSelection): ContainerKind[] =>
  selection === "all" ? ["bank", "inventory", "equipment"] : [selection];

const readSources = async (selection: SourceSelection): Promise<SourceStatus[]> =>
  Promise.all(
    kindsFor(selection).map(async (kind): Promise<SourceStatus> => {
      try {
        return { kind, data: await readContainer(kind), error: null };
      } catch (error: unknown) {
        return {
          kind,
          data: null,
          error:
            error instanceof PluginDataError
              ? error.message
              : `Onverwachte fout bij het lezen van de ${CONTAINERS[kind].label}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
        };
      }
    }),
  );

const collectHoldings = (index: ItemIndex, sources: SourceStatus[]): LinkedHolding[] => {
  const holdings: LinkedHolding[] = [];
  for (const source of sources) {
    if (source.data === null) continue;
    for (const item of source.data.items) {
      holdings.push(
        linkHolding(index, CONTAINERS[source.kind].label, item.id, item.name, item.quantity),
      );
    }
  }
  return holdings;
};

/**
 * Een skill-eis toetsen aan de bron die voorrang heeft.
 *
 * Bij de hiscores betekent `null` als level "niet gerangschikt", en dat is geen
 * level 0 — het zegt alleen dat de skill niet op de hiscores staat. Dat wordt
 * dus `onbekend`, niet `te laag`. Bij de snapshot bestaat dat onderscheid niet:
 * daar staan alle drieëntwintig skills in, dus een skill die ontbreekt is een
 * formaatprobleem en levert ook `onbekend` op.
 *
 * De snapshot geeft het échte level, niet het geboostte. Dat is hier precies
 * goed: `boostable` staat al los in de eis, en een recept dat level 55 vraagt
 * terwijl je 52 hebt met een potion is iets anders dan level 55 hebben.
 */
const checkSkills = (
  recipe: Recipe,
  hiscores: HiscoresResult | null,
  snapshot: SkillsSnapshot | null,
): SkillCheck[] =>
  recipe.skills
    .filter((skill) => skill.level !== null)
    .map((skill): SkillCheck => {
      const required = skill.level!;

      let actual: number | null = null;
      if (snapshot !== null) {
        actual = snapshot.skills[skill.name.toUpperCase()]?.level ?? null;
      } else if (hiscores !== null) {
        actual =
          hiscores.skills.find(
            (candidate) => candidate.name.toLowerCase() === skill.name.toLowerCase(),
          )?.level ?? null;
      }

      return {
        name: skill.name,
        required,
        actual,
        boostable: skill.boostable,
        status: actual === null ? "onbekend" : actual >= required ? "gehaald" : "te laag",
      };
    });

const checkMaterial = (
  material: RecipeMaterial,
  batches: number,
  holdings: LinkedHolding[],
  sourcesIncomplete: boolean,
  indexed: boolean,
): MaterialCheck => {
  const matches = findHoldings(holdings, material.name);
  const have = matches.reduce((total, match) => total + match.holding.quantity, 0);

  const needed = material.quantity === null ? null : material.quantity * batches;
  // Naar boven afronden: een recept dat gemiddeld 0,46 van iets kost, kun je
  // niet uitvoeren met nul in de bank. Het gemiddelde blijft er los bij staan.
  const neededRounded = needed === null ? null : Math.ceil(needed);

  const notes: string[] = [];
  if (material.quantity !== null && !Number.isInteger(material.quantity)) {
    notes.push(
      `De wiki noteert ${material.rawQuantity ?? material.quantity} per keer — dat is ` +
        "een gemiddelde, geen vast aantal. Hier is naar boven afgerond.",
    );
  }
  if (!indexed) {
    notes.push(
      `"${material.name}" staat niet in de item-index van de wiki, dus er is geen ` +
        "ID om op te vergelijken. Er is alleen op naam gekeken; een gevonden " +
        "aantal van nul betekent hier niet met zekerheid dat je het niet hebt.",
    );
  }
  for (const match of matches) {
    if (match.via === "plugin-naam" && match.holding.method === "unlinked") {
      notes.push(
        `Gevonden op de naam die de plugin opschrijft, niet op ID: ${match.holding.note}`,
      );
    } else if (match.holding.method === "noted" || match.holding.method === "name") {
      notes.push(match.holding.note ?? "");
    }
  }

  let status: MaterialStatus;
  if (neededRounded === null) {
    status = "onbekend";
  } else if (have >= neededRounded) {
    status = "genoeg";
  } else if (sourcesIncomplete || !indexed) {
    // Een tekort vaststellen mag alleen als alle gevraagde bronnen gelezen zijn
    // én het materiaal betrouwbaar te koppelen was. Anders is het een gat in de
    // waarneming, geen tekort.
    status = "onbekend";
  } else {
    status = have > 0 ? "te weinig" : "niets";
  }

  return {
    material,
    needed,
    neededRounded,
    have,
    matches,
    status,
    notes: notes.filter((note) => note !== ""),
  };
};

export interface MaterialsRequest {
  item: string;
  quantity: number;
  sources: SourceSelection;
  username: string | null;
  accountType: AccountType;
}

export async function checkMaterials(request: MaterialsRequest): Promise<MaterialsReport> {
  // De index eerst: zonder koppeling van ID naar wiki-item heeft de rest geen
  // zin, en een fout hier hoort niet als "je hebt niets" te eindigen.
  const index = await loadItemIndex();
  const lookup = await fetchRecipes(request.item);
  const sources = await readSources(request.sources);

  const holdings = collectHoldings(index, sources);
  const sourcesIncomplete = sources.some((source) => source.data === null);

  let hiscores: HiscoresResult | null = null;
  let skillsError: string | null = null;
  if (request.username !== null) {
    try {
      hiscores = await fetchSkills(request.username, request.accountType);
    } catch (error: unknown) {
      skillsError =
        error instanceof HiscoresError
          ? error.message
          : `Onverwachte fout bij het ophalen van de skills: ${
              error instanceof Error ? error.message : String(error)
            }`;
    }
  }

  // De snapshot kan ook zónder `username` gebruikt worden, en dat is nieuw sinds ORS-023.
  // Wie vraagt "heb ik de materialen voor X" terwijl zijn eigen client draait, hoeft zijn
  // accountnaam niet meer in te typen om ook de levels getoetst te krijgen.
  const snapshot = await readSkillsSnapshot();
  const subject = request.username ?? (await localPlayerName());
  const skillSource: SourceChoice =
    subject === null
      ? {
          use: "public",
          reason:
            "Geen skill-bron: er is geen `username` meegegeven en er draait geen client " +
            "waaruit af te leiden is over wie de vraag gaat. Skill-eisen blijven onbekend.",
          snapshotAgeSeconds: snapshot?.ageSeconds ?? null,
        }
      : await chooseSource(subject, snapshot?.ageSeconds ?? null);

  const useSnapshot = skillSource.use === "snapshot" && snapshot !== null;
  const skillLevels = useSnapshot ? snapshot : null;

  // Zijn beide bronnen er, dan wordt het verschil gemeld in plaats van stil overschreven.
  // Extra kosten zijn er niet: de hiscores waren toch al opgehaald als er een `username`
  // meegegeven is.
  const skillDifferences: string[] = [];
  if (useSnapshot && hiscores !== null) {
    for (const entry of hiscores.skills) {
      if (entry.name === "Overall" || entry.level === null) continue;
      const mine = snapshot!.skills[entry.name.toUpperCase()];
      if (mine !== undefined && mine.level !== entry.level) {
        skillDifferences.push(
          `${entry.name}: de hiscores zeggen level ${entry.level}, de client ${mine.level}`,
        );
      }
    }
  }

  const checks: RecipeCheck[] = lookup.recipes.map((recipe) => {
    const outputPerRun = recipe.outputQuantity ?? 1;
    // Bij een recept dat er twee tegelijk maakt, hoef je het maar de helft zo
    // vaak te doen. Naar boven: een halve keer bestaat niet.
    const batches = Math.max(1, Math.ceil(request.quantity / (outputPerRun > 0 ? outputPerRun : 1)));

    const materials = recipe.materials.map((material) =>
      checkMaterial(
        material,
        batches,
        holdings,
        sourcesIncomplete,
        index.byName.has(material.name.toLowerCase()) ||
          index.byPage.has(material.name.toLowerCase()),
      ),
    );
    const skills = checkSkills(recipe, hiscores, skillLevels);

    const uncertain =
      sourcesIncomplete || materials.some((material) => material.status === "onbekend");

    return {
      recipe,
      batches,
      materials,
      skills,
      complete: materials.every((material) => material.status === "genoeg"),
      uncertain,
    };
  });

  return {
    requestedItem: request.item,
    requestedQuantity: request.quantity,
    lookup,
    sources,
    index: { idCount: index.idCount, builtAt: index.builtAt },
    holdings,
    unlinked: holdings.filter((holding) => holding.method === "unlinked"),
    weakLinks: holdings.filter(
      (holding) => holding.method === "noted" || holding.method === "name",
    ),
    checks,
    skills: hiscores,
    skillsError,
    skillSource,
    skillDifferences,
  };
}
