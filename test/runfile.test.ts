/**
 * De I/O-kant van het run-bestand (ORS-024).
 *
 * Het zwaartepunt ligt op één onderscheid: "de datamap is onbereikbaar" tegenover
 * "er loopt geen run". Die twee zien er in de syscall identiek uit (ENOENT) en
 * betekenen het tegenovergestelde. Wie ze verwart, adviseert een nieuwe run te
 * beginnen terwijl er een loopt — dat is de bug die aan de andere kant als OSC-007
 * is gerepareerd, en deze tools mogen hem niet opnieuw introduceren.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { PluginDataError } from "../src/plugindata.js";
import {
  RunWriteError,
  archiveCurrentRun,
  currentRunPath,
  discardCurrentRun,
  listRuns,
  readCurrentRun,
  runsDir,
  writeCurrentRun,
} from "../src/runfile.js";
import { clockNow, dateNow } from "../src/runtools.js";
import {
  completeStep,
  createRunText,
  nextOpenStep,
  setPlanStatus,
  summarize,
} from "../src/run.js";

const DATA_DIR_ENV = "OSRS_MCP_DATA_DIR";
const created: string[] = [];

/** Een verse datamap, met `runs/` als daarom gevraagd wordt. */
const freshDataDir = async (options: { withRunsDir: boolean }): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "osrs-run-"));
  created.push(dir);
  if (options.withRunsDir) await mkdir(join(dir, "runs"));
  process.env[DATA_DIR_ENV] = dir;
  return dir;
};

after(async () => {
  for (const dir of created) await rm(dir, { recursive: true, force: true });
  delete process.env[DATA_DIR_ENV];
});

const SAMPLE = createRunText({
  goal: "Cooks Assistant afronden.",
  plan: ["Meel halen", "Ei halen", "Emmer melk halen"],
});

test("een onbereikbare datamap is een fout, nooit stilzwijgend geen run", async () => {
  process.env[DATA_DIR_ENV] = join(tmpdir(), "osrs-bestaat-echt-niet-" + Date.now());

  await assert.rejects(
    () => readCurrentRun(),
    (error: unknown) => {
      assert.ok(error instanceof PluginDataError);
      assert.equal(error.kind, "dir_unavailable");
      return true;
    },
  );
});

test("de melding bij een onbereikbare map noemt het pad", async () => {
  const path = join(tmpdir(), "osrs-weg-" + Date.now());
  process.env[DATA_DIR_ENV] = path;

  await assert.rejects(
    () => readCurrentRun(),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, new RegExp(path.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
      return true;
    },
  );
});

test("een bereikbare map zonder runs-map betekent wél: er loopt geen run", async () => {
  await freshDataDir({ withRunsDir: false });
  assert.equal(await readCurrentRun(), null);
});

test("een bereikbare runs-map zonder current-run.md betekent ook: geen run", async () => {
  await freshDataDir({ withRunsDir: true });
  assert.equal(await readCurrentRun(), null);
});

test("een leeg current-run.md is onleesbaar, niet 'geen run'", async () => {
  await freshDataDir({ withRunsDir: true });
  await writeFile(currentRunPath(), "   \n", "utf8");

  await assert.rejects(
    () => readCurrentRun(),
    (error: unknown) => {
      assert.ok(error instanceof PluginDataError);
      assert.equal(error.kind, "file_unreadable");
      return true;
    },
  );
});

test("listRuns geeft een lege lijst als runs/ nog niet bestaat", async () => {
  await freshDataDir({ withRunsDir: false });
  assert.deepEqual(await listRuns(), []);
});

test("schrijven en teruglezen levert exact hetzelfde bestand op", async () => {
  await freshDataDir({ withRunsDir: true });
  await writeCurrentRun(SAMPLE);
  assert.equal(await readCurrentRun(), SAMPLE);
});

test("schrijven laat geen tijdelijk bestand achter", async () => {
  await freshDataDir({ withRunsDir: true });
  await writeCurrentRun(SAMPLE);

  const entries = await readdir(runsDir());
  assert.deepEqual(entries, ["current-run.md"]);
});

test("schrijven naar een ontbrekende runs-map is een schrijffout, geen stille stilte", async () => {
  await freshDataDir({ withRunsDir: false });

  await assert.rejects(
    () => writeCurrentRun(SAMPLE),
    (error: unknown) => {
      assert.ok(error instanceof RunWriteError);
      assert.equal(error.kind, "not_writable");
      assert.match(error.message, /niets geschreven/);
      return true;
    },
  );
});

test("archiveren hernoemt en verwijdert niets", async () => {
  await freshDataDir({ withRunsDir: true });
  await writeCurrentRun(SAMPLE);

  const name = await archiveCurrentRun({
    goal: "Cooks Assistant afronden.",
    date: "2026-09-21",
  });

  assert.equal(name, "2026-09-21 Cooks Assistant afronden.md");
  assert.equal(await readCurrentRun(), null);
  assert.equal(await readFile(join(runsDir(), name), "utf8"), SAMPLE);
});

test("een tweede run met hetzelfde doel op één dag krijgt (2) achter zich", async () => {
  await freshDataDir({ withRunsDir: true });

  await writeCurrentRun(SAMPLE);
  await archiveCurrentRun({ goal: "Cooks Assistant afronden.", date: "2026-09-21" });
  await writeCurrentRun(SAMPLE);
  const second = await archiveCurrentRun({
    goal: "Cooks Assistant afronden.",
    date: "2026-09-21",
  });

  assert.equal(second, "2026-09-21 Cooks Assistant afronden (2).md");
  const entries = (await listRuns()).sort();
  assert.deepEqual(entries, [
    "2026-09-21 Cooks Assistant afronden (2).md",
    "2026-09-21 Cooks Assistant afronden.md",
  ]);
});

/* ------------------------------------------------------------------ *
 * De zwaarste eis: wie het bestand met de hand aanpast, heeft gelijk
 * ------------------------------------------------------------------ */

test("een handmatige correctie overleeft een tool-bewerking, over het bestand heen", async () => {
  await freshDataDir({ withRunsDir: true });
  await writeCurrentRun(SAMPLE);

  // De eigenaar verbouwt het bestand: een eigen sectie, een eigen regel in de tabel,
  // een aangepast steplabel en een losse notitie.
  const byHand = (await readCurrentRun())!
    .replace("- [ ] 2. Ei halen", "- [ ] 2. Ei halen (bij de boer ten zuiden van Lumbridge)")
    .replace(
      "## Afwijkingen en open vragen",
      "## Mijn eigen aantekeningen\nDe koe staat altijd in de noordwesthoek.\n\n## Afwijkingen en open vragen",
    );
  await writeCurrentRun(byHand);

  // Een tool vinkt de eerstvolgende stap af.
  const result = completeStep((await readCurrentRun())!, { at: "20:15", note: "ging vlot" });
  await writeCurrentRun(result.text);

  const after = (await readCurrentRun())!;
  assert.match(after, /2\. Ei halen \(bij de boer ten zuiden van Lumbridge\)/);
  assert.match(after, /## Mijn eigen aantekeningen/);
  assert.match(after, /De koe staat altijd in de noordwesthoek\./);
  assert.match(after, /\| 20:15 \| 1\. Meel halen \| ging vlot \|/);
});

/* ------------------------------------------------------------------ *
 * De klok
 * ------------------------------------------------------------------ */

test("tijden staan in de tijdzone van de speler, niet in die van de container", () => {
  const previous = process.env["OSRS_MCP_TIMEZONE"];
  delete process.env["OSRS_MCP_TIMEZONE"];

  // 2026-09-21 21:30 UTC is 23:30 in Amsterdam, en nog steeds dezelfde dag.
  const moment = new Date("2026-09-21T21:30:00Z");
  assert.equal(clockNow(moment), "23:30");
  assert.equal(dateNow(moment), "2026-09-21");

  // 22:30 UTC is in Amsterdam al de dag erna — precies het geval waarin een avondrun
  // anders op de verkeerde datum zou worden gearchiveerd.
  const late = new Date("2026-09-21T22:30:00Z");
  assert.equal(clockNow(late), "00:30");
  assert.equal(dateNow(late), "2026-09-22");

  if (previous !== undefined) process.env["OSRS_MCP_TIMEZONE"] = previous;
});

test("een andere tijdzone is in te stellen", () => {
  process.env["OSRS_MCP_TIMEZONE"] = "UTC";
  assert.equal(clockNow(new Date("2026-09-21T21:30:00Z")), "21:30");
  delete process.env["OSRS_MCP_TIMEZONE"];
});

/* ------------------------------------------------------------------ *
 * Een stap laten vervallen
 * ------------------------------------------------------------------ */

test("een vervallen stap krijgt [-] en telt niet meer als open", async () => {
  await freshDataDir({ withRunsDir: true });
  await writeCurrentRun(SAMPLE);

  const dropped = setPlanStatus((await readCurrentRun())!, 1, "dropped");
  await writeCurrentRun(dropped);

  const after = (await readCurrentRun())!;
  assert.match(after, /- \[-\] 1\. Meel halen/);
  // De eerstvolgende open stap slaat de vervallen stap over.
  assert.equal(nextOpenStep(after)?.number, 2);
  // En de samenvatting benoemt hem apart, niet als afgerond.
  assert.match(summarize(after), /0 van 3 stappen klaar/);
  assert.match(summarize(after), /1 vervallen/);
});

test("een vervallen stap is iets anders dan een afgevinkte", async () => {
  await freshDataDir({ withRunsDir: true });
  await writeCurrentRun(SAMPLE);

  const dropped = setPlanStatus(SAMPLE, 1, "dropped");
  const done = completeStep(SAMPLE, { at: "20:15" }).text;

  // Dit is precies het verschil dat in de doorloop van 2026-09-21 verloren ging: een
  // overgeslagen stap werd als gedaan geboekt omdat er geen ander werkwoord was.
  assert.match(dropped, /- \[-\] 1\./);
  assert.match(done, /- \[x\] 1\./);
  assert.doesNotMatch(dropped, /\| 1\. Meel halen \|/);
  assert.match(done, /\| 1\. Meel halen \|/);
});

/* ------------------------------------------------------------------ *
 * Weggooien is expliciet en begrensd
 * ------------------------------------------------------------------ */

test("weggooien haalt de lopende run weg", async () => {
  await freshDataDir({ withRunsDir: true });
  await writeCurrentRun(SAMPLE);

  await discardCurrentRun();

  assert.equal(await readCurrentRun(), null);
  assert.deepEqual(await listRuns(), []);
});

test("weggooien raakt een gearchiveerde run niet aan", async () => {
  await freshDataDir({ withRunsDir: true });

  // Een echte run uit een eerdere sessie, netjes gearchiveerd.
  await writeCurrentRun(SAMPLE);
  const kept = await archiveCurrentRun({
    goal: "Cooks Assistant afronden.",
    date: "2026-09-20",
  });

  // En daarna een toetsrun die wél weg mag.
  await writeCurrentRun(createRunText({ goal: "Een toets.", plan: ["X"] }));
  await discardCurrentRun();

  // Het archief staat er nog, ongewijzigd. Dat is de grens uit contract paragraaf 7:
  // weggooien raakt hoogstens de lopende run.
  assert.deepEqual(await listRuns(), [kept]);
  assert.equal(await readFile(join(runsDir(), kept), "utf8"), SAMPLE);
});

test("weggooien zonder lopende run is een schrijffout, geen stilte", async () => {
  await freshDataDir({ withRunsDir: true });

  await assert.rejects(
    () => discardCurrentRun(),
    (error: unknown) => {
      assert.ok(error instanceof RunWriteError);
      assert.match(error.message, /niets kwijt/);
      return true;
    },
  );
});
