/**
 * De pure kant van een taak: structuur, herhaalblokken, plancontrole, bankstap-
 * herkenning, positie en id's (ORS-025, ORS-030).
 *
 * Geen I/O hier — dat staat in `taskfile.test.ts`. De twee voorbeelden uit
 * Stapcontract §6 komen letterlijk terug: dat is de testinvoer die het contract zelf
 * aanreikt.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildPlanInstruction } from "../src/planprompt.js";
import {
  describeTaskPosition,
  isBankDestination,
  isRepeat,
  slugify,
  uniqueTaskId,
  validateTaskSteps,
} from "../src/task.js";

/** De bank van Lumbridge Castle, uit `landmarkdata.ts` — dezelfde die Stapcontract §6
 * gebruikt in het negatievoorbeeld ("weg bij de bank"). */
const LUMBRIDGE_BANK = { x: 3208, y: 3220, plane: 2 };

const HERE = { destination: null, noTravel: "zelfde plek als vorige stap" };

/* ------------------------------------------------------------------ *
 * De voorbeelden uit Stapcontract §6, letterlijk
 * ------------------------------------------------------------------ */

/** Het oude voorbeeld, van vóór het herhaalblok. */
const CONTRACT_EXAMPLE_STEPS = [
  {
    instruction: "Pak een bronze axe uit de bank als je er nog geen hebt",
    destination: null,
    noTravel: "De speler kiest zelf de dichtstbijzijnde bank",
    items: [{ itemId: 1265, quantity: 1, name: "Bronze axe" }],
    condition: {
      type: "any",
      of: [
        { type: "item", container: "inventory", itemId: 1265, name: "Bronze axe" },
        { type: "item", container: "equipment", itemId: 1265, name: "Bronze axe" },
      ],
    },
  },
  {
    instruction: "Hak logs bij de bomen ten noorden van Lumbridge tot Woodcutting level 50",
    destination: { x: 3175, y: 3236, plane: 0, label: "Bomen ten noorden van Lumbridge" },
    items: [],
    condition: { type: "skillLevel", skill: "WOODCUTTING", minLevel: 50 },
  },
];

const DRAYNOR_BANK = { x: 3092, y: 3243, plane: 0, label: "Bank Draynor Village" };
const NO_WILLOWS = {
  type: "not",
  of: { type: "item", container: "inventory", itemId: 1519, name: "Willow logs" },
};

/** Het voorbeeld met een herhaalblok: Woodcutting 38 naar 48. */
const REPEAT_EXAMPLE_STEPS = [
  {
    instruction: "Zet alles behalve je bijl in de bank in Draynor Village",
    destination: DRAYNOR_BANK,
    items: [{ itemId: 1361, quantity: 1, name: "Black axe" }],
    condition: {
      type: "all",
      of: [
        {
          type: "any",
          of: [
            { type: "item", container: "inventory", itemId: 1361, name: "Black axe" },
            { type: "item", container: "equipment", itemId: 1361, name: "Black axe" },
          ],
        },
        NO_WILLOWS,
      ],
    },
  },
  {
    type: "repeat",
    label: "Willows hakken en bankieren",
    until: { type: "skillLevel", skill: "WOODCUTTING", minLevel: 48 },
    maxRounds: 40,
    steps: [
      {
        instruction: "Hak willows ten zuiden van de Draynor-bank tot je inventory vol is",
        destination: { x: 3087, y: 3235, plane: 0, label: "Willows Draynor Village" },
        items: [],
        condition: { type: "item", container: "inventory", itemId: 1519, name: "Willow logs", minQuantity: 28 },
      },
      {
        instruction: "Zet je willow logs in de bank",
        destination: DRAYNOR_BANK,
        items: [],
        condition: NO_WILLOWS,
      },
    ],
  },
  {
    instruction: "Zet de laatste willow logs in de bank; de bijl blijft om",
    destination: DRAYNOR_BANK,
    items: [],
    condition: NO_WILLOWS,
  },
];

test("het contractvoorbeeld met een herhaalblok wordt geaccepteerd, zonder waarschuwingen", () => {
  const result = validateTaskSteps(REPEAT_EXAMPLE_STEPS);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.steps.length, 3);
  const block = result.steps[1]!;
  assert.ok(isRepeat(block));
  assert.equal(block.steps.length, 2);
  assert.equal(block.maxRounds, 40);
  assert.equal(block.label, "Willows hakken en bankieren");
  // De voorbereiding stuurt zelf naar een bank: dat telt voor zijn eigen bijl.
  assert.deepEqual(result.ownershipChecks, []);
  // Bank → bank bij het verlaten van het blok is juist goed (het blok kan na elke
  // stap sluiten), en er is een afronding.
  assert.deepEqual(result.warnings, []);
});

test("het oude contractvoorbeeld is structureel geldig maar valt op de plancontrole", () => {
  const result = validateTaskSteps(CONTRACT_EXAMPLE_STEPS);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.problems.length, 1);
  assert.equal(result.problems[0]!.path, "steps[1].condition");
  assert.match(result.problems[0]!.message, /cyclus/);
  assert.match(result.problems[0]!.message, /"type": "repeat"/);
});

/* ------------------------------------------------------------------ *
 * Structuur
 * ------------------------------------------------------------------ */

test("geen stappen wordt geweigerd", () => {
  const result = validateTaskSteps([]);
  assert.equal(result.ok, false);
});

test("iets anders dan een lijst wordt geweigerd", () => {
  const result = validateTaskSteps({ instruction: "hoi" });
  assert.equal(result.ok, false);
});

test("een stap zonder instruction wordt geweigerd, met het pad erbij", () => {
  const result = validateTaskSteps([{ ...HERE, items: [], condition: null }]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.problems.some((p) => p.path === "steps[0].instruction"));
});

test("een onbekend veld op een stap wordt geweigerd", () => {
  const result = validateTaskSteps([
    { instruction: "Loop naar Varrock", ...HERE, condition: null, timeout: 10 },
  ]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.problems.some((p) => p.path === "steps[0].timeout"));
});

test("condition moet als veld aanwezig zijn, ook als de waarde null is", () => {
  const result = validateTaskSteps([{ instruction: "Loop naar Varrock", ...HERE }]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.problems.some((p) => p.path === "steps[0]" && /condition/.test(p.message)));
});

test("condition: null is geldig — niet machinaal te detecteren", () => {
  const result = validateTaskSteps([{ instruction: "Praat met de NPC", ...HERE, condition: null }]);
  assert.equal(result.ok, true);
});

test("een ongeldige conditie levert hetzelfde soort weigering op als bij set_step", () => {
  const result = validateTaskSteps([
    { instruction: "Hak drie logs", ...HERE, condition: { type: "item", container: "kluis", itemId: 1511 } },
  ]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  // Het pad van condition.ts ("condition.container") is herschreven naar het pad van
  // deze stap ("steps[0].condition.container"), niet blijven staan als "condition...".
  assert.ok(result.problems.some((p) => p.path === "steps[0].condition.container"));
});

test("meerdere stappen met een ongeldige conditie krijgen elk hun eigen pad", () => {
  const result = validateTaskSteps([
    { instruction: "Stap 1", ...HERE, condition: { type: "region" } },
    { instruction: "Stap 2", ...HERE, condition: { type: "region" } },
  ]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.problems.some((p) => p.path.startsWith("steps[0].condition")));
  assert.ok(result.problems.some((p) => p.path.startsWith("steps[1].condition")));
});

test("meer dan MAX_STEPS stappen wordt geweigerd", () => {
  const steps = Array.from({ length: 61 }, (_, i) => ({
    instruction: `Stap ${i + 1}`,
    ...HERE,
    condition: null,
  }));
  const result = validateTaskSteps(steps);
  assert.equal(result.ok, false);
});

test("stappen in een blok tellen mee voor MAX_STEPS", () => {
  const inner = Array.from({ length: 60 }, (_, i) => ({ instruction: `Stap ${i + 1}`, ...HERE, condition: null }));
  const result = validateTaskSteps([
    { instruction: "Voorbereiding", ...HERE, condition: null },
    { type: "repeat", until: { type: "skillLevel", skill: "AGILITY", minLevel: 30 }, steps: inner },
  ]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.problems[0]!.message, /blokken meegeteld/);
});

/* ------------------------------------------------------------------ *
 * destination, noTravel en items
 * ------------------------------------------------------------------ */

test("een stap zonder destination-veld wordt geweigerd", () => {
  const result = validateTaskSteps([{ instruction: "Loop naar Varrock", condition: null }]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.problems.some((p) => p.path === "steps[0]" && /destination/.test(p.message)));
});

test("destination: null zonder noTravel wordt geweigerd", () => {
  const result = validateTaskSteps([{ instruction: "Loop naar Varrock", destination: null, condition: null }]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.problems.some((p) => p.path === "steps[0].destination" && /noTravel/.test(p.message)));
});

test("destination: null met een lege noTravel wordt geweigerd", () => {
  const result = validateTaskSteps([
    { instruction: "Praat met de bankier", destination: null, noTravel: "  ", condition: null },
  ]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.problems.some((p) => p.path === "steps[0].noTravel"));
});

test("destination: null met een noTravel-reden is geldig en blijft bewaard", () => {
  const result = validateTaskSteps([{ instruction: "Praat met de bankier", ...HERE, condition: null }]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const step = result.steps[0]!;
  assert.ok(!isRepeat(step));
  assert.equal(step.destination, null);
  assert.equal(step.noTravel, "zelfde plek als vorige stap");
});

test("noTravel naast een ingevulde destination wordt geweigerd", () => {
  const result = validateTaskSteps([
    { instruction: "Ga naar de bank", destination: LUMBRIDGE_BANK, noTravel: "hier", condition: null },
  ]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.problems.some((p) => p.path === "steps[0].noTravel"));
});

test("een destination met een ontbrekende plane wordt geweigerd", () => {
  const result = validateTaskSteps([
    { instruction: "Loop naar Varrock", destination: { x: 3210, y: 3424 }, condition: null },
  ]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.problems.some((p) => p.path === "steps[0].destination.plane"));
});

test("een plane boven 3 wordt geweigerd", () => {
  const result = validateTaskSteps([
    {
      instruction: "Loop ergens heen",
      destination: { x: 0, y: 0, plane: 4 },
      condition: null,
    },
  ]);
  assert.equal(result.ok, false);
});

test("items zonder quantity krijgt standaard 1", () => {
  const result = validateTaskSteps([
    { instruction: "Pak iets", ...HERE, items: [{ itemId: 995 }], condition: null },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const step = result.steps[0]!;
  assert.ok(!isRepeat(step));
  assert.equal(step.items[0]!.quantity, 1);
});

test("een negatieve quantity wordt geweigerd", () => {
  const result = validateTaskSteps([
    { instruction: "Pak iets", ...HERE, items: [{ itemId: 995, quantity: -1 }], condition: null },
  ]);
  assert.equal(result.ok, false);
});

test("een onbekend veld op een item wordt geweigerd", () => {
  const result = validateTaskSteps([
    { instruction: "Pak iets", ...HERE, items: [{ itemId: 995, aantal: 5 }], condition: null },
  ]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.problems.some((p) => p.path === "steps[0].items[0].aantal"));
});

/* ------------------------------------------------------------------ *
 * Het herhaalblok
 * ------------------------------------------------------------------ */

const AGILITY_48 = { type: "skillLevel", skill: "AGILITY", minLevel: 48 };
const lap = { instruction: "Loop een rondje", destination: { x: 3103, y: 3279, plane: 0 }, condition: null };

test("een blok met één stap is geldig — ook een Agility-rondje herhaalt", () => {
  const result = validateTaskSteps([{ type: "repeat", until: AGILITY_48, steps: [lap] }, { instruction: "Klaar", ...HERE, condition: null }]);
  assert.equal(result.ok, true, JSON.stringify(result));
});

test("een genest blok wordt geweigerd met uitleg", () => {
  const result = validateTaskSteps([
    {
      type: "repeat",
      until: AGILITY_48,
      steps: [lap, { type: "repeat", until: AGILITY_48, steps: [lap] }],
    },
  ]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  const problem = result.problems.find((p) => p.path === "steps[0].steps[1].type");
  assert.ok(problem);
  assert.match(problem.message, /nestelen niet/);
});

test("een blok zonder until wordt geweigerd", () => {
  const result = validateTaskSteps([{ type: "repeat", steps: [lap] }]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.problems.some((p) => p.path === "steps[0].until"));
});

test("until: null wordt geweigerd", () => {
  const result = validateTaskSteps([{ type: "repeat", until: null, steps: [lap] }]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.problems.some((p) => p.path === "steps[0].until" && /nooit af/.test(p.message)));
});

test("een ongeldige until wordt even streng gevalideerd als een stapconditie", () => {
  const result = validateTaskSteps([
    { type: "repeat", until: { type: "skillLevel", skill: "HOUTHAKKEN", minLevel: 48 }, steps: [lap] },
  ]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.problems.some((p) => p.path === "steps[0].until.skill"));
});

test("een blok zonder stappen wordt geweigerd", () => {
  const result = validateTaskSteps([{ type: "repeat", until: AGILITY_48, steps: [] }]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.problems.some((p) => p.path === "steps[0].steps"));
});

test("een fout in een stap in een blok noemt het pad binnen het blok", () => {
  const result = validateTaskSteps([
    { type: "repeat", until: AGILITY_48, steps: [lap, { instruction: "Bank", destination: null, condition: null }] },
  ]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.problems.some((p) => p.path === "steps[0].steps[1].destination"));
});

test("maxRounds moet een geheel getal van minstens 1 zijn", () => {
  for (const maxRounds of [0, -3, 2.5, "10", 1001]) {
    const result = validateTaskSteps([{ type: "repeat", until: AGILITY_48, maxRounds, steps: [lap] }]);
    assert.equal(result.ok, false, `maxRounds ${JSON.stringify(maxRounds)}`);
    if (result.ok) continue;
    assert.ok(result.problems.some((p) => p.path === "steps[0].maxRounds"));
  }
});

test("een onbekend veld op een blok wordt geweigerd", () => {
  const result = validateTaskSteps([{ type: "repeat", until: AGILITY_48, steps: [lap], rounds: 5 }]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.problems.some((p) => p.path === "steps[0].rounds"));
});

test("een onbekend type wordt geweigerd", () => {
  const result = validateTaskSteps([{ type: "loop", until: AGILITY_48, steps: [lap] }]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.problems.some((p) => p.path === "steps[0].type"));
});

/* ------------------------------------------------------------------ *
 * Plancontrole en waarschuwingen
 * ------------------------------------------------------------------ */

test("een skillXp-doel op een losse stap wordt ook geweigerd", () => {
  const result = validateTaskSteps([
    { instruction: "Mijn", ...HERE, condition: { type: "skillXp", skill: "MINING", xpGain: 500 } },
  ]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.problems.some((p) => p.path === "steps[0].condition" && /cyclus/.test(p.message)));
});

test("een skilldoel diep in een combinator buiten een blok wordt geweigerd", () => {
  const result = validateTaskSteps([
    {
      instruction: "Mijn",
      ...HERE,
      condition: {
        type: "any",
        of: [
          { type: "skillLevel", skill: "MINING", minLevel: 30 },
          { type: "region", regionId: 12850 },
        ],
      },
    },
  ]);
  assert.equal(result.ok, false);
});

test("een skillconditie op een stap ín een blok mag", () => {
  const result = validateTaskSteps([
    {
      type: "repeat",
      until: AGILITY_48,
      steps: [{ ...lap, condition: { type: "skillXp", skill: "AGILITY", minXp: 10_000 } }],
    },
    { instruction: "Klaar", ...HERE, condition: null },
  ]);
  assert.equal(result.ok, true, JSON.stringify(result));
});

test("twee opeenvolgende losse stappen met dezelfde bestemming geven een waarschuwing", () => {
  const result = validateTaskSteps([
    { instruction: "Ga naar de bank", destination: LUMBRIDGE_BANK, condition: null },
    { instruction: "Praat met de bankier", destination: LUMBRIDGE_BANK, condition: null },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /stap 1 en 2/);
});

test("dezelfde bestemming binnen een blok en over de rondegrens geeft een waarschuwing", () => {
  const result = validateTaskSteps([
    {
      type: "repeat",
      until: AGILITY_48,
      steps: [
        { instruction: "A", destination: LUMBRIDGE_BANK, condition: null },
        { instruction: "B", destination: { x: 3100, y: 3100, plane: 0 }, condition: null },
        { instruction: "C", destination: LUMBRIDGE_BANK, condition: null },
      ],
    },
    { instruction: "Klaar", ...HERE, condition: null },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // C → A is de overgang naar de volgende ronde.
  assert.deepEqual(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /stap 1\.3 en 1\.1/);
});

test("de stap vóór een blok met dezelfde bestemming als de eerste stap erin geeft een waarschuwing", () => {
  const result = validateTaskSteps([
    { instruction: "Ga naar de bank", destination: LUMBRIDGE_BANK, condition: null },
    {
      type: "repeat",
      until: AGILITY_48,
      steps: [{ instruction: "A", destination: LUMBRIDGE_BANK, condition: null }],
    },
    { instruction: "Klaar", ...HERE, condition: null },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /stap 1 en 2\.1/);
});

test("stappen met destination: null tellen niet als dezelfde bestemming", () => {
  const result = validateTaskSteps([
    { instruction: "A", ...HERE, condition: null },
    { instruction: "B", ...HERE, condition: null },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.warnings, []);
});

test("een plan dat eindigt met een blok geeft een waarschuwing over de afronding", () => {
  const result = validateTaskSteps([{ type: "repeat", until: AGILITY_48, steps: [lap] }]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /afronding/);
});

/* ------------------------------------------------------------------ *
 * De bankstap-regel
 * ------------------------------------------------------------------ */

test("isBankDestination herkent een echt bankpunt", () => {
  assert.equal(isBankDestination(LUMBRIDGE_BANK), true);
});

test("isBankDestination herkent geen willekeurig punt", () => {
  assert.equal(isBankDestination({ x: 0, y: 0, plane: 0 }), false);
  assert.equal(isBankDestination(null), false);
});

test("een stap met spullen na een bankstap heeft geen bezitscontrole nodig", () => {
  const result = validateTaskSteps([
    { instruction: "Ga naar de bank", destination: LUMBRIDGE_BANK, condition: null },
    {
      instruction: "Pak een bijl",
      ...HERE,
      items: [{ itemId: 1265, quantity: 1 }],
      condition: { type: "item", container: "inventory", itemId: 1265 },
    },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.ownershipChecks, []);
});

test("een stap met spullen zonder bankstap ervoor komt in de bezitscontrole", () => {
  const result = validateTaskSteps([
    {
      instruction: "Pak een bijl",
      ...HERE,
      items: [{ itemId: 1265, quantity: 1 }],
      condition: null,
    },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.ownershipChecks.length, 1);
  assert.equal(result.ownershipChecks[0]!.stepLabel, "1");
});

test("in een blok telt een bankstap eerder in de ronde, een latere niet", () => {
  const tinderbox = { itemId: 590, quantity: 1, name: "Tinderbox" };
  const result = validateTaskSteps([
    {
      type: "repeat",
      until: AGILITY_48,
      steps: [
        { instruction: "Verbrand de logs", ...HERE, items: [tinderbox], condition: null },
        { instruction: "Naar de bank", destination: LUMBRIDGE_BANK, items: [tinderbox], condition: null },
      ],
    },
    { instruction: "Klaar", ...HERE, condition: null },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.ownershipChecks, [{ stepLabel: "1.1", item: tinderbox }]);
});

/* ------------------------------------------------------------------ *
 * Positie in woorden (list_tasks, get_task)
 * ------------------------------------------------------------------ */

test("de positie in een blok leest als 'blok b, ronde r, stap i van j'", () => {
  const progress = { status: "active", activeStepIndex: 1, activeInnerIndex: 0, activeRound: 4, steps: [] };
  assert.equal(describeTaskPosition(REPEAT_EXAMPLE_STEPS, progress), "blok 2, ronde 4, stap 1 van 2");
});

test("de positie op een gewone stap leest als 'stap n van m'", () => {
  const progress = { status: "active", activeStepIndex: 2, activeInnerIndex: null, activeRound: null, steps: [] };
  assert.equal(describeTaskPosition(REPEAT_EXAMPLE_STEPS, progress), "stap 3 van 3");
});

test("een voortgang van vóór het herhaalblok (zonder de nieuwe velden) werkt nog", () => {
  const progress = { status: "active", activeStepIndex: 1, steps: [] };
  assert.equal(describeTaskPosition(CONTRACT_EXAMPLE_STEPS, progress), "stap 2 van 2");
  assert.equal(describeTaskPosition(REPEAT_EXAMPLE_STEPS, progress), "stap 2 van 3");
});

test("geen voortgang of geen index geeft geen positie", () => {
  assert.equal(describeTaskPosition(REPEAT_EXAMPLE_STEPS, null), null);
  assert.equal(describeTaskPosition(REPEAT_EXAMPLE_STEPS, { status: "active" }), null);
});

/* ------------------------------------------------------------------ *
 * De prompt
 * ------------------------------------------------------------------ */

test("de prompt plan_task vraagt om voorbereiding, cyclus als herhaalblok en afronding", () => {
  const text = buildPlanInstruction();
  assert.match(text, /Voorbereiding/);
  assert.match(text, /herhaalblok/);
  assert.match(text, /type: "repeat"/);
  assert.match(text, /Afronding/);
  assert.match(text, /opbrengst/);
  assert.match(text, /noTravel/);
  assert.doesNotMatch(text, /\{\{player\}\}|\{\{accountType\}\}/);
});

/* ------------------------------------------------------------------ *
 * Id's
 * ------------------------------------------------------------------ */

test("slugify maakt een leesbare, lage-letter slug", () => {
  assert.equal(slugify("Woodcutting van 40 naar 50"), "woodcutting-van-40-naar-50");
});

test("slugify valt terug op 'taak' als er niets overblijft", () => {
  assert.equal(slugify("😀😀😀"), "taak");
});

test("uniqueTaskId botst niet met bestaande id's", () => {
  const id = uniqueTaskId("2026-09-21", "Woodcutting van 40 naar 50", [
    "2026-09-21-woodcutting-van-40-naar-50",
  ]);
  assert.equal(id, "2026-09-21-woodcutting-van-40-naar-50-2");
});
