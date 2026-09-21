/**
 * Het run-bestand. Stapcontract paragraaf 7.
 *
 * De zwaarste eis is niet de vorm maar dit: "Met de hand te lezen en te corrigeren.
 * Wie het bestand aanpast, heeft gelijk." Daar staat een eigen blok tests voor —
 * een tool die andermans correcties opruimt is erger dan geen tool.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  RunFileError,
  activeStepOf,
  addDeviation,
  archiveName,
  clearActiveStep,
  completeStep,
  completedCountOf,
  createRunText,
  deviationsOf,
  goalOf,
  nextOpenStep,
  planOf,
  runLabel,
  setActiveStep,
  setPlanStatus,
  summarize,
} from '../src/run.js';

const GOAL = 'Cooks Assistant afronden. Klaar als de quest op FINISHED staat.';
const PLAN = ['Bijl uit de bank halen', 'Naar Lumbridge lopen', 'Met de kok praten'];

function fresh(): string {
  return createRunText({ goal: GOAL, plan: PLAN });
}

/* ---------------------------------------------------------- vorm ---- */

test('een nieuwe run heeft de vijf secties uit paragraaf 7, in volgorde', () => {
  const text = fresh();
  const headings = text
    .split('\n')
    .filter((line) => line.startsWith('#'))
    .map((line) => line.trim());
  assert.deepEqual(headings, [
    '# Doel',
    '## Plan',
    '## Actieve stap',
    '## Afgerond',
    '## Afwijkingen en open vragen',
  ]);
});

test('het plan is genummerd en de stappen staan open', () => {
  const plan = planOf(fresh());
  assert.deepEqual(
    plan.map((item) => [item.number, item.status, item.label]),
    [
      [1, 'open', 'Bijl uit de bank halen'],
      [2, 'open', 'Naar Lumbridge lopen'],
      [3, 'open', 'Met de kok praten'],
    ],
  );
});

test('het doel is terug te lezen, ook als het twee zinnen is', () => {
  assert.equal(goalOf(fresh()), GOAL);
});

test('een run zonder doel of zonder plan wordt geweigerd', () => {
  assert.throws(() => createRunText({ goal: '   ', plan: PLAN }), RunFileError);
  assert.throws(() => createRunText({ goal: GOAL, plan: [] }), RunFileError);
});

/* -------------------------------------------------- actieve stap ---- */

test('de actieve stap krijgt de vorm uit het contract', () => {
  const text = setActiveStep(fresh(), {
    seq: 7,
    at: '12:04',
    instruction: 'Hak drie logs ten noorden van Lumbridge',
    condition: 'minstens 3 x Logs (1511) in inventory',
  });
  assert.deepEqual(activeStepOf(text), [
    'seq 7 — gezet 12:04 — Hak drie logs ten noorden van Lumbridge',
    'minstens 3 x Logs (1511) in inventory',
  ]);
});

test('een stap zonder conditie zegt dat erbij', () => {
  const text = setActiveStep(fresh(), { seq: 8, at: '12:10', instruction: 'Praat met de kok' });
  assert.match(activeStepOf(text)[1]!, /niet machinaal detecteerbaar/);
});

test('een nieuwe actieve stap vervangt de vorige, hij stapelt niet', () => {
  let text = setActiveStep(fresh(), { seq: 7, at: '12:04', instruction: 'Eerste', condition: 'a' });
  text = setActiveStep(text, { seq: 8, at: '12:09', instruction: 'Tweede', condition: 'b' });
  assert.equal(activeStepOf(text).length, 2);
  assert.match(activeStepOf(text)[0]!, /seq 8/);
  assert.doesNotMatch(text, /Eerste/);
});

test('een leeg gemaakte actieve stap leest als geen stap', () => {
  const text = clearActiveStep(setActiveStep(fresh(), { seq: 7, at: '12:04', instruction: 'Iets' }));
  assert.deepEqual(activeStepOf(text), []);
});

/* ------------------------------------------------------- afronden --- */

test('een afgeronde stap levert een tabelregel en een vinkje op', () => {
  const start = setActiveStep(fresh(), { seq: 7, at: '11:55', instruction: 'Bijl pakken' });
  const { text, step } = completeStep(start, { at: '11:58', note: 'lag in de tweede tab' });

  assert.equal(step.number, 1);
  assert.match(text, /\| 11:58 \| 1\. Bijl uit de bank halen \| lag in de tweede tab \|/);
  assert.equal(planOf(text)[0]!.status, 'done');
  assert.deepEqual(activeStepOf(text), [], 'de actieve stap hoort leeg te zijn na afronden');
  assert.equal(completedCountOf(text), 1);
});

test('zonder toelichting komt er een streepje in de kolom', () => {
  const { text } = completeStep(fresh(), { at: '12:00' });
  assert.match(text, /\| 12:00 \| 1\. Bijl uit de bank halen \| — \|/);
});

test('stappen worden één voor één afgevinkt en de regels stapelen op', () => {
  let text = fresh();
  for (const at of ['11:58', '12:03', '12:09']) {
    text = completeStep(text, { at }).text;
  }
  assert.equal(completedCountOf(text), 3);
  assert.deepEqual(
    planOf(text).map((item) => item.status),
    ['done', 'done', 'done'],
  );
  // De volgorde in de tabel is de volgorde waarin ze afgingen.
  const rows = text.split('\n').filter((line) => /^\| \d\d:\d\d \|/.test(line));
  assert.deepEqual(rows.map((row) => row.slice(2, 7)), ['11:58', '12:03', '12:09']);
});

test('een expliciet stapnummer mag buiten de volgorde', () => {
  const { text, step } = completeStep(fresh(), { at: '12:00', stepNumber: 3 });
  assert.equal(step.number, 3);
  assert.deepEqual(
    planOf(text).map((item) => item.status),
    ['open', 'open', 'done'],
  );
});

test('afronden zonder open stap of met een onbekend nummer wordt geweigerd', () => {
  let text = fresh();
  for (const at of ['1', '2', '3']) text = completeStep(text, { at }).text;
  assert.throws(() => completeStep(text, { at: '12:15' }), /geen open stap meer/);
  assert.throws(() => completeStep(fresh(), { at: '12:15', stepNumber: 9 }), /staat niet in het plan/);
});

test('een pipe in de toelichting breekt de tabel niet', () => {
  const { text } = completeStep(fresh(), { at: '12:00', note: 'koos a | b' });
  assert.match(text, /koos a \\\| b/);
  assert.equal(completedCountOf(text), 1);
});

test('een toelichting over meer regels wordt één regel', () => {
  const { text } = completeStep(fresh(), { at: '12:00', note: 'eerste regel\ntweede regel' });
  assert.match(text, /\| eerste regel tweede regel \|/);
});

/* ----------------------------------------------------- afwijkingen -- */

test('afwijkingen stapelen en vervangen de placeholder', () => {
  let text = addDeviation(fresh(), 'de bijl lag niet in de bank');
  assert.deepEqual(deviationsOf(text), ['- de bijl lag niet in de bank']);
  text = addDeviation(text, 'moest er een kopen');
  assert.deepEqual(deviationsOf(text), ['- de bijl lag niet in de bank', '- moest er een kopen']);
  assert.doesNotMatch(text, /\(nog niets\)/);
});

test('een lege afwijking wordt geweigerd', () => {
  assert.throws(() => addDeviation(fresh(), '  '), RunFileError);
});

/* ------------------------------------------- met de hand corrigeren - */

test('een met de hand aangepaste steplabel blijft staan en wordt zo afgevinkt', () => {
  // De eigenaar corrigeert de tekst van stap 2.
  const edited = fresh().replace('2. Naar Lumbridge lopen', '2. Naar Lumbridge lopen (via de boot)');
  const { text, step } = completeStep(edited, { at: '12:03', stepNumber: 2 });
  assert.equal(step.label, 'Naar Lumbridge lopen (via de boot)');
  assert.match(text, /\| 2\. Naar Lumbridge lopen \(via de boot\) \|/);
  assert.match(text, /- \[x\] 2\. Naar Lumbridge lopen \(via de boot\)/);
});

test('een met de hand toegevoegde stap in het plan doet gewoon mee', () => {
  const edited = fresh().replace(
    '- [ ] 3. Met de kok praten',
    '- [ ] 3. Met de kok praten\n- [ ] 4. Eieren halen',
  );
  const plan = planOf(edited);
  assert.equal(plan.length, 4);
  assert.equal(plan[3]!.label, 'Eieren halen');
  const { step } = completeStep(setPlanStatus(edited, 4, 'busy'), { at: '12:20' });
  assert.equal(step.number, 4, 'een stap op "mee bezig" gaat voor op een open stap');
});

test('met de hand geschreven tekst buiten de secties blijft staan', () => {
  const edited = fresh() + '\n## Mijn eigen aantekeningen\n- niet weggooien\n';
  const { text } = completeStep(edited, { at: '12:00' });
  assert.match(text, /## Mijn eigen aantekeningen/);
  assert.match(text, /- niet weggooien/);
});

test('een met de hand toegevoegde regel onder Afgerond blijft staan', () => {
  const edited = fresh().replace('|---|---|---|', '|---|---|---|\n| 11:00 | 0. Voorbereiding | met de hand |');
  const { text } = completeStep(edited, { at: '12:00' });
  assert.match(text, /\| 11:00 \| 0\. Voorbereiding \| met de hand \|/);
  assert.equal(completedCountOf(text), 2, 'de eigen regel telt mee als afgeronde stap');
  // De nieuwe regel komt eronder, niet ervoor.
  const rows = text.split('\n').filter((line) => /^\| \d\d:\d\d \|/.test(line));
  assert.deepEqual(rows.map((row) => row.slice(2, 7)), ['11:00', '12:00']);
});

test('een weggehaalde sectie geeft een duidelijke fout, geen stille herbouw', () => {
  const broken = fresh().replace('## Afgerond\n', '');
  assert.throws(() => completeStep(broken, { at: '12:00' }), /sectie `## Afgerond` ontbreekt/);
});

test('CRLF-regeleindes worden gelezen zoals ze bedoeld zijn', () => {
  const crlf = fresh().replace(/\n/g, '\r\n');
  assert.equal(planOf(crlf).length, 3);
  assert.equal(goalOf(crlf), GOAL);
  const { text } = completeStep(crlf, { at: '12:00' });
  assert.equal(completedCountOf(text), 1);
});

/* ------------------------------------------------------ archiveren -- */

test('de bestandsnaam is datum plus de eerste zin van het doel', () => {
  assert.equal(runLabel(GOAL), 'Cooks Assistant afronden');
  assert.equal(
    archiveName({ date: '2026-09-20', label: 'Cooks Assistant', taken: [] }),
    '2026-09-20 Cooks Assistant.md',
  );
});

test('een tweede run op één dag krijgt (2) erachter', () => {
  const taken = ['2026-09-20 Cooks Assistant.md'];
  assert.equal(
    archiveName({ date: '2026-09-20', label: 'Cooks Assistant', taken }),
    '2026-09-20 Cooks Assistant (2).md',
  );
  assert.equal(
    archiveName({ date: '2026-09-20', label: 'Cooks Assistant', taken: [...taken, '2026-09-20 Cooks Assistant (2).md'] }),
    '2026-09-20 Cooks Assistant (3).md',
  );
});

test('tekens die een bestandsnaam breken gaan eruit', () => {
  assert.equal(runLabel('Doe X: deel 1/2 <nu>'), 'Doe X deel 12 nu');
  assert.equal(runLabel('   '), 'run');
});

test('een heel lang doel wordt afgekapt', () => {
  const label = runLabel('a'.repeat(200));
  assert.ok(label.length <= 60, 'kreeg ' + label.length + ' tekens');
});

/* --------------------------------------------------------- stand ---- */

test('de samenvatting zegt hoe ver de run is', () => {
  let text = fresh();
  assert.match(summarize(text), /0 van 3 stappen klaar — geen actieve stap/);
  text = completeStep(text, { at: '11:58' }).text;
  text = setActiveStep(text, { seq: 8, at: '12:00', instruction: 'Naar Lumbridge', condition: 'in regio 12850' });
  text = addDeviation(text, 'iets viel anders uit');
  const summary = summarize(text);
  assert.match(summary, /1 van 3 stappen klaar/);
  assert.match(summary, /actief: seq 8/);
  assert.match(summary, /1 afwijking/);
});

test('de eerstvolgende open stap slaat afgevinkte stappen over', () => {
  let text = completeStep(fresh(), { at: '11:58' }).text;
  assert.equal(nextOpenStep(text)!.number, 2);
  text = setPlanStatus(text, 3, 'busy');
  assert.equal(nextOpenStep(text)!.number, 3, 'mee bezig gaat voor op open');
});

test('een vervallen stap houdt de run niet tegen', () => {
  const text = setPlanStatus(fresh(), 1, 'dropped');
  assert.equal(nextOpenStep(text)!.number, 2);
  assert.match(summarize(text), /1 vervallen/);
});

test('er staat geen lege regel direct onder een kopje', () => {
  // Het bestand wordt met de hand gelezen; een bijgewerkte sectie hoort er net zo
  // uit te zien als een verse, en de template van paragraaf 7 heeft die regel niet.
  let text = setActiveStep(fresh(), { seq: 7, at: '12:04', instruction: 'Iets', condition: 'ergens' });
  text = addDeviation(text, 'iets viel anders uit');
  text = completeStep(text, { at: '12:05' }).text;
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    if (line.startsWith('#')) {
      assert.notEqual(lines[index + 1], '', 'lege regel onder kopje: ' + line);
    }
  }
});
