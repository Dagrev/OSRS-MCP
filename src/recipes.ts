/**
 * Recepten van de OSRS Wiki: wat heb je nodig om iets te maken.
 *
 * Bron is de Bucket-tabel `recipe`, die `{{Recipe}}` vult. Eén rij per manier
 * om een item te maken; de inhoud zit in `production_json`, dat net als
 * `drop_json` `index: false` is en dus niet te filteren.
 *
 * Filteren gaat daarom op `page_name` — en dat werkt, want `{{Recipe}}` staat
 * op de pagina van het *resultaat*. "Hoe maak ik X" is dus: alle rijen met
 * `page_name = X`. De omgekeerde richting bestaat ook: `uses_material` is een
 * gewoon filterbaar veld, zodat "waar kan ik dit voor gebruiken" mogelijk is —
 * die kant is hier bewust nog niet ingebouwd, er is geen ticket voor.
 *
 * Geverifieerd tegen de live wiki op 2026-09-18.
 */

import { WikiError, asList, asText, assertSafeName, isRecord, runBucket } from "./bucket.js";
import { loadItemIndex } from "./itemindex.js";

export interface RecipeMaterial {
  name: string;
  /**
   * Het aantal als getal. Kan een breuk zijn: sommige recepten noteren een
   * gemiddelde per handeling (0,46 van iets), niet een vast aantal.
   */
  quantity: number | null;
  /** Wat er letterlijk stond, voor het geval het geen getal was. */
  rawQuantity: string | null;
}

export interface RecipeSkill {
  name: string;
  level: number | null;
  experience: number | null;
  boostable: boolean | null;
}

export interface Recipe {
  /** De wiki-pagina waar dit recept op staat. */
  pageName: string;
  /** Wat het oplevert; heet lang niet altijd hetzelfde als de pagina. */
  outputName: string;
  outputQuantity: number | null;
  /** De methode, als de wiki er meerdere op één pagina zet ("Plank Make"). */
  method: string | null;
  materials: RecipeMaterial[];
  tools: string[];
  facilities: string[];
  skills: RecipeSkill[];
  membersOnly: boolean | null;
}

export interface RecipeLookup {
  requestedName: string;
  /** De paginanaam waarop uiteindelijk gevonden is. */
  resolvedPage: string;
  /** Gezet als de invoer via de item-index naar een andere pagina leidde. */
  resolvedVia: string | null;
  recipes: Recipe[];
  cached: boolean;
}

const RECIPE_FIELDS = [
  "page_name",
  "uses_material",
  "uses_tool",
  "uses_facility",
  "uses_skill",
  "is_members_only",
  "source_template",
  "production_json",
] as const;

/** Lege strings zijn hoe de wiki "geen gereedschap" opschrijft, niet een tool. */
const cleanList = (value: unknown): string[] =>
  asList(value).filter((entry) => entry.trim() !== "");

const asQuantity = (value: unknown): { quantity: number | null; raw: string | null } => {
  const raw = typeof value === "string" ? value.trim() : null;
  if (raw === null || raw === "") return { quantity: null, raw: null };
  const parsed = Number(raw.replace(/,/g, ""));
  return { quantity: Number.isFinite(parsed) ? parsed : null, raw };
};

const readRecipe = (row: Record<string, unknown>): Recipe | null => {
  const raw = asText(row.production_json);
  if (raw === null) return null;

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;

  const pageName = asText(row.page_name) ?? "(onbekende pagina)";
  const output = isRecord(data.output) ? data.output : {};
  const outputQuantity = asQuantity(output.quantity);

  const materials: RecipeMaterial[] = (Array.isArray(data.materials) ? data.materials : [])
    .filter(isRecord)
    .map((material) => {
      const { quantity, raw: rawQuantity } = asQuantity(material.quantity);
      return {
        name: asText(material.name) ?? "(onbekend materiaal)",
        quantity,
        rawQuantity,
      };
    })
    .filter((material) => material.name !== "(onbekend materiaal)");

  const skills: RecipeSkill[] = (Array.isArray(data.skills) ? data.skills : [])
    .filter(isRecord)
    .map((skill) => {
      const boostable = asText(skill.boostable);
      return {
        name: asText(skill.name) ?? "(onbekende skill)",
        level: asQuantity(skill.level).quantity,
        experience: asQuantity(skill.experience).quantity,
        boostable: boostable === null ? null : /^yes$/i.test(boostable),
      };
    })
    .filter((skill) => skill.name !== "(onbekende skill)");

  return {
    pageName,
    outputName: asText(output.name) ?? pageName,
    outputQuantity: outputQuantity.quantity,
    // `subtxt` onderscheidt de manieren op één pagina: "Sawmill", "Plank Make".
    method: asText(output.subtxt),
    materials,
    tools: cleanList(row.uses_tool),
    facilities: cleanList(row.uses_facility),
    skills,
    membersOnly: typeof data.members === "boolean" ? data.members : null,
  };
};

const RECIPE_LIMIT = 50;

const queryPage = async (
  page: string,
): Promise<{ recipes: Recipe[]; cached: boolean }> => {
  const { rows, cached } = await runBucket({
    table: "recipe",
    select: [...RECIPE_FIELDS],
    where: [["page_name", page]],
    limit: RECIPE_LIMIT,
  });
  return {
    recipes: rows.map(readRecipe).filter((recipe): recipe is Recipe => recipe !== null),
    cached,
  };
};

/**
 * Recepten voor een item ophalen.
 *
 * De invoer is een naam uit een gesprek, dus niet per se een paginanaam. Er
 * zijn twee stappen: eerst de naam zelf als pagina proberen, en pas als dat
 * niets oplevert de item-index raadplegen om van een itemnaam naar de pagina
 * te komen. "Super attack(4)" is zo'n geval — dat is een itemnaam, de pagina
 * heet "Super attack".
 */
export async function fetchRecipes(name: string): Promise<RecipeLookup> {
  const wanted = assertSafeName(name, "itemnaam");

  /**
   * Een pagina met doses zet vier recepten naast elkaar. Vroeg de gebruiker om
   * een specifieke dosis, dan hoort dát recept bovenaan — anders leest het
   * antwoord als "je komt tekort" terwijl het gevraagde recept verderop op
   * "genoeg" staat.
   */
  const preferRequested = (recipes: Recipe[]): Recipe[] =>
    [...recipes].sort(
      (a, b) =>
        Number(b.outputName.toLowerCase() === wanted.toLowerCase()) -
        Number(a.outputName.toLowerCase() === wanted.toLowerCase()),
    );

  const direct = await queryPage(wanted);
  if (direct.recipes.length > 0) {
    return {
      requestedName: wanted,
      resolvedPage: wanted,
      resolvedVia: null,
      recipes: preferRequested(direct.recipes),
      cached: direct.cached,
    };
  }

  const index = await loadItemIndex();
  const candidates = index.byName.get(wanted.toLowerCase()) ?? [];
  const pages = [...new Set(candidates.map((candidate) => candidate.pageName))].filter(
    (page) => page.toLowerCase() !== wanted.toLowerCase(),
  );

  for (const page of pages.slice(0, 5)) {
    const result = await queryPage(page);
    if (result.recipes.length > 0) {
      return {
        requestedName: wanted,
        resolvedPage: page,
        resolvedVia:
          `"${wanted}" is een itemnaam, geen paginanaam; het recept staat op ` +
          `de pagina "${page}".`,
        recipes: preferRequested(result.recipes),
        cached: result.cached,
      };
    }
  }

  // Bewust geen WikiNotFoundError met zoeksuggesties: het onderscheid dat hier
  // telt is "bestaat niet" versus "bestaat wel, maar is niet te maken", en dat
  // laatste is bij een item vaker het geval dan het eerste.
  const known = candidates.length > 0 || index.byPage.has(wanted.toLowerCase());
  throw new WikiError(
    known
      ? `De wiki kent "${wanted}" als item, maar er staat geen recept bij: er is ` +
        "geen manier om het te maken. Zulke items komen uit een drop, een winkel, " +
        "een quest of een activiteit. Gebruik `get_drop_table` om te zien welk " +
        "monster het laat vallen."
      : `Geen recept gevonden voor "${wanted}". Controleer de naam — gebruik de ` +
        "naam zoals hij in het spel of op de wiki staat, inclusief eventuele dosis " +
        'tussen haakjes zoals "Super attack(4)".',
  );
}
