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

/** Een `noTravel`-reden is kort: "zelfde plek als vorige stap". Contract §8. */
export const MAX_NO_TRAVEL_LENGTH = 120;

/** Contract §8.1: `label` van een herhaalblok, 1 tot 60 tekens. */
export const MAX_REPEAT_LABEL_LENGTH = 60;

/** Bovengrens op `maxRounds`. Het contract noemt er geen; duizend rondes is een hele
 * week spelen, dus wat daarboven zit is geen noodrem meer maar een tikfout. Eigen keuze. */
export const MAX_ROUNDS_LIMIT = 1000;

export interface TaskStep {
  instruction: string;
  destination: TaskDestination | null;
  /** Alleen bij `destination: null` — waarom deze stap geen reis is (contract §8). */
  noTravel?: string;
  items: TaskItem[];
  condition: Condition | null;
}

/** Het herhaalblok uit contract §8.1: één niveau, alleen gewone stappen erin. */
export interface TaskRepeat {
  type: "repeat";
  label?: string;
  steps: TaskStep[];
  until: Condition;
  maxRounds?: number;
}

export type TaskElement = TaskStep | TaskRepeat;

export const isRepeat = (element: TaskElement): element is TaskRepeat =>
  "type" in element && element.type === "repeat";

export interface TaskDefinition {
  id: string;
  goal: string;
  createdAt: string;
  steps: TaskElement[];
}

/** Een gewone stap met zijn plek in de taak: "3" voor een losse stap, "2.1" voor de
 * eerste stap in het blok dat element 2 is. Voor meldingen en waarschuwingen. */
export interface PlacedStep {
  step: TaskStep;
  label: string;
  /** Het pad zoals in een weigering: `steps[1].steps[0]`. */
  path: string;
  /** Index van het blok als deze stap in een blok staat, anders `null`. */
  blockIndex: number | null;
}

export interface OwnershipCheck {
  stepLabel: string;
  item: TaskItem;
}

export type TaskValidationResult =
  | {
      ok: true;
      steps: TaskElement[];
      /** Items die geen voorafgaande bankstap hebben en dus tegen bezit getoetst
       * moeten worden — de toollaag doet die toets, want die heeft de snapshots nodig. */
      ownershipChecks: OwnershipCheck[];
      /** Opmerkingen over de opbouw van het plan die geen weigering zijn: dezelfde
       * bestemming twee keer achter elkaar, geen afronding na het laatste blok. */
      warnings: string[];
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
const STEP_FIELDS = new Set(["instruction", "destination", "noTravel", "items", "condition"]);
const REPEAT_FIELDS = new Set(["type", "label", "steps", "until", "maxRounds"]);

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

  // Contract §8 (sinds OSC-012): `destination` moet er staan. Een lege bestemming
  // betekende eerder stilzwijgend "zelfde plek", en daardoor gaf een bankstap op
  // 2026-09-21 geen lijn. Nu is "geen reis" een benoemde keuze.
  let destination: TaskDestination | null = null;
  let noTravel: string | undefined;
  if (!("destination" in value)) {
    collector.add(
      path,
      "mist het verplichte veld `destination`. Geef een coördinaat (zoek hem op met " +
        "`find_destination`), of `destination: null` met een korte `noTravel`-reden als " +
        "deze stap echt geen reis is.",
    );
  } else {
    destination = validateDestination(collector, `${path}.destination`, value["destination"]);
    const rawNoTravel = value["noTravel"];
    if (value["destination"] === null) {
      if (rawNoTravel === undefined) {
        collector.add(
          `${path}.destination`,
          "is null zonder `noTravel`-reden. Zeg waarom deze stap geen reis is " +
            '("zelfde plek als vorige stap"), of geef een coördinaat.',
        );
      } else {
        noTravel =
          requireString(collector, path, "noTravel", rawNoTravel, { min: 1, max: MAX_NO_TRAVEL_LENGTH }) ??
          undefined;
      }
    } else if (rawNoTravel !== undefined) {
      collector.add(
        `${path}.noTravel`,
        "hoort alleen bij `destination: null`; deze stap heeft een bestemming.",
      );
    }
  }

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
      condition = validateConditionAt(collector, `${path}.condition`, rawCondition);
    }
  }

  if (collector.problems.length > startCount) return undefined;

  const step: TaskStep = { instruction: instruction!, destination, items, condition };
  if (noTravel !== undefined) step.noTravel = noTravel;
  return step;
};

/** `validateCondition` prefixt paden altijd met "condition"; hier vervangen door het
 * echte pad, zodat een taak met meerdere condities niet met identieke paden terugkomt. */
const validateConditionAt = (collector: Collector, path: string, raw: unknown): Condition | null => {
  const result = validateCondition(raw);
  if (!result.ok) {
    for (const problem of result.problems) {
      collector.add(problem.path.replace(/^condition/, path), problem.message);
    }
    return null;
  }
  return result.condition;
};

/** Het herhaalblok uit contract §8.1. Geeft `undefined` bij elke afgekeurde waarde. */
const validateRepeat = (
  collector: Collector,
  path: string,
  value: Record<string, unknown>,
): TaskRepeat | undefined => {
  const startCount = collector.problems.length;

  checkUnknownFields(collector, path, value, REPEAT_FIELDS);

  const label = optionalString(collector, path, "label", value["label"], {
    min: 1,
    max: MAX_REPEAT_LABEL_LENGTH,
  });

  let maxRounds: number | undefined;
  if (value["maxRounds"] !== undefined) {
    maxRounds =
      requireInteger(collector, path, "maxRounds", value["maxRounds"], { min: 1, max: MAX_ROUNDS_LIMIT }) ??
      undefined;
  }

  let until: Condition | null = null;
  if (!("until" in value) || value["until"] === null) {
    collector.add(
      `${path}.until`,
      "is verplicht en mag niet null zijn: een blok zonder stopvoorwaarde loopt nooit af. " +
        "Gebruik het doel, bijvoorbeeld `{ \"type\": \"skillLevel\", \"skill\": \"WOODCUTTING\", \"minLevel\": 48 }`.",
    );
  } else {
    until = validateConditionAt(collector, `${path}.until`, value["until"]);
  }

  const rawSteps = value["steps"];
  const steps: TaskStep[] = [];
  if (!Array.isArray(rawSteps)) {
    collector.add(`${path}.steps`, `moet een lijst zijn, maar is ${describe(rawSteps)}`);
  } else if (rawSteps.length === 0) {
    collector.add(`${path}.steps`, "heeft minstens één stap nodig");
  } else {
    rawSteps.forEach((raw, index) => {
      const innerPath = `${path}.steps[${index}]`;
      if (isPlainObject(raw) && "type" in raw) {
        collector.add(
          `${innerPath}.type`,
          raw["type"] === "repeat"
            ? "een herhaalblok in een herhaalblok kan niet: blokken nestelen niet (contract " +
                "§8.1). Zet het tweede blok ná dit blok, of maak van de binnenste herhaling " +
                "één stap met een conditie op het resultaat."
            : "is geen veld van een gewone stap. Alleen een herhaalblok heeft `type`, en dat " +
                "kan binnen een blok niet.",
        );
        return;
      }
      const step = validateStep(collector, innerPath, raw);
      if (step !== undefined) steps.push(step);
    });
  }

  if (collector.problems.length > startCount) return undefined;

  const repeat: TaskRepeat = { type: "repeat", steps, until: until! };
  if (label !== undefined && label !== null) repeat.label = label;
  if (maxRounds !== undefined) repeat.maxRounds = maxRounds;
  return repeat;
};

const validateElement = (collector: Collector, path: string, value: unknown): TaskElement | undefined => {
  if (isPlainObject(value) && "type" in value) {
    if (value["type"] === "repeat") return validateRepeat(collector, path, value);
    collector.add(
      `${path}.type`,
      `is ${JSON.stringify(value["type"])}, maar het enige type is \`"repeat"\` (een ` +
        "herhaalblok). Een gewone stap heeft geen `type`.",
    );
    return undefined;
  }
  return validateStep(collector, path, value);
};

/** Alle gewone stappen in uitvoervolgorde van de eerste ronde, met hun plek. */
export const placedSteps = (elements: readonly TaskElement[]): PlacedStep[] => {
  const placed: PlacedStep[] = [];
  elements.forEach((element, index) => {
    if (isRepeat(element)) {
      element.steps.forEach((step, inner) => {
        placed.push({
          step,
          label: `${index + 1}.${inner + 1}`,
          path: `steps[${index}].steps[${inner}]`,
          blockIndex: index,
        });
      });
    } else {
      placed.push({ step: element, label: `${index + 1}`, path: `steps[${index}]`, blockIndex: null });
    }
  });
  return placed;
};

/** Alle condities in een taak, met hun pad — voor wie over elke conditie moet lopen
 * (de XP-omrekening in de toollaag). */
export const conditionsOf = (elements: readonly TaskElement[]): { path: string; condition: Condition }[] => {
  const found: { path: string; condition: Condition }[] = [];
  elements.forEach((element, index) => {
    if (isRepeat(element)) found.push({ path: `steps[${index}].until`, condition: element.until });
  });
  for (const placed of placedSteps(elements)) {
    if (placed.step.condition !== null) found.push({ path: `${placed.path}.condition`, condition: placed.step.condition });
  }
  return found;
};

const containsSkillLeaf = (condition: Condition): boolean => {
  if (condition.type === "all" || condition.type === "any") return condition.of.some(containsSkillLeaf);
  if (condition.type === "not") return containsSkillLeaf(condition.of);
  return condition.type === "skillLevel" || condition.type === "skillXp";
};

const SKILL_GOAL_EXPLANATION =
  "Een skilldoel is een cyclus, geen enkele stap: doen tot de inventory vol is → de " +
  "opbrengst weg (bank, verbranden, fletchen of droppen) → terug, tot het doel gehaald " +
  'is. Schrijf dat als herhaalblok: `{ "type": "repeat", "until": <deze conditie>, ' +
  '"steps": [<doe-stap tot de inventory vol is>, <opbrengst-stap>] }`, met daarvoor de ' +
  "voorbereiding en erna een afronding. Heeft de cyclus echt geen opbrengst (een " +
  "Agility-rondje), dan is het een blok met één stap en `until` op het level — ook dat " +
  "herhaalt. Deze controle is een vuistregel; zie de prompt `plan_task`.";

/**
 * Plancontrole (ORS-030): een `skillLevel`- of `skillXp`-conditie op een gewone stap
 * buiten een blok is de vorm van het plan van 2026-09-21 dat de bankstappen oversloeg.
 * Dat is een heuristiek — er zijn skilldoelen zonder cyclus — maar ook die zijn in de
 * vorm van een blok te schrijven, dus weigeren kost niets dat niet te herstellen is.
 */
const checkSkillGoalsInBlocks = (collector: Collector, elements: readonly TaskElement[]): void => {
  elements.forEach((element, index) => {
    if (isRepeat(element) || element.condition === null) return;
    if (containsSkillLeaf(element.condition)) {
      collector.add(
        `steps[${index}].condition`,
        `toetst een skilldoel op een losse stap. ${SKILL_GOAL_EXPLANATION}`,
      );
    }
  });
};

const sameDestination = (a: TaskDestination | null, b: TaskDestination | null): boolean =>
  a !== null && b !== null && a.x === b.x && a.y === b.y && a.plane === b.plane;

/**
 * Waarschuwingen over de opbouw — geen weigering, wel iets om de speler te laten zien.
 *
 * **Dezelfde bestemming twee keer achter elkaar:** Shortest Path tekent niets bij een
 * pad van nul tiles, dus de tweede stap krijgt geen lijn. Vergeleken worden de paren
 * die gegarandeerd na elkaar komen: losse stappen onderling, de stap vóór een blok met
 * de eerste stap erin, stappen binnen een blok, en de laatste stap van een blok met de
 * eerste (de volgende ronde). Níet de overgang uit een blok: dat blok kan na elke stap
 * sluiten (contract §8.1), dus de stap erna volgt niet vast op de laatste stap in het
 * blok. Het contractvoorbeeld heeft daar juist bank → bank, en dat is goed.
 *
 * **Geen afronding na het laatste blok:** de opbrengst van de laatste ronde blijft
 * dan liggen.
 */
const planWarnings = (elements: readonly TaskElement[]): string[] => {
  const warnings: string[] = [];
  const warnSame = (a: PlacedStep, b: PlacedStep): void => {
    if (sameDestination(a.step.destination, b.step.destination)) {
      warnings.push(
        `stap ${a.label} en ${b.label} hebben dezelfde bestemming ` +
          `(${b.step.destination!.label ?? `${b.step.destination!.x}, ${b.step.destination!.y}`}); ` +
          "de tweede stap krijgt dan geen lijn. Is dat bedoeld, geef de tweede dan " +
          "`destination: null` met `noTravel`.",
      );
    }
  };

  let previous: PlacedStep | null = null;
  const placed = placedSteps(elements);
  let cursor = 0;
  elements.forEach((element) => {
    if (isRepeat(element)) {
      const inner = placed.slice(cursor, cursor + element.steps.length);
      cursor += element.steps.length;
      if (previous !== null) warnSame(previous, inner[0]!);
      for (let i = 1; i < inner.length; i += 1) warnSame(inner[i - 1]!, inner[i]!);
      if (inner.length > 1) warnSame(inner[inner.length - 1]!, inner[0]!);
      previous = null; // de overgang uit een blok ligt niet vast
    } else {
      const current = placed[cursor]!;
      cursor += 1;
      if (previous !== null) warnSame(previous, current);
      previous = current;
    }
  });

  const lastBlock = elements.map((element) => isRepeat(element)).lastIndexOf(true);
  if (lastBlock !== -1 && lastBlock === elements.length - 1) {
    warnings.push(
      `het plan eindigt met een herhaalblok (stap ${lastBlock + 1}), zonder afronding erna. ` +
        "De opbrengst van de laatste ronde blijft dan liggen. Voeg een stap toe die hem " +
        "wegzet, of een stap met `destination: null` en een `noTravel`-reden als er niets " +
        "af te ronden is.",
    );
  }

  return warnings;
};

/**
 * Keurt de `steps`-lijst van een taak, of weigert hem met alles wat er mis is.
 *
 * Levert bij goedkeuring ook de lijst met items op die nog tegen bezit getoetst
 * moeten worden — elk item in een stap zonder voorafgaande bankstap. De toets zelf
 * (de snapshots lezen) hoort in de toollaag thuis, niet hier. En de waarschuwingen
 * over de opbouw van het plan, die ook geen I/O nodig hebben.
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

  const elements: TaskElement[] = [];
  value.forEach((raw, index) => {
    const element = validateElement(collector, `steps[${index}]`, raw);
    if (element !== undefined) elements.push(element);
  });

  if (collector.problems.length > 0) return { ok: false, problems: collector.problems };

  // Stappen in blokken tellen mee voor de grens: een blok van zestig stappen is net
  // zo onoverzichtelijk als zestig losse.
  const placed = placedSteps(elements);
  if (placed.length > MAX_STEPS) {
    collector.add(
      "steps",
      `heeft ${placed.length} stappen (blokken meegeteld), en dat zijn er meer dan ${MAX_STEPS}. ` +
        "Splits dit in meerdere taken.",
    );
    return { ok: false, problems: collector.problems };
  }

  checkSkillGoalsInBlocks(collector, elements);
  if (collector.problems.length > 0) return { ok: false, problems: collector.problems };

  // De bankstap-regel over de uitvoervolgorde van de eerste ronde: binnen een blok telt
  // een bankstap eerder in dezelfde ronde of vóór het blok (contract §8.1), en een stap
  // die zelf naar een bank stuurt telt voor zijn eigen items.
  const ownershipChecks: OwnershipCheck[] = [];
  let sawBankStep = false;
  for (const { step, label } of placed) {
    if (isBankDestination(step.destination)) sawBankStep = true;
    if (step.items.length > 0 && !sawBankStep) {
      for (const item of step.items) ownershipChecks.push({ stepLabel: label, item });
    }
  }

  return { ok: true, steps: elements, ownershipChecks, warnings: planWarnings(elements) };
};

/**
 * De positie uit een voortgangsbestand in woorden (contract §9 en §12): "stap 3 van 3"
 * voor een gewone stap, "blok 2, ronde 4, stap 1 van 2" in een herhaalblok.
 *
 * Leest ruwe JSON, want zowel de definitie als de voortgang kan van een andere schrijver
 * komen (of van vóór 2026-09-22 zijn). Wat niet klopt wordt geen fout maar valt terug
 * op wat wél te zeggen is. `null` als er geen positie is.
 */
export const describeTaskPosition = (
  rawSteps: readonly unknown[],
  progress: Record<string, unknown> | null,
): string | null => {
  if (progress === null) return null;
  const index = progress["activeStepIndex"];
  if (typeof index !== "number" || !Number.isInteger(index)) return null;

  const base = `stap ${index + 1} van ${rawSteps.length}`;
  const element = rawSteps[index];
  const inner = progress["activeInnerIndex"];
  const round = progress["activeRound"];
  if (
    !isPlainObject(element) ||
    element["type"] !== "repeat" ||
    typeof inner !== "number" ||
    typeof round !== "number"
  ) {
    return base;
  }
  const innerCount = Array.isArray(element["steps"]) ? element["steps"].length : 0;
  return `blok ${index + 1}, ronde ${round}, stap ${inner + 1} van ${innerCount}`;
};

/** Voor de melding in het antwoord van `create_task`. */
export const countTaskLeaves = (elements: readonly TaskElement[]): number =>
  conditionsOf(elements).reduce((total, { condition }) => total + countLeavesOf(condition), 0);

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
