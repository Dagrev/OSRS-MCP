/**
 * De pure kant van een taak: structuur, bankstap-herkenning, id's (ORS-025).
 *
 * Geen I/O hier — dat staat in `taskfile.test.ts`. Het voorbeeld uit Stapcontract §6
 * (bijl uit de bank, dan hakken tot level 50) komt letterlijk terug: dat is de
 * testinvoer die het contract zelf aanreikt.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isBankDestination,
  slugify,
  uniqueTaskId,
  validateTaskSteps,
} from "../src/task.js";

/** De bank van Lumbridge Castle, uit `landmarkdata.ts` — dezelfde die Stapcontract §6
 * gebruikt in het negatievoorbeeld ("weg bij de bank"). */
const LUMBRIDGE_BANK = { x: 3208, y: 3220, plane: 2 };

/* ------------------------------------------------------------------ *
 * Het voorbeeld uit Stapcontract §6, letterlijk
 * ------------------------------------------------------------------ */

const CONTRACT_EXAMPLE_STEPS = [
  {
    instruction: "Pak een bronze axe uit de bank als je er nog geen hebt",
    destination: null,
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

test("het taakvoorbeeld uit het contract is structureel geldig", () => {
  const result = validateTaskSteps(CONTRACT_EXAMPLE_STEPS);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[1]!.destination?.label, "Bomen ten noorden van Lumbridge");
  // Stap 1 heeft spullen en geen voorafgaande bankstap: hij komt in de bezitscontrole
  // terecht, die de toollaag met de snapshots afhandelt.
  assert.deepEqual(result.ownershipChecks, [
    { stepIndex: 0, item: { itemId: 1265, quantity: 1, name: "Bronze axe" } },
  ]);
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
  const result = validateTaskSteps([{ destination: null, items: [], condition: null }]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.problems.some((p) => p.path === "steps[0].instruction"));
});

test("een onbekend veld op een stap wordt geweigerd", () => {
  const result = validateTaskSteps([
    { instruction: "Loop naar Varrock", condition: null, timeout: 10 },
  ]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.problems.some((p) => p.path === "steps[0].timeout"));
});

test("condition moet als veld aanwezig zijn, ook als de waarde null is", () => {
  const result = validateTaskSteps([{ instruction: "Loop naar Varrock" }]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.problems.some((p) => p.path === "steps[0]" && /condition/.test(p.message)));
});

test("condition: null is geldig — niet machinaal te detecteren", () => {
  const result = validateTaskSteps([{ instruction: "Praat met de NPC", condition: null }]);
  assert.equal(result.ok, true);
});

test("een ongeldige conditie levert hetzelfde soort weigering op als bij set_step", () => {
  const result = validateTaskSteps([
    { instruction: "Hak drie logs", condition: { type: "item", container: "kluis", itemId: 1511 } },
  ]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  // Het pad van condition.ts ("condition.container") is herschreven naar het pad van
  // deze stap ("steps[0].condition.container"), niet blijven staan als "condition...".
  assert.ok(result.problems.some((p) => p.path === "steps[0].condition.container"));
});

test("meerdere stappen met een ongeldige conditie krijgen elk hun eigen pad", () => {
  const result = validateTaskSteps([
    { instruction: "Stap 1", condition: { type: "region" } },
    { instruction: "Stap 2", condition: { type: "region" } },
  ]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.problems.some((p) => p.path.startsWith("steps[0].condition")));
  assert.ok(result.problems.some((p) => p.path.startsWith("steps[1].condition")));
});

test("meer dan MAX_STEPS stappen wordt geweigerd", () => {
  const steps = Array.from({ length: 61 }, (_, i) => ({
    instruction: `Stap ${i + 1}`,
    condition: null,
  }));
  const result = validateTaskSteps(steps);
  assert.equal(result.ok, false);
});

/* ------------------------------------------------------------------ *
 * destination en items
 * ------------------------------------------------------------------ */

test("destination weglaten betekent hetzelfde als null", () => {
  const result = validateTaskSteps([{ instruction: "Loop naar Varrock", condition: null }]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.steps[0]!.destination, null);
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
    { instruction: "Pak iets", items: [{ itemId: 995 }], condition: null },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.steps[0]!.items[0]!.quantity, 1);
});

test("een negatieve quantity wordt geweigerd", () => {
  const result = validateTaskSteps([
    { instruction: "Pak iets", items: [{ itemId: 995, quantity: -1 }], condition: null },
  ]);
  assert.equal(result.ok, false);
});

test("een onbekend veld op een item wordt geweigerd", () => {
  const result = validateTaskSteps([
    { instruction: "Pak iets", items: [{ itemId: 995, aantal: 5 }], condition: null },
  ]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.problems.some((p) => p.path === "steps[0].items[0].aantal"));
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
      items: [{ itemId: 1265, quantity: 1 }],
      condition: null,
    },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.ownershipChecks.length, 1);
  assert.equal(result.ownershipChecks[0]!.stepIndex, 0);
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
