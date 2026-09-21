/**
 * De taakdefinitie uit het Stapcontract §8: wat er in `tasks/<id>.json` mag staan.
 *
 * Dit is de pure kant, naar het voorbeeld van `condition.ts` en `run.ts`: geen I/O,
 * alleen structuur beoordelen. Twee dingen die wél iets van de buitenwereld nodig
 * hebben — een relatief XP-doel omrekenen, en de bankstap-regel op de items —
 * gebeuren niet hier maar in de toollaag (`tasktools.ts`), net zoals `set_step` de
 * XP-omrekening in `index.ts` doet en niet in `condition.ts`.
 *
 * **Waarom net zo streng als `set_step`.** Claude stelt de taak zelf op en niemand
 * leest hem na. Dezelfde afweging als bij een conditie: een afgekeurd veld kost één
 * correctieronde, een stilzwijgend verkeerd veld kost een taak die de plugin nooit
 * goed kan uitvoeren.
 */

import {
  MAX_COMBINATOR_DEPTH,
  MAX_LEAF_COUNT,
  validateCondition,
  type Condition,
  type ConditionProblem,
} from "./condition.js";
import { nearestLandmark } from "./landmarks.js";

/** Contract §8: minstens één stap, geen bovengrens genoemd. Zestig is dezelfde grens
 * als het plan van het (vervallen) run-bestand in `runtools.ts` — een taak van meer
 * dan zestig stappen is geen taak meer maar een hele avond, en is met meerdere taken
 * beter te overzien. Eigen keuze, niet uit het contract. */
export const MAX_STEPS = 60;

/** Evenveel als een inventory aan slots heeft; meer items in één stap is geen
 * boodschappenlijst meer maar een tweede stap. Eigen keuze. */
export const MAX_ITEMS_PER_STEP = 28;

/** Hoeveel tiles een bestemming van een bank-landmark mag liggen om nog als "stuurt
 * naar een bank" te tellen. Een bank beslaat meerdere tegels (zie `landmarks.ts`);
 * dit is ruim genoeg voor elke tegel van eenzelfde bank en streng genoeg om een
 * bestemming "in de buurt van" een bank niet mee te tellen. Eigen keuze, want het
 * contract legt niet vast hoe een stap "naar een bank stuurt" herkend wordt. */
export const BANK_DESTINATION_TILES = 5;

export interface TaskDestination {
  x: number;
  y: number;
  plane: number;
  label?: string;
}

export interface TaskItem {
  itemId: number;
  quantity: number;
  name?: string;
}

export interface TaskStep {
  instruction: string;
  destination: TaskDestination | null;
  items: TaskItem[];
  condition: Condition | null;
}

export interface TaskDefinition {
  id: string;
  goal: string;
  createdAt: string;
  steps: TaskStep[];
}

export interface OwnershipCheck {
  stepIndex: number;
  item: TaskItem;
}

export type TaskValidationResult =
  | {
      ok: true;
      steps: TaskStep[];
      /** Items die geen voorafgaande bankstap hebben en dus tegen bezit getoetst
       * moeten worden — de toollaag doet die toets, want die heeft de snapshots nodig. */
      ownershipChecks: OwnershipCheck[];
    }
  | { ok: false; problems: ConditionProblem[] };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const describe = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "een lijst";
  return typeof value;
};

class Collector {
  readonly problems: ConditionProblem[] = [];
  add(path: string, message: string): void {
    this.problems.push({ path, message });
  }
}

const requireInteger = (
  collector: Collector,
  path: string,
  field: string,
  value: unknown,
  options: { min?: number; max?: number } = {},
): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    collector.add(`${path}.${field}`, `moet een getal zijn, maar is ${describe(value)}`);
    return null;
  }
  if (!Number.isInteger(value)) {
    collector.add(`${path}.${field}`, `moet een geheel getal zijn, maar is ${value}`);
    return null;
  }
  if (options.min !== undefined && value < options.min) {
    collector.add(`${path}.${field}`, `mag niet kleiner zijn dan ${options.min}, maar is ${value}`);
    return null;
  }
  if (options.max !== undefined && value > options.max) {
    collector.add(`${path}.${field}`, `mag niet groter zijn dan ${options.max}, maar is ${value}`);
    return null;
  }
  return value;
};

const requireString = (
  collector: Collector,
  path: string,
  field: string,
  value: unknown,
  options: { min?: number; max?: number } = {},
): string | null => {
  if (typeof value !== "string") {
    collector.add(`${path}.${field}`, `moet een tekst zijn, maar is ${describe(value)}`);
    return null;
  }
  const trimmed = value.trim();
  if (options.min !== undefined && trimmed.length < options.min) {
    collector.add(`${path}.${field}`, "mag niet leeg zijn");
    return null;
  }
  if (options.max !== undefined && trimmed.length > options.max) {
    collector.add(
      `${path}.${field}`,
      `mag hoogstens ${options.max} tekens zijn, maar is ${trimmed.length}`,
    );
    return null;
  }
  return trimmed;
};

const optionalString = (
  collector: Collector,
  path: string,
  field: string,
  value: unknown,
  options: { min?: number; max?: number } = {},
): string | undefined | null => {
  if (value === undefined) return undefined;
  return requireString(collector, path, field, value, options);
};

const DESTINATION_FIELDS = new Set(["x", "y", "plane", "label"]);
const ITEM_FIELDS = new Set(["itemId", "quantity", "name"]);
const STEP_FIELDS = new Set(["instruction", "destination", "items", "condition"]);

const checkUnknownFields = (collector: Collector, path: string, value: Record<string, unknown>, known: Set<string>): void => {
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      collector.add(`${path}.${key}`, `is geen veld dat hier bekend is. Toegestaan: ${[...known].join(", ")}.`);
    }
  }
};

/**
 * De drie validators hieronder (destination, items, stap) geven **altijd** een
 * bruikbare placeholder terug, ook als er iets mis is — een weggelaten veld en een
 * afgekeurd veld zien er in de returnwaarde dus hetzelfde uit. Of een stap echt
 * geldig is, staat niet in wat deze functies teruggeven maar in `collector.problems`:
 * de aanroeper vergelijkt de lengte vóór en ná. Eerder gaf een weggelaten
 * `destination` hier `undefined` terug — bedoeld als "niets ingevuld, en dat mag" —
 * terwijl `validateStep` datzelfde `undefined` ook las als "afgekeurd", en verwierp
 * dan een stap zonder dat er ook maar één problem was toegevoegd. Vandaar deze vorm.
 */
const validateDestination = (
  collector: Collector,
  path: string,
  value: unknown,
): TaskDestination | null => {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) {
    collector.add(path, `moet een object zijn, null, of weggelaten, maar is ${describe(value)}`);
    return null;
  }
  checkUnknownFields(collector, path, value, DESTINATION_FIELDS);

  const x = requireInteger(collector, path, "x", value["x"], { min: 0 });
  const y = requireInteger(collector, path, "y", value["y"], { min: 0 });
  const plane = requireInteger(collector, path, "plane", value["plane"], { min: 0, max: 3 });
  const label = optionalString(collector, path, "label", value["label"], { min: 1, max: 120 });

  if (x === null || y === null || plane === null || label === null) return null;
  return label === undefined ? { x, y, plane } : { x, y, plane, label };
};

const validateItems = (collector: Collector, path: string, value: unknown): TaskItem[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    collector.add(path, `moet een lijst zijn, maar is ${describe(value)}`);
    return [];
  }
  if (value.length > MAX_ITEMS_PER_STEP) {
    collector.add(
      path,
      `bevat ${value.length} item(s), en dat zijn er meer dan ${MAX_ITEMS_PER_STEP}. Splits dit in meer stappen.`,
    );
    return [];
  }

  const items: TaskItem[] = [];
  value.forEach((entry, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isPlainObject(entry)) {
      collector.add(itemPath, `moet een object zijn, maar is ${describe(entry)}`);
      return;
    }
    checkUnknownFields(collector, itemPath, entry, ITEM_FIELDS);

    const itemId = requireInteger(collector, itemPath, "itemId", entry["itemId"], { min: 0 });
    const quantity =
      entry["quantity"] === undefined
        ? 1
        : requireInteger(collector, itemPath, "quantity", entry["quantity"], { min: 1 });
    const name = optionalString(collector, itemPath, "name", entry["name"], { min: 1, max: 120 });

    if (itemId === null || quantity === null || name === null) return;
    items.push(name === undefined ? { itemId, quantity } : { itemId, quantity, name });
  });

  return items;
};

/**
 * Of een stap "naar een bank stuurt" — de voorwaarde uit §8 die een spullen-stap
 * ervoor vrijstelt van de bezitscontrole. Herkend via de bestaande landmarktabel in
 * plaats van tekst in `label`: dat is dezelfde bron als `find_destination` gebruikt
 * en dus geen los te onderhouden woordenlijst.
 */
export const isBankDestination = (destination: TaskDestination | null): boolean => {
  if (destination === null) return false;
  const landmark = nearestLandmark(destination.x, destination.y, destination.plane);
  return landmark !== null && landmark.category === "bank" && landmark.tiles <= BANK_DESTINATION_TILES;
};

const validateStep = (
  collector: Collector,
  path: string,
  value: unknown,
): TaskStep | undefined => {
  if (!isPlainObject(value)) {
    collector.add(path, `moet een object zijn, maar is ${describe(value)}`);
    return undefined;
  }

  const startCount = collector.problems.length;

  checkUnknownFields(collector, path, value, STEP_FIELDS);

  const instruction = requireString(collector, path, "instruction", value["instruction"], {
    min: 1,
    max: 500,
  });
  const destination = validateDestination(collector, `${path}.destination`, value["destination"]);
  const items = validateItems(collector, `${path}.items`, value["items"]);

  // `condition` moet als veld aanwezig zijn (de waarde mag null zijn) — zie §8.
  let condition: Condition | null = null;
  if (!("condition" in value)) {
    collector.add(
      path,
      "mist het verplichte veld `condition` (geef `null` als de stap niet machinaal te detecteren is)",
    );
  } else {
    const rawCondition = value["condition"];
    if (rawCondition !== null) {
      const result = validateCondition(rawCondition);
      if (!result.ok) {
        for (const problem of result.problems) {
          // validateCondition prefixt paden altijd met "condition"; hier vervangen
          // door het pad van déze stap, zodat een taak met meerdere condities niet
          // met identieke paden terugkomt.
          collector.add(problem.path.replace(/^condition/, `${path}.condition`), problem.message);
        }
      } else {
        condition = result.condition;
      }
    }
  }

  if (collector.problems.length > startCount) return undefined;

  return {
    instruction: instruction!,
    destination,
    items,
    condition,
  };
};

/**
 * Keurt de `steps`-lijst van een taak, of weigert hem met alles wat er mis is.
 *
 * Levert bij goedkeuring ook de lijst met items op die nog tegen bezit getoetst
 * moeten worden — elk item in een stap zonder voorafgaande bankstap. De toets zelf
 * (de snapshots lezen) hoort in de toollaag thuis, niet hier.
 */
export const validateTaskSteps = (value: unknown): TaskValidationResult => {
  const collector = new Collector();

  if (!Array.isArray(value)) {
    collector.add("steps", `moet een lijst zijn, maar is ${describe(value)}`);
    return { ok: false, problems: collector.problems };
  }
  if (value.length === 0) {
    collector.add("steps", "heeft minstens één stap nodig");
    return { ok: false, problems: collector.problems };
  }
  if (value.length > MAX_STEPS) {
    collector.add(
      "steps",
      `heeft ${value.length} stappen, en dat zijn er meer dan ${MAX_STEPS}. Splits dit in meerdere taken.`,
    );
    return { ok: false, problems: collector.problems };
  }

  const steps: TaskStep[] = [];
  value.forEach((raw, index) => {
    const step = validateStep(collector, `steps[${index}]`, raw);
    if (step !== undefined) steps.push(step);
  });

  if (collector.problems.length > 0) return { ok: false, problems: collector.problems };

  const ownershipChecks: OwnershipCheck[] = [];
  let sawBankStep = false;
  steps.forEach((step, index) => {
    if (isBankDestination(step.destination)) sawBankStep = true;
    if (step.items.length > 0 && !sawBankStep) {
      for (const item of step.items) ownershipChecks.push({ stepIndex: index, item });
    }
  });

  return { ok: true, steps, ownershipChecks };
};

/** Voor de melding in het antwoord van `create_task`. */
export const countTaskLeaves = (steps: TaskStep[]): number =>
  steps.reduce((total, step) => total + (step.condition === null ? 0 : countLeavesOf(step.condition)), 0);

const countLeavesOf = (condition: Condition): number => {
  if (condition.type === "all" || condition.type === "any") {
    return condition.of.reduce((total, child) => total + countLeavesOf(child), 0);
  }
  if (condition.type === "not") return countLeavesOf(condition.of);
  return 1;
};

/** Genereert een leesbare slug uit het doel, voor de bestandsnaam en het `id`-veld. */
export const slugify = (text: string): string => {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "taak";
};

/** `<datum>-<slug>`, met een oplopend achtervoegsel bij een botsing. */
export const uniqueTaskId = (date: string, goal: string, existingIds: readonly string[]): string => {
  const base = `${date}-${slugify(goal)}`;
  const taken = new Set(existingIds);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
};

export { MAX_COMBINATOR_DEPTH, MAX_LEAF_COUNT };
