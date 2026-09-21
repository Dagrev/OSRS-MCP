/**
 * De I/O-kant van taken: `tasks/<id>.json` en `tasks/<id>.progress.json` (ORS-025).
 *
 * Zwaartepunt, net als bij `runfile.test.ts`: een onbereikbare datamap is een andere
 * fout dan "geen taken", en mag daar nooit voor doorgaan.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { PluginDataError } from "../src/plugindata.js";
import {
  TaskWriteError,
  deleteTask,
  listTaskIds,
  readTaskDefinitionRaw,
  readTaskProgressRaw,
  taskDefinitionPath,
  taskProgressPath,
  tasksDir,
  writeTaskDefinition,
} from "../src/taskfile.js";

const DATA_DIR_ENV = "OSRS_MCP_DATA_DIR";
const created: string[] = [];

const freshDataDir = async (options: { withTasksDir: boolean }): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "osrs-tasks-"));
  created.push(dir);
  if (options.withTasksDir) await mkdir(join(dir, "tasks"));
  process.env[DATA_DIR_ENV] = dir;
  return dir;
};

after(async () => {
  for (const dir of created) await rm(dir, { recursive: true, force: true });
  delete process.env[DATA_DIR_ENV];
});

const SAMPLE_TASK = {
  id: "2026-09-21-woodcutting-40-50",
  goal: "Woodcutting van 40 naar 50",
  createdAt: "2026-09-21T10:00:00.000Z",
  steps: [
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
  ],
};

const SAMPLE_PROGRESS = {
  status: "active",
  activeStepIndex: 1,
  steps: [{ completedAt: "2026-09-21T10:03:42.000Z", completedBy: "autonomous" }, null],
};

/* ------------------------------------------------------------------ *
 * Onbereikbare map versus geen taken
 * ------------------------------------------------------------------ */

test("een onbereikbare datamap is een fout, nooit stilzwijgend geen taken", async () => {
  process.env[DATA_DIR_ENV] = join(tmpdir(), "osrs-tasks-bestaat-niet-" + Date.now());

  await assert.rejects(
    () => listTaskIds(),
    (error: unknown) => {
      assert.ok(error instanceof PluginDataError);
      assert.equal(error.kind, "dir_unavailable");
      return true;
    },
  );
});

test("de melding bij een onbereikbare map noemt het pad", async () => {
  const path = join(tmpdir(), "osrs-tasks-weg-" + Date.now());
  process.env[DATA_DIR_ENV] = path;

  await assert.rejects(
    () => listTaskIds(),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, new RegExp(path.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
      return true;
    },
  );
});

test("een bereikbare map zonder tasks-map betekent: geen taken", async () => {
  await freshDataDir({ withTasksDir: false });
  assert.deepEqual(await listTaskIds(), []);
});

test("een bereikbare tasks-map zonder bestanden betekent ook: geen taken", async () => {
  await freshDataDir({ withTasksDir: true });
  assert.deepEqual(await listTaskIds(), []);
});

/* ------------------------------------------------------------------ *
 * Schrijven en lezen
 * ------------------------------------------------------------------ */

test("writeTaskDefinition maakt tasks/ zelf aan, anders dan het run-bestand", async () => {
  await freshDataDir({ withTasksDir: false });
  await writeTaskDefinition(SAMPLE_TASK.id, SAMPLE_TASK);

  assert.deepEqual(await readTaskDefinitionRaw(SAMPLE_TASK.id), SAMPLE_TASK);
});

test("schrijven laat geen tijdelijk bestand achter", async () => {
  await freshDataDir({ withTasksDir: true });
  await writeTaskDefinition(SAMPLE_TASK.id, SAMPLE_TASK);

  const entries = await readdir(tasksDir());
  assert.deepEqual(entries, [`${SAMPLE_TASK.id}.json`]);
});

test("listTaskIds ziet alleen definities, niet de voortgang", async () => {
  await freshDataDir({ withTasksDir: true });
  await writeTaskDefinition(SAMPLE_TASK.id, SAMPLE_TASK);
  await writeFile(taskProgressPath(SAMPLE_TASK.id), JSON.stringify(SAMPLE_PROGRESS), "utf8");

  assert.deepEqual(await listTaskIds(), [SAMPLE_TASK.id]);
});

test("een taak die niet bestaat geeft null, geen fout", async () => {
  await freshDataDir({ withTasksDir: true });
  assert.equal(await readTaskDefinitionRaw("bestaat-niet"), null);
});

test("een taak zonder voortgangsbestand is 'niet gestart': null, geen fout", async () => {
  await freshDataDir({ withTasksDir: true });
  await writeTaskDefinition(SAMPLE_TASK.id, SAMPLE_TASK);

  assert.equal(await readTaskProgressRaw(SAMPLE_TASK.id), null);
});

test("een voortgangsbestand dat er wél is, komt met zijn wijzigingstijd terug", async () => {
  await freshDataDir({ withTasksDir: true });
  await writeTaskDefinition(SAMPLE_TASK.id, SAMPLE_TASK);
  await writeFile(taskProgressPath(SAMPLE_TASK.id), JSON.stringify(SAMPLE_PROGRESS), "utf8");

  const progress = await readTaskProgressRaw(SAMPLE_TASK.id);
  assert.ok(progress !== null);
  assert.deepEqual(progress!.data, SAMPLE_PROGRESS);
  assert.ok(progress!.fileModified.length > 0);
});

test("een leeg voortgangsbestand is onleesbaar, niet 'niet gestart'", async () => {
  await freshDataDir({ withTasksDir: true });
  await writeTaskDefinition(SAMPLE_TASK.id, SAMPLE_TASK);
  await writeFile(taskProgressPath(SAMPLE_TASK.id), "   \n", "utf8");

  await assert.rejects(
    () => readTaskProgressRaw(SAMPLE_TASK.id),
    (error: unknown) => {
      assert.ok(error instanceof PluginDataError);
      assert.equal(error.kind, "file_unreadable");
      return true;
    },
  );
});

test("schrijven naar een onbeschrijfbare map is een schrijffout, geen stille stilte", async () => {
  await freshDataDir({ withTasksDir: true });
  // Een bestaand bestand op de plek waar tasks/ moet komen maakt mkdir onmogelijk.
  process.env[DATA_DIR_ENV] = await mkdtemp(join(tmpdir(), "osrs-tasks-blocked-"));
  created.push(process.env[DATA_DIR_ENV]!);
  await writeFile(join(process.env[DATA_DIR_ENV]!, "tasks"), "ik ben geen map", "utf8");

  await assert.rejects(
    () => writeTaskDefinition(SAMPLE_TASK.id, SAMPLE_TASK),
    (error: unknown) => {
      assert.ok(error instanceof TaskWriteError);
      assert.equal(error.kind, "not_writable");
      assert.match(error.message, /niets geschreven/);
      return true;
    },
  );
});

/* ------------------------------------------------------------------ *
 * Verwijderen
 * ------------------------------------------------------------------ */

test("deleteTask verwijdert beide bestanden", async () => {
  await freshDataDir({ withTasksDir: true });
  await writeTaskDefinition(SAMPLE_TASK.id, SAMPLE_TASK);
  await writeFile(taskProgressPath(SAMPLE_TASK.id), JSON.stringify(SAMPLE_PROGRESS), "utf8");

  const result = await deleteTask(SAMPLE_TASK.id);

  assert.equal(result.progressExisted, true);
  assert.equal(await readTaskDefinitionRaw(SAMPLE_TASK.id), null);
  assert.equal(await readTaskProgressRaw(SAMPLE_TASK.id), null);
});

test("deleteTask zonder voortgangsbestand faalt niet op het ontbrekende deel", async () => {
  await freshDataDir({ withTasksDir: true });
  await writeTaskDefinition(SAMPLE_TASK.id, SAMPLE_TASK);

  const result = await deleteTask(SAMPLE_TASK.id);

  assert.equal(result.progressExisted, false);
  assert.equal(await readTaskDefinitionRaw(SAMPLE_TASK.id), null);
});

test("taskDefinitionPath en taskProgressPath wijzen naar tasks/<id>", async () => {
  await freshDataDir({ withTasksDir: true });
  assert.equal(taskDefinitionPath("x"), join(tasksDir(), "x.json"));
  assert.equal(taskProgressPath("x"), join(tasksDir(), "x.progress.json"));
});
