/**
 * Het conditieschema uit het Stapcontract: wat "de stap is uitgevoerd" betekent.
 *
 * Een conditie is een boom. Bladeren beweren één ding over de spelstaat (sta ik daar,
 * heb ik dat, is die quest af); combinatoren (`all`, `any`, `not`) voegen bladeren
 * samen. Deze module doet één ding met zo'n boom: hem **afkeuren als er ook maar iets
 * niet klopt**.
 *
 * Waarom zo streng? Omdat Claude de conditie zelf opstelt en er niemand tussen zit die
 * hem naleest. Een typefout in een veldnaam — `radius` als string, `minQty` in plaats
 * van `minQuantity`, een quest die net anders heet — levert anders een conditie op die
 * er goed uitziet en nooit afgaat. De speler wacht dan tien minuten op een stap die
 * technisch nooit klaar kan zijn. Een afgekeurde conditie kost één correctieronde; een
 * stilzwijgend verkeerde kost het vertrouwen in de hele coach. Vandaar: een onbekend
 * veld is een fout, geen waarschuwing.
 *
 * De evaluator die deze bomen uitrekent staat niet hier maar in het zusterproject
 * (OSC-002). Deze module weet dus wél wat een geldige conditie is en níet wat de
 * spelstaat op dit moment doet — op één plek na: een relatief XP-doel wordt hier
 * omgerekend naar een absolute drempel, omdat dat alleen kan op het moment van
 * schrijven. Zie `normaliseCondition`.
 */

import { QUEST_NAMES, QUEST_SOURCE_VERSION } from "./questdata.js";

/** De 23 skills uit het contract. `OVERALL` hoort er niet bij: dat is een som. */
export const SKILL_NAMES = [
  "ATTACK",
  "DEFENCE",
  "STRENGTH",
  "HITPOINTS",
  "RANGED",
  "PRAYER",
  "MAGIC",
  "COOKING",
  "WOODCUTTING",
  "FLETCHING",
  "FISHING",
  "FIREMAKING",
  "CRAFTING",
  "SMITHING",
  "MINING",
  "HERBLORE",
  "AGILITY",
  "THIEVING",
  "SLAYER",
  "FARMING",
  "RUNECRAFT",
  "HUNTER",
  "CONSTRUCTION",
] as const;

export type SkillName = (typeof SKILL_NAMES)[number];

const SKILL_SET = new Set<string>(SKILL_NAMES);

/** De containers die de plugin wegschrijft. Zelfde drie als `CONTAINERS`. */
export const CONTAINER_NAMES = ["inventory", "bank", "equipment"] as const;

export type ContainerName = (typeof CONTAINER_NAMES)[number];

const CONTAINER_SET = new Set<string>(CONTAINER_NAMES);

/** De drie standen waar een quest in kan staan. Tussenwaarden zijn buiten scope. */
export const QUEST_STATES = ["NOT_STARTED", "IN_PROGRESS", "FINISHED"] as const;

export type QuestState = (typeof QUEST_STATES)[number];

const QUEST_STATE_SET = new Set<string>(QUEST_STATES);

/** Hoogste verdieping in OSRS. */
const MAX_PLANE = 3;

/** Hoogste echte level. Een hogere drempel gaat per definitie nooit af. */
const MAX_LEVEL = 99;

/** Grenzen uit §3.3 van het contract. */
export const MAX_COMBINATOR_DEPTH = 3;
export const MAX_LEAF_COUNT = 16;

export interface PositionCondition {
  type: "position";
  x: number;
  y: number;
  plane: number;
  radius: number;
}

export interface RegionCondition {
  type: "region";
  regionId: number;
}

export interface ItemCondition {
  type: "item";
  container: ContainerName;
  itemId: number;
  name?: string;
  minQuantity?: number;
}

export interface SkillLevelCondition {
  type: "skillLevel";
  skill: SkillName;
  minLevel: number;
}

/**
 * De enige knoop die er anders in gaat dan hij eruit komt.
 *
 * In: `minXp` (absoluut) óf `xpGain` (relatief, "vijftig XP erbij"). Uit: altijd
 * `minXp`, met `baselineXp` en `baselineAt` erbij als er omgerekend is.
 */
export interface SkillXpCondition {
  type: "skillXp";
  skill: SkillName;
  minXp?: number;
  xpGain?: number;
  baselineXp?: number;
  baselineAt?: string;
}

export interface QuestCondition {
  type: "quest";
  quest: string;
  state: QuestState;
}

export interface AllCondition {
  type: "all";
  of: Condition[];
}

export interface AnyCondition {
  type: "any";
  of: Condition[];
}

export interface NotCondition {
  type: "not";
  of: Condition;
}

export type LeafCondition =
  | PositionCondition
  | RegionCondition
  | ItemCondition
  | SkillLevelCondition
  | SkillXpCondition
  | QuestCondition;

export type Condition = LeafCondition | AllCondition | AnyCondition | NotCondition;

/** Eén ding dat er mis is, mét de plek in de boom. */
export interface ConditionProblem {
  /** Waar in de boom, zoals `condition.of[1].radius`. */
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; condition: Condition; leafCount: number }
  | { ok: false; problems: ConditionProblem[] };

/**
 * Welke velden elke knoop kent. Alles wat hier niet in staat wordt geweigerd — dat is
 * de hele reden dat deze tabel bestaat in plaats van een reeks losse `if`-jes.
 */
const FIELDS: Record<string, { required: string[]; optional: string[] }> = {
  position: { required: ["x", "y", "plane", "radius"], optional: [] },
  region: { required: ["regionId"], optional: [] },
  item: { required: ["container", "itemId"], optional: ["name", "minQuantity"] },
  skillLevel: { required: ["skill", "minLevel"], optional: [] },
  // Precies één van minXp en xpGain; dat kan deze tabel niet uitdrukken, dus beide
  // staan als optioneel en de controle erop staat in `checkSkillXp`.
  skillXp: { required: ["skill"], optional: ["minXp", "xpGain"] },
  quest: { required: ["quest", "state"], optional: [] },
  all: { required: ["of"], optional: [] },
  any: { required: ["of"], optional: [] },
  not: { required: ["of"], optional: [] },
};

const NODE_TYPES = Object.keys(FIELDS);

const COMBINATORS = new Set(["all", "any", "not"]);

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

/** Een geheel getal, en niet stiekem een string of een komma-getal. */
const requireInteger = (
  collector: Collector,
  path: string,
  field: string,
  value: unknown,
  options: { min?: number; max?: number; maxHint?: string } = {},
): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    collector.add(
      `${path}.${field}`,
      `moet een getal zijn, maar is ${describe(value)}` +
        (typeof value === "string" ? ` (${JSON.stringify(value)} — zonder aanhalingstekens)` : ""),
    );
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
    collector.add(
      `${path}.${field}`,
      `mag niet groter zijn dan ${options.max}, maar is ${value}` +
        (options.maxHint === undefined ? "" : ` — ${options.maxHint}`),
    );
    return null;
  }
  return value;
};

const requireEnum = <T extends string>(
  collector: Collector,
  path: string,
  field: string,
  value: unknown,
  allowed: Set<string>,
  hint: string,
): T | null => {
  if (typeof value !== "string") {
    collector.add(`${path}.${field}`, `moet een tekst zijn, maar is ${describe(value)}`);
    return null;
  }
  if (!allowed.has(value)) {
    collector.add(`${path}.${field}`, `kent de waarde ${JSON.stringify(value)} niet. ${hint}`);
    return null;
  }
  return value as T;
};

/**
 * Dichtstbijzijnde toegestane waarde, om een typefout bruikbaar te melden.
 *
 * "MINNING kent de waarde niet" helpt half; "bedoelde je MINING?" helpt helemaal. Een
 * kale Levenshtein met een drempel van een derde van de lengte — goed genoeg voor
 * hoofdletterfouten en verwisselde tekens, en het raadt niets bij echt andere woorden.
 */
const closest = (value: string, allowed: Iterable<string>): string | null => {
  const needle = value.toUpperCase();
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of allowed) {
    const distance = levenshtein(needle, candidate.toUpperCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  if (best === null) return null;
  return bestDistance <= Math.max(1, Math.floor(best.length / 3)) ? best : null;
};

const levenshtein = (a: string, b: string): number => {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }

  return previous[b.length]!;
};

const enumHint = (value: unknown, allowed: Iterable<string>, fallback: string): string => {
  if (typeof value === "string") {
    const suggestion = closest(value, allowed);
    if (suggestion !== null) return `Bedoelde je ${JSON.stringify(suggestion)}?`;
  }
  return fallback;
};

/**
 * Precies één van `minXp` en `xpGain`.
 *
 * Allebei mag niet: dan zegt de aanroep twee dingen tegelijk en is niet te zien welke
 * bedoeld is. Geen van beide mag ook niet: dan is er geen drempel.
 */
const checkSkillXp = (collector: Collector, path: string, node: Record<string, unknown>): void => {
  const hasMin = node["minXp"] !== undefined;
  const hasGain = node["xpGain"] !== undefined;

  if (hasMin && hasGain) {
    collector.add(
      path,
      "heeft zowel `minXp` als `xpGain`. Geef er één: `minXp` voor een absolute drempel, " +
        "`xpGain` voor 'zoveel XP erbij vanaf nu'.",
    );
    return;
  }
  if (!hasMin && !hasGain) {
    collector.add(
      path,
      "mist een drempel. Geef `minXp` (absolute XP) of `xpGain` (hoeveel XP erbij moet komen).",
    );
    return;
  }

  if (hasMin) {
    requireInteger(collector, path, "minXp", node["minXp"], { min: 0 });
  } else {
    const gain = requireInteger(collector, path, "xpGain", node["xpGain"], { min: 1 });
    if (gain === null && typeof node["xpGain"] === "number" && node["xpGain"] === 0) {
      // requireInteger heeft dit al gemeld; deze tak bestaat alleen om duidelijk te
      // maken dat 0 bewust geweigerd wordt — een doel van "nul XP erbij" is meteen waar.
    }
  }
};

const validateNode = (
  collector: Collector,
  path: string,
  value: unknown,
  combinatorDepth: number,
  counts: { leaves: number },
): void => {
  if (!isPlainObject(value)) {
    collector.add(path, `moet een object zijn, maar is ${describe(value)}`);
    return;
  }

  const type = value["type"];
  if (typeof type !== "string") {
    collector.add(path, `mist het veld \`type\`${type === undefined ? "" : ` (het is ${describe(type)})`}`);
    return;
  }

  const spec = FIELDS[type];
  if (spec === undefined) {
    collector.add(
      `${path}.type`,
      `kent het soort ${JSON.stringify(type)} niet. ` +
        enumHint(type, NODE_TYPES, `Toegestaan: ${NODE_TYPES.join(", ")}.`),
    );
    return;
  }

  // Onbekende velden. Dit is de controle waar het ticket om vroeg: een `minQty` naast
  // een geldige `type` is precies de fout die anders pas na tien minuten wachten blijkt.
  const known = new Set(["type", ...spec.required, ...spec.optional]);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      collector.add(
        `${path}.${key}`,
        `is geen veld van een ${type}-conditie. ` +
          enumHint(key, [...known].filter((name) => name !== "type"), `Toegestaan: ${[...known].join(", ")}.`),
      );
    }
  }

  for (const field of spec.required) {
    if (value[field] === undefined) {
      collector.add(path, `mist het verplichte veld \`${field}\``);
    }
  }

  const isCombinator = COMBINATORS.has(type);
  if (isCombinator) {
    const depth = combinatorDepth + 1;
    if (depth > MAX_COMBINATOR_DEPTH) {
      collector.add(
        path,
        `zit ${depth} combinatoren diep, en er mogen er hoogstens ${MAX_COMBINATOR_DEPTH} ` +
          "boven elkaar. Moet het dieper, dan beschrijft dit twee stappen in plaats van één.",
      );
      return;
    }

    const of = value["of"];
    if (type === "not") {
      if (of !== undefined) validateNode(collector, `${path}.of`, of, depth, counts);
      return;
    }

    if (!Array.isArray(of)) {
      if (of !== undefined) {
        collector.add(`${path}.of`, `moet een lijst condities zijn, maar is ${describe(of)}`);
      }
      return;
    }
    if (of.length < 2) {
      collector.add(
        `${path}.of`,
        `heeft ${of.length} element(en), en een ${type} heeft er minstens twee nodig. ` +
          "Is er maar één voorwaarde, laat de combinator dan weg.",
      );
    }
    of.forEach((child, index) => {
      validateNode(collector, `${path}.of[${index}]`, child, depth, counts);
    });
    return;
  }

  counts.leaves += 1;
  if (counts.leaves > MAX_LEAF_COUNT) {
    // Eén melding is genoeg; de teller loopt door maar we zeggen het alleen bij de eerste
    // die eroverheen gaat.
    if (counts.leaves === MAX_LEAF_COUNT + 1) {
      collector.add(
        "condition",
        `bevat meer dan ${MAX_LEAF_COUNT} bladeren. Zo'n conditie beschrijft geen stap meer ` +
          "maar een heel plan.",
      );
    }
  }

  switch (type) {
    case "position":
      requireInteger(collector, path, "x", value["x"], { min: 0 });
      requireInteger(collector, path, "y", value["y"], { min: 0 });
      requireInteger(collector, path, "plane", value["plane"], {
        min: 0,
        max: MAX_PLANE,
        maxHint: `OSRS kent de verdiepingen 0 tot en met ${MAX_PLANE}`,
      });
      requireInteger(collector, path, "radius", value["radius"], { min: 0 });
      break;

    case "region":
      requireInteger(collector, path, "regionId", value["regionId"], { min: 0 });
      break;

    case "item":
      requireEnum(
        collector,
        path,
        "container",
        value["container"],
        CONTAINER_SET,
        enumHint(value["container"], CONTAINER_NAMES, `Toegestaan: ${CONTAINER_NAMES.join(", ")}.`),
      );
      requireInteger(collector, path, "itemId", value["itemId"], { min: 0 });
      if (value["name"] !== undefined && typeof value["name"] !== "string") {
        collector.add(`${path}.name`, `moet een tekst zijn, maar is ${describe(value["name"])}`);
      }
      if (value["minQuantity"] !== undefined) {
        requireInteger(collector, path, "minQuantity", value["minQuantity"], { min: 0 });
      }
      break;

    case "skillLevel":
      requireEnum(
        collector,
        path,
        "skill",
        value["skill"],
        SKILL_SET,
        enumHint(value["skill"], SKILL_NAMES, "Skillnamen zijn in hoofdletters, zoals MINING."),
      );
      requireInteger(collector, path, "minLevel", value["minLevel"], {
        min: 0,
        max: MAX_LEVEL,
        maxHint: `een echt level gaat niet hoger dan ${MAX_LEVEL}, dus zo'n drempel gaat nooit af`,
      });
      break;

    case "skillXp":
      requireEnum(
        collector,
        path,
        "skill",
        value["skill"],
        SKILL_SET,
        enumHint(value["skill"], SKILL_NAMES, "Skillnamen zijn in hoofdletters, zoals MINING."),
      );
      checkSkillXp(collector, path, value);
      break;

    case "quest":
      requireEnum(
        collector,
        path,
        "quest",
        value["quest"],
        QUEST_NAMES,
        enumHint(
          value["quest"],
          QUEST_NAMES,
          "Dit is de constante uit RuneLite's Quest-enum (COOKS_ASSISTANT), niet de " +
            `weergavenaam ("Cook's Assistant"). Lijst uit runelite-api ${QUEST_SOURCE_VERSION}.`,
        ),
      );
      requireEnum(
        collector,
        path,
        "state",
        value["state"],
        QUEST_STATE_SET,
        enumHint(value["state"], QUEST_STATES, `Toegestaan: ${QUEST_STATES.join(", ")}.`),
      );
      break;
  }
};

/**
 * Keurt een conditieboom, of weigert hem met een lijst van alles wat er mis is.
 *
 * Alles, niet het eerste. Wie een conditie van acht bladeren opstelt en er drie
 * veldnamen in verhaspelt, wil dat in één keer horen en niet in drie rondes.
 */
export const validateCondition = (value: unknown): ValidationResult => {
  const collector = new Collector();
  const counts = { leaves: 0 };

  validateNode(collector, "condition", value, 0, counts);

  if (collector.problems.length > 0) {
    return { ok: false, problems: collector.problems };
  }
  return { ok: true, condition: value as Condition, leafCount: counts.leaves };
};

/** De skills waarvoor een relatief XP-doel is opgegeven, met hun pad in de boom. */
export const relativeXpTargets = (
  condition: Condition,
  path = "condition",
): { path: string; node: SkillXpCondition }[] => {
  const found: { path: string; node: SkillXpCondition }[] = [];

  const walk = (node: Condition, at: string): void => {
    if (node.type === "all" || node.type === "any") {
      node.of.forEach((child, index) => walk(child, `${at}.of[${index}]`));
      return;
    }
    if (node.type === "not") {
      walk(node.of, `${at}.of`);
      return;
    }
    if (node.type === "skillXp" && node.xpGain !== undefined) {
      found.push({ path: at, node });
    }
  };

  walk(condition, path);
  return found;
};

/** Het aantal bladeren, voor de samenvatting in het antwoord van de tool. */
export const countLeaves = (condition: Condition): number => {
  if (condition.type === "all" || condition.type === "any") {
    return condition.of.reduce((total, child) => total + countLeaves(child), 0);
  }
  if (condition.type === "not") return countLeaves(condition.of);
  return 1;
};

/**
 * Beschrijft een conditie in één regel mensentaal.
 *
 * Voor het antwoord van de tool en het run-bestand: wie de stap zet moet kunnen zien
 * dat de conditie beschrijft wat hij bedoelde, en een JSON-boom teruglezen is daar een
 * slechtere manier voor dan een zin.
 */
export const describeCondition = (condition: Condition): string => {
  switch (condition.type) {
    case "position":
      return (
        `binnen ${condition.radius} tegel(s) van ${condition.x}, ${condition.y}` +
        (condition.plane === 0 ? "" : ` op verdieping ${condition.plane}`)
      );
    case "region":
      return `in regio ${condition.regionId}`;
    case "item": {
      const quantity = condition.minQuantity ?? 1;
      const label = condition.name === undefined ? `item ${condition.itemId}` : `${condition.name} (${condition.itemId})`;
      const where =
        condition.container === "equipment" ? "gedragen" : `in de ${condition.container}`;
      return `${quantity}× ${label} ${where}`;
    }
    case "skillLevel":
      return `${condition.skill} minstens level ${condition.minLevel}`;
    case "skillXp":
      return (
        `${condition.skill} minstens ${condition.minXp} XP` +
        (condition.baselineXp === undefined
          ? ""
          : ` (${condition.minXp! - condition.baselineXp} erbij vanaf ${condition.baselineXp})`)
      );
    case "quest":
      return `quest ${condition.quest} staat op ${condition.state}`;
    case "all":
      return condition.of.map(describeCondition).join(" én ");
    case "any":
      return condition.of.map(describeCondition).join(" óf ");
    case "not":
      return `niet: ${describeCondition(condition.of)}`;
  }
};

/**
 * Alle itemcondities die op één bepaalde container kijken.
 *
 * Bedoeld om een stille faalwijze te betrappen die in de doorloop van 2026-09-21
 * toesloeg: een stap eiste een bijl in de `inventory` terwijl de speler hem al
 * vasthield. De conditie ging dus nooit af, en het wachtscript wachtte op gereedschap
 * dat er allang was — zonder dat iets dat meldde. Het schema kon het geval altijd al
 * uitdrukken (`any` over inventory en equipment); het was de auteur die het misschreef.
 */
export const itemTargets = (
  condition: Condition,
  container: ContainerName,
  path = "condition",
): { path: string; node: ItemCondition }[] => {
  const found: { path: string; node: ItemCondition }[] = [];

  const walk = (node: Condition, at: string): void => {
    if (node.type === "all" || node.type === "any") {
      node.of.forEach((child, index) => walk(child, `${at}.of[${index}]`));
      return;
    }
    if (node.type === "not") {
      walk(node.of, `${at}.of`);
      return;
    }
    if (node.type === "item" && node.container === container) {
      found.push({ path: at, node });
    }
  };

  walk(condition, path);
  return found;
};

/** Of er ergens in de boom al naar een container gekeken wordt. */
export const touchesContainer = (condition: Condition, container: ContainerName): boolean =>
  itemTargets(condition, container).length > 0;
