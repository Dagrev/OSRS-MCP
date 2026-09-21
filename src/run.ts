/**
 * Het run-bestand: `runs/current-run.md` op de share.
 *
 * Stapcontract paragraaf 7 legt de vorm vast — vijf secties in een vaste volgorde,
 * markdown en geen JSON, één regel per afgeronde stap. Dit bestand is de mechanica
 * eromheen: een run beginnen, de actieve stap bijwerken, een stap afvinken op het
 * moment dat hij afgaat, en de run archiveren.
 *
 * **Alles gebeurt chirurgisch.** Het contract zegt: "Met de hand te lezen en te
 * corrigeren. Wie het bestand aanpast, heeft gelijk." Een tool die het bestand
 * inleest, in een model omzet en opnieuw uitschrijft, gooit elke correctie weg die
 * de eigenaar erin heeft gezet — een extra regel, een opmerking, een aangepaste
 * formulering. Dus: alleen de regels aanraken die moeten veranderen, de rest laten
 * staan, en luid falen als een sectie ontbreekt in plaats van hem stil opnieuw op
 * te bouwen.
 *
 * **Overgenomen uit de stapcoach-repo** (`C:\code\OSRS stap coach`, `src/run.ts`),
 * ongewijzigd, inclusief de schrijfstijl met enkele aanhalingstekens die afwijkt van
 * de rest van deze repo. Dat is met opzet: zo blijft een diff tegen het origineel
 * leesbaar zolang beide kanten bestaan. ORS-024 verhuisde de aanroepende kant naar
 * deze server; deze laag is puur tekstbewerking en doet geen I/O.
 */

export const RUNS_DIR = 'runs';
export const CURRENT_RUN_FILE = 'current-run.md';

/** De vier kopjes onder `# Doel`, in de volgorde van het contract. */
export const SECTION_PLAN = 'Plan';
export const SECTION_ACTIVE = 'Actieve stap';
export const SECTION_DONE = 'Afgerond';
export const SECTION_DEVIATIONS = 'Afwijkingen en open vragen';
export const SECTIONS = [SECTION_PLAN, SECTION_ACTIVE, SECTION_DONE, SECTION_DEVIATIONS] as const;

const NO_ACTIVE_STEP = '(geen actieve stap)';
const NOTHING_YET = '(nog niets)';
const DONE_TABLE_HEADER = ['| Tijd | Stap | Wat er anders bleek |', '|---|---|---|'];

export class RunFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunFileError';
  }
}

export type PlanStatus = 'open' | 'busy' | 'done' | 'dropped';

export interface PlanItem {
  /** Regelnummer in het bestand, 0-gebaseerd. */
  line: number;
  /** Het nummer zoals het in de regel staat, dus 1-gebaseerd. */
  number: number;
  status: PlanStatus;
  label: string;
}

const STATUS_MARK: Record<PlanStatus, string> = {
  open: ' ',
  busy: '/',
  done: 'x',
  dropped: '-',
};

const MARK_STATUS: Record<string, PlanStatus> = { ' ': 'open', '/': 'busy', x: 'done', '-': 'dropped' };

/* ------------------------------------------------------------------ *
 * Lezen en schrijven van de tekst
 * ------------------------------------------------------------------ */

function toLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n');
}

function fromLines(lines: string[]): string {
  const text = lines.join('\n');
  return text.endsWith('\n') ? text : text + '\n';
}

interface Section {
  /** Regelnummer van het kopje zelf. */
  heading: number;
  /** Eerste regel van de inhoud. */
  start: number;
  /** Eén voorbij de laatste regel van de inhoud. */
  end: number;
}

function findSection(lines: string[], heading: string): Section {
  const index = lines.findIndex((line) => line.trim() === '## ' + heading);
  if (index < 0) {
    throw new RunFileError(
      'sectie `## ' + heading + '` ontbreekt in het run-bestand; met de hand weggehaald? Voeg hem terug of begin een nieuwe run.',
    );
  }
  let end = lines.length;
  for (let scan = index + 1; scan < lines.length; scan += 1) {
    if (lines[scan]!.startsWith('## ')) {
      end = scan;
      break;
    }
  }
  return { heading: index, start: index + 1, end };
}

/** De inhoud van een sectie, zonder de lege regels aan begin en eind. */
function sectionBody(lines: string[], heading: string): string[] {
  const section = findSection(lines, heading);
  return trimBlank(lines.slice(section.start, section.end));
}

function trimBlank(lines: string[]): string[] {
  let first = 0;
  let last = lines.length;
  while (first < last && lines[first]!.trim() === '') first += 1;
  while (last > first && lines[last - 1]!.trim() === '') last -= 1;
  return lines.slice(first, last);
}

/**
 * Vervangt de inhoud van een sectie en laat de rest van het bestand staan.
 * De inhoud begint direct onder het kopje, zoals in de template van paragraaf 7,
 * met één lege regel ervoor naar de volgende sectie.
 */
function replaceSection(lines: string[], heading: string, body: string[]): string[] {
  const section = findSection(lines, heading);
  const tail = lines.slice(section.end);
  const separator = tail.length > 0 ? [''] : [];
  return [...lines.slice(0, section.start), ...body, ...separator, ...tail];
}

/* ------------------------------------------------------------------ *
 * Een run beginnen
 * ------------------------------------------------------------------ */

export function createRunText(options: { goal: string; plan: string[] }): string {
  if (options.goal.trim() === '') throw new RunFileError('een run heeft een doel nodig');
  if (options.plan.length === 0) throw new RunFileError('een run heeft minstens één stap in het plan nodig');

  const lines = [
    '# Doel',
    options.goal.trim(),
    '',
    '## ' + SECTION_PLAN,
    ...options.plan.map((step, index) => '- [ ] ' + (index + 1) + '. ' + step.trim()),
    '',
    '## ' + SECTION_ACTIVE,
    NO_ACTIVE_STEP,
    '',
    '## ' + SECTION_DONE,
    ...DONE_TABLE_HEADER,
    '',
    '## ' + SECTION_DEVIATIONS,
    NOTHING_YET,
  ];
  return fromLines(lines);
}

/* ------------------------------------------------------------------ *
 * Uitlezen
 * ------------------------------------------------------------------ */

export function goalOf(text: string): string {
  const lines = toLines(text);
  const index = lines.findIndex((line) => line.trim() === '# Doel');
  if (index < 0) throw new RunFileError('kopje `# Doel` ontbreekt in het run-bestand');
  const body = trimBlank(lines.slice(index + 1, lines.findIndex((line, at) => at > index && line.startsWith('## '))));
  const goal = body.join(' ').trim();
  if (goal === '') throw new RunFileError('het doel is leeg');
  return goal;
}

const PLAN_LINE = /^- \[( |\/|x|-)\] (\d+)\.\s*(.*)$/;

export function planOf(text: string): PlanItem[] {
  const lines = toLines(text);
  const section = findSection(lines, SECTION_PLAN);
  const items: PlanItem[] = [];
  for (let at = section.start; at < section.end; at += 1) {
    const match = PLAN_LINE.exec(lines[at]!.trim());
    if (!match) continue;
    items.push({
      line: at,
      number: Number(match[2]),
      status: MARK_STATUS[match[1]!]!,
      label: match[3]!.trim(),
    });
  }
  return items;
}

export function activeStepOf(text: string): string[] {
  const body = sectionBody(toLines(text), SECTION_ACTIVE);
  return body.length === 1 && body[0] === NO_ACTIVE_STEP ? [] : body;
}

export function completedCountOf(text: string): number {
  const body = sectionBody(toLines(text), SECTION_DONE);
  // Alles voorbij de twee kopregels van de tabel is een afgeronde stap.
  return body.filter((line) => line.trim().startsWith('|')).length - DONE_TABLE_HEADER.length;
}

export function deviationsOf(text: string): string[] {
  const body = sectionBody(toLines(text), SECTION_DEVIATIONS);
  return body.length === 1 && body[0] === NOTHING_YET ? [] : body;
}

/** De eerstvolgende stap die nog niet klaar is. */
export function nextOpenStep(text: string): PlanItem | undefined {
  const plan = planOf(text);
  return plan.find((item) => item.status === 'busy') ?? plan.find((item) => item.status === 'open');
}

/* ------------------------------------------------------------------ *
 * Bijwerken
 * ------------------------------------------------------------------ */

export function setPlanStatus(text: string, stepNumber: number, status: PlanStatus): string {
  const lines = toLines(text);
  const item = planOf(text).find((candidate) => candidate.number === stepNumber);
  if (!item) throw new RunFileError('stap ' + stepNumber + ' staat niet in het plan');
  lines[item.line] = '- [' + STATUS_MARK[status] + '] ' + item.number + '. ' + item.label;
  return fromLines(lines);
}

export interface ActiveStep {
  seq: number;
  /** Tijd van zetten, als HH:MM. */
  at: string;
  instruction: string;
  /** De conditie in mensentaal, één regel. Leeg = niet machinaal detecteerbaar. */
  condition?: string;
}

export function setActiveStep(text: string, step: ActiveStep): string {
  const head = 'seq ' + step.seq + ' — gezet ' + step.at + ' — ' + step.instruction.trim();
  const body = [head, step.condition?.trim() ? step.condition.trim() : 'Geen conditie: niet machinaal detecteerbaar.'];
  return fromLines(replaceSection(toLines(text), SECTION_ACTIVE, body));
}

export function clearActiveStep(text: string): string {
  return fromLines(replaceSection(toLines(text), SECTION_ACTIVE, [NO_ACTIVE_STEP]));
}

/**
 * Een afgeronde stap wegschrijven: regel in de tabel, vinkje in het plan, actieve
 * stap leeg. Dit hoort te gebeuren op het moment dat de stap afgaat en niet aan het
 * eind van de run — een gesloten venster mag hoogstens de actieve stap kosten.
 */
export function completeStep(
  text: string,
  options: { at: string; note?: string; stepNumber?: number },
): { text: string; step: PlanItem } {
  const target =
    options.stepNumber !== undefined
      ? planOf(text).find((item) => item.number === options.stepNumber)
      : nextOpenStep(text);
  if (!target) {
    throw new RunFileError(
      options.stepNumber !== undefined
        ? 'stap ' + options.stepNumber + ' staat niet in het plan'
        : 'er staat geen open stap meer in het plan; is de run al af?',
    );
  }

  const note = options.note?.trim() ? options.note.trim() : '—';
  const row = '| ' + options.at + ' | ' + target.number + '. ' + target.label + ' | ' + escapeCell(note) + ' |';

  let lines = toLines(text);
  const done = findSection(lines, SECTION_DONE);
  // Achter de laatste tabelregel, zodat hand-toegevoegde regels blijven staan.
  let insertAt = done.start;
  for (let at = done.start; at < done.end; at += 1) {
    if (lines[at]!.trim().startsWith('|')) insertAt = at + 1;
  }
  if (insertAt === done.start) {
    throw new RunFileError('de tabel onder `## ' + SECTION_DONE + '` mist zijn kopregels');
  }
  lines = [...lines.slice(0, insertAt), row, ...lines.slice(insertAt)];

  const withTick = setPlanStatus(fromLines(lines), target.number, 'done');
  return { text: clearActiveStep(withTick), step: target };
}

export function addDeviation(text: string, note: string): string {
  if (note.trim() === '') throw new RunFileError('een afwijking heeft tekst nodig');
  const lines = toLines(text);
  const existing = deviationsOf(text);
  const body = [...existing, '- ' + note.trim()];
  return fromLines(replaceSection(lines, SECTION_DEVIATIONS, body));
}

function escapeCell(value: string): string {
  // Een pipe in een cel breekt de tabel.
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/* ------------------------------------------------------------------ *
 * Archiveren
 * ------------------------------------------------------------------ */

/** Verboden in een Windows-bestandsnaam. */
const UNSAFE = /[\\/:*?"<>|]/g;

export function runLabel(goal: string): string {
  // De eerste zin van het doel, want het doel mag twee zinnen zijn en een
  // bestandsnaam niet. Punt, uitroepteken of regeleinde sluit de zin af.
  const firstSentence = goal.split(/[.!\n]/)[0] ?? goal;
  const cleaned = firstSentence.replace(UNSAFE, '').replace(/\s+/g, ' ').trim();
  const cut = cleaned.length > 60 ? cleaned.slice(0, 60).trimEnd() : cleaned;
  return cut === '' ? 'run' : cut;
}

/**
 * `YYYY-MM-DD doel.md`, en bij een tweede run op één dag ` (2)` erachter.
 * `taken` is wat er al in `runs/` staat.
 */
export function archiveName(options: { date: string; label: string; taken: string[] }): string {
  const base = options.date + ' ' + options.label;
  if (!options.taken.includes(base + '.md')) return base + '.md';
  for (let n = 2; n < 100; n += 1) {
    const candidate = base + ' (' + n + ').md';
    if (!options.taken.includes(candidate)) return candidate;
  }
  throw new RunFileError('meer dan 99 runs met dezelfde naam op één dag');
}

/* ------------------------------------------------------------------ *
 * Weergave
 * ------------------------------------------------------------------ */

/** Korte stand voor een logregel of een bericht in de chat. */
export function summarize(text: string): string {
  const plan = planOf(text);
  const done = plan.filter((item) => item.status === 'done').length;
  const dropped = plan.filter((item) => item.status === 'dropped').length;
  const active = activeStepOf(text);
  const parts = [
    done + ' van ' + plan.length + ' stappen klaar',
    ...(dropped > 0 ? [dropped + ' vervallen'] : []),
    active.length > 0 ? 'actief: ' + active[0] : 'geen actieve stap',
  ];
  const deviations = deviationsOf(text).length;
  if (deviations > 0) parts.push(deviations + (deviations === 1 ? ' afwijking' : ' afwijkingen'));
  return parts.join(' — ');
}
