/**
 * De vier taak-tools: `create_task`, `list_tasks`, `get_task`, `delete_task` (ORS-025).
 *
 * Dit is de brug uit [[Plan van aanpak herbouw]] §3: Claude plant, de server schrijft
 * de taak weg volgens het Stapcontract, de plugin voert hem straks uit (ORS-027). Deze
 * server raakt `tasks/<id>.progress.json` nooit aan — dat is het schrijfterrein van de
 * plugin (§9).
 *
 * De opbouw volgt `set_step`/`runtools.ts`: eerst structureel valideren (`task.ts`,
 * geen I/O), dan de map, dan pas de bewerkingen die de omgeving nodig hebben (relatief
 * XP-doel omrekenen, bankstap-regel toetsen), en pas als dat allemaal klopt schrijven.
 * Niets landt half.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { PluginDataError, dataDir, readContainer, type ContainerKind } from "./plugindata.js";
import { DEAD_AFTER_SECONDS, readPlayerState } from "./playerstate.js";
import {
  describeCondition,
  itemTargets,
  relativeXpTargets,
  touchesContainer,
} from "./condition.js";
import { XpBaselineError, xpBaseline } from "./xpbaseline.js";
import {
  isBankDestination,
  uniqueTaskId,
  validateTaskSteps,
  type TaskDefinition,
  type TaskStep,
} from "./task.js";
import {
  TaskWriteError,
  deleteTask,
  listTaskIds,
  readTaskDefinitionRaw,
  readTaskProgressRaw,
  requireDataDir,
  writeTaskDefinition,
} from "./taskfile.js";

const nl = (n: number): string => n.toLocaleString("nl-NL");

const taskError = (error: unknown, what: string): string => {
  if (error instanceof TaskWriteError || error instanceof PluginDataError) {
    return error.message;
  }
  return `Onverwachte fout bij ${what}: ${
    error instanceof Error ? error.message : String(error)
  }`;
};

const dateStamp = (now: Date = new Date()): string => now.toISOString().slice(0, 10);

/** Eén regel per stap, voor de samenvatting die elke tool teruggeeft. */
const describeStep = (step: TaskStep, index: number): string => {
  const parts = [`${index + 1}. ${step.instruction}`];
  if (step.destination !== null) {
    parts.push(
      `→ ${step.destination.label ?? `${step.destination.x}, ${step.destination.y}`}` +
        (step.destination.plane === 0 ? "" : ` (verdieping ${step.destination.plane})`),
    );
  }
  if (step.items.length > 0) {
    parts.push(
      `spullen: ${step.items.map((item) => `${item.quantity}× ${item.name ?? item.itemId}`).join(", ")}`,
    );
  }
  parts.push(step.condition === null ? "geen conditie" : describeCondition(step.condition));
  return parts.join(" — ");
};

/**
 * Dezelfde waarschuwing als bij `set_step`: een itemconditie op `inventory` die de
 * speler op dit moment juist draagt, gaat nooit vanzelf af. Geen weigering — de
 * speler kan het zo afdoen — maar wel een melding, per stap.
 */
const wornClashWarnings = async (steps: TaskStep[]): Promise<string[]> => {
  const warnings: string[] = [];
  let worn: Awaited<ReturnType<typeof readContainer>> | null = null;

  for (const [index, step] of steps.entries()) {
    if (step.condition === null || touchesContainer(step.condition, "equipment")) continue;
    const wanted = itemTargets(step.condition, "inventory");
    if (wanted.length === 0) continue;

    if (worn === null) {
      try {
        worn = await readContainer("equipment");
      } catch {
        // Niet te lezen: dan is er ook niets te vergelijken. Geen fout — deze
        // waarschuwing is bijvangst, geen acceptatiecriterium.
        break;
      }
    }

    for (const target of wanted) {
      const wornItem = worn.items.find((item) => item.id === target.node.itemId);
      if (wornItem !== undefined) {
        warnings.push(
          `stap ${index + 1}: \`${target.path}\` vraagt item ${target.node.itemId}` +
            `${target.node.name ? ` (${target.node.name})` : ""} in de inventory, maar de ` +
            `speler draagt ${wornItem.name ?? "dat item"} nu — die conditie gaat zo nooit af.`,
        );
      }
    }
  }

  return warnings;
};

/** Telt hoeveel van een item er in de gegeven containers ligt. Geen bank: de
 * bankstap-regel bestaat juist om dat geval af te dwingen. */
const ownedQuantity = async (itemId: number, kinds: ContainerKind[]): Promise<number | null> => {
  let total = 0;
  let anyRead = false;
  for (const kind of kinds) {
    try {
      const data = await readContainer(kind);
      anyRead = true;
      total += data.items.filter((item) => item.id === itemId).reduce((sum, item) => sum + item.quantity, 0);
    } catch {
      // Onleesbaar telt niet mee als bezit — onzekerheid is geen bezit (materials.ts
      // hanteert dezelfde regel). Een van de twee bronnen ontbreekt dan.
    }
  }
  return anyRead ? total : null;
};

const TASK_HELP = [
  "Een taak is een lijst stappen die de plugin straks zelf afwerkt. Elke stap heeft:",
  "- `instruction`: de tekst voor de speler.",
  "- `destination`: optioneel een coördinaat (`x`, `y`, `plane`, `label`). Zoek hem op " +
    "met `find_destination` — deze tool resolveert geen namen.",
  "- `items`: optioneel de spullen die deze stap vraagt (`itemId`, `quantity`, `name`). " +
    "Een stap met spullen moet een stap ervoor hebben die naar een bank stuurt (een " +
    "`destination` op een bankpunt), tenzij de speler ze nu al bij zich heeft — dat " +
    "wordt bij het aanmaken gecontroleerd.",
  "- `condition`: verplicht veld (mag `null` zijn). Streng gevalideerd: een boom van " +
    "`position`, `region`, `item`, `skillLevel`, `skillXp` (met `minXp` of `xpGain`) en " +
    "`quest`, samengevoegd met `all`/`any`/`not`. Onbekende velden worden geweigerd.",
  "",
  "Hoe je tot deze stappen komt — welke tools je eerst raadpleegt, de vaste vorm per " +
    "stap, en wanneer een conditie het resultaat toetst in plaats van alleen de positie " +
    "— staat in de prompt `plan_task`. Gebruik die om een taak op te bouwen; deze tool " +
    "schrijft hem alleen weg en valideert.",
].join("\n");

export const registerTaskTools = (server: McpServer): void => {
  server.registerTool(
    "create_task",
    {
      title: "Een taak aanmaken",
      description:
        "Schrijft een nieuwe taak naar `tasks/<id>.json`: een doel en een lijst stappen " +
        "die de plugin autonoom afwerkt. **Verandert niets in het spel** — er wordt " +
        "alleen een bestand neergezet. Een afgekeurd veld levert **niets geschreven** " +
        "op en een melding van wát er mis is en waar.\n\n" +
        TASK_HELP,
      inputSchema: {
        goal: z
          .string()
          .trim()
          .min(1, "Een doel mag niet leeg zijn.")
          .max(300, "Houd het doel tot een paar zinnen beperkt.")
          .describe("Wat de taak oplevert, in gewone taal — bijvoorbeeld 'Woodcutting van 40 naar 50'."),
        steps: z
          .array(z.unknown())
          .min(1, "Een taak heeft minstens één stap nodig.")
          .describe("De stappen, in uitvoervolgorde. Zie de beschrijving van deze tool voor het schema per stap."),
      },
    },
    async ({ goal, steps: rawSteps }) => {
      const fail = (text: string) => ({
        content: [{ type: "text" as const, text }],
        isError: true,
      });

      // 1. Structuur valideren — geen I/O, dus dit kost niets als het toch afgekeurd wordt.
      const validation = validateTaskSteps(rawSteps);
      if (!validation.ok) {
        return fail(
          [
            "**De taak is afgekeurd; er is niets geschreven.**",
            "",
            ...validation.problems.map((problem) => `- \`${problem.path}\` ${problem.message}`),
          ].join("\n"),
        );
      }
      const { steps, ownershipChecks } = validation;

      // 2. De datamap moet bereikbaar zijn vóór er iets omgerekend of geschreven wordt.
      try {
        await requireDataDir();
      } catch (error: unknown) {
        return fail(taskError(error, "het aanmaken van de taak"));
      }

      // 3. Relatieve XP-doelen omrekenen, per stap — zelfde regel als `set_step`.
      for (const step of steps) {
        if (step.condition === null) continue;
        for (const target of relativeXpTargets(step.condition)) {
          try {
            const baseline = await xpBaseline(target.node.skill);
            target.node.minXp = baseline.xp + target.node.xpGain!;
            target.node.baselineXp = baseline.xp;
            target.node.baselineAt = baseline.at;
            delete target.node.xpGain;
          } catch (error: unknown) {
            const reason =
              error instanceof XpBaselineError
                ? error.message
                : `Onverwachte fout bij het omrekenen van het XP-doel: ${
                    error instanceof Error ? error.message : String(error)
                  }`;
            return fail(`${reason}\n\nHet gaat om \`${target.path}\` (${target.node.skill}).`);
          }
        }
      }

      // 4. Bankstap-regel: elk item zonder voorafgaande bankstap moet nu al in de
      // inventory of de uitrusting zitten. Onleesbare bronnen tellen niet als bezit.
      if (ownershipChecks.length > 0) {
        const problems: string[] = [];
        for (const check of ownershipChecks) {
          const have = await ownedQuantity(check.item.itemId, ["inventory", "equipment"]);
          if (have === null || have < check.item.quantity) {
            problems.push(
              `stap ${check.stepIndex + 1}: vraagt ${check.item.quantity}× ` +
                `${check.item.name ?? check.item.itemId} zonder dat er een stap ervoor naar ` +
                "een bank stuurt, en " +
                (have === null
                  ? "de inventory en uitrusting zijn nu niet te lezen, dus bezit is onbekend."
                  : `de speler heeft er nu ${have}.`),
            );
          }
        }
        if (problems.length > 0) {
          return fail(
            [
              "**De taak is afgekeurd; er is niets geschreven.**",
              "",
              "Een stap die spullen vraagt heeft een voorafgaande bankstap nodig " +
                "(een `destination` op een bankpunt), tenzij de speler ze al bij zich heeft:",
              "",
              ...problems.map((p) => `- ${p}`),
              "",
              "Voeg een stap toe die naar een bank stuurt, of laat de spullen weg als de " +
                "speler ze al heeft.",
            ].join("\n"),
          );
        }
      }

      // 5. Bijvangst: waarschuwen voor een itemconditie die nooit afgaat omdat het
      // gevraagde item nu juist gedragen wordt. Geen weigering.
      const wornWarnings = await wornClashWarnings(steps);

      // 6. Id bepalen en wegschrijven.
      let existingIds: string[];
      try {
        existingIds = await listTaskIds();
      } catch (error: unknown) {
        return fail(taskError(error, "het aanmaken van de taak"));
      }
      const id = uniqueTaskId(dateStamp(), goal, existingIds);

      const definition: TaskDefinition = {
        id,
        goal,
        createdAt: new Date().toISOString(),
        steps,
      };

      let path: string;
      try {
        path = await writeTaskDefinition(id, definition);
      } catch (error: unknown) {
        return fail(taskError(error, "het aanmaken van de taak"));
      }

      const lines = [
        `# Taak aangemaakt: \`${id}\``,
        "",
        `- Doel: **${goal}**`,
        `- ${nl(steps.length)} stap(pen), geschreven naar \`${path}\``,
        "",
        ...steps.map((step, index) => `- ${describeStep(step, index)}`),
      ];
      if (wornWarnings.length > 0) {
        lines.push("", "**Let op:**", ...wornWarnings.map((w) => `- ${w}`));
      }
      lines.push(
        "",
        "De plugin pakt deze taak op zodra de speler hem in het taakmenu start; er is " +
          "nog geen voortgang totdat dat gebeurt.",
      );

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.registerTool(
    "list_tasks",
    {
      title: "Alle taken opvragen",
      description:
        "Geeft alle taken in `tasks/` met hun status en actieve stap uit het " +
        "voortgangsbestand, nieuwste eerst. **Verandert niets.** Een onbereikbare " +
        "datamap is een eigen fout die het pad noemt, nooit 'geen taken'.",
      inputSchema: {},
    },
    async () => {
      const fail = (text: string) => ({
        content: [{ type: "text" as const, text }],
        isError: true,
      });

      let ids: string[];
      try {
        ids = await listTaskIds();
      } catch (error: unknown) {
        return fail(taskError(error, "het opvragen van de taken"));
      }

      if (ids.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `Geen taken in \`${dataDir()}/tasks\`. Maak er een aan met \`create_task\`.`,
            },
          ],
        };
      }

      const rows: { id: string; goal: string; createdAt: string; status: string; active: string }[] = [];
      for (const id of ids) {
        let definition: Record<string, unknown> | null;
        try {
          definition = await readTaskDefinitionRaw(id);
        } catch (error: unknown) {
          rows.push({
            id,
            goal: `(niet te lezen: ${taskError(error, "het lezen van deze taak")})`,
            createdAt: "",
            status: "onbekend",
            active: "—",
          });
          continue;
        }
        if (definition === null) continue; // race: net verwijderd tussen readdir en read

        const goal = typeof definition["goal"] === "string" ? definition["goal"] : "(geen doel)";
        const createdAt = typeof definition["createdAt"] === "string" ? definition["createdAt"] : "";
        const steps = Array.isArray(definition["steps"]) ? definition["steps"] : [];

        let progress: { data: Record<string, unknown>; fileModified: string } | null;
        try {
          progress = await readTaskProgressRaw(id);
        } catch {
          progress = null;
        }

        const status = typeof progress?.data["status"] === "string" ? (progress.data["status"] as string) : "not_started";
        const activeIndex = typeof progress?.data["activeStepIndex"] === "number" ? progress.data["activeStepIndex"] : null;
        const active =
          activeIndex === null
            ? "—"
            : `stap ${activeIndex + 1} van ${steps.length}`;

        rows.push({ id, goal, createdAt, status, active });
      }

      rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

      const lines = [
        `${nl(rows.length)} taak/taken in \`${dataDir()}/tasks\`, nieuwste eerst.`,
        "",
        "| Id | Doel | Status | Actieve stap |",
        "| --- | --- | --- | --- |",
        ...rows.map((row) => `| \`${row.id}\` | ${row.goal} | ${row.status} | ${row.active} |`),
      ];

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.registerTool(
    "get_task",
    {
      title: "Eén taak opvragen",
      description:
        "Geeft de definitie en de voortgang van één taak samen. **Verandert niets.** " +
        "Bestaat de taak niet, dan is dat de melding — geen fout over de datamap, tenzij " +
        "die zelf onbereikbaar is.",
      inputSchema: {
        id: z.string().trim().min(1).describe("De taak-id, zoals teruggegeven door create_task of list_tasks."),
      },
    },
    async ({ id }) => {
      const fail = (text: string) => ({
        content: [{ type: "text" as const, text }],
        isError: true,
      });

      let definition: Record<string, unknown> | null;
      try {
        definition = await readTaskDefinitionRaw(id);
      } catch (error: unknown) {
        return fail(taskError(error, "het opvragen van de taak"));
      }
      if (definition === null) {
        return fail(`Taak \`${id}\` bestaat niet in \`${dataDir()}/tasks\`.`);
      }

      const goal = typeof definition["goal"] === "string" ? definition["goal"] : "(geen doel)";
      const createdAt = typeof definition["createdAt"] === "string" ? definition["createdAt"] : "onbekend";
      const rawSteps = Array.isArray(definition["steps"]) ? definition["steps"] : [];

      const lines = [
        `# Taak \`${id}\``,
        "",
        `- Doel: **${goal}**`,
        `- Aangemaakt: ${createdAt}`,
        `- ${nl(rawSteps.length)} stap(pen)`,
        "",
        "## Stappen",
        "",
        ...rawSteps.map((raw, index) => `${index + 1}. ${JSON.stringify(raw)}`),
      ];

      let progress: { data: Record<string, unknown>; fileModified: string } | null;
      try {
        progress = await readTaskProgressRaw(id);
      } catch (error: unknown) {
        lines.push("", "## Voortgang", "", `Niet te lezen: ${taskError(error, "het lezen van de voortgang")}`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      lines.push("", "## Voortgang", "");
      if (progress === null) {
        lines.push("Nog geen voortgangsbestand — de plugin heeft deze taak nog niet opgepakt.");
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      const status = typeof progress.data["status"] === "string" ? progress.data["status"] : "onbekend";
      const activeIndex =
        typeof progress.data["activeStepIndex"] === "number" ? progress.data["activeStepIndex"] : null;
      const stepsProgress = Array.isArray(progress.data["steps"]) ? progress.data["steps"] : [];
      const doneCount = stepsProgress.filter((s) => s !== null).length;

      lines.push(
        `- Status: **${status}**`,
        `- Actieve stap: ${activeIndex === null ? "onbekend" : `${activeIndex + 1} van ${rawSteps.length}`}`,
        `- ${nl(doneCount)} van ${nl(stepsProgress.length)} stappen voltooid`,
        `- Voortgangsbestand voor het laatst gewijzigd: ${progress.fileModified}`,
      );

      // Versheid, §5 van het contract: R1/R2 meten tegen het moment van lezen. Het
      // voortgangsbestand zelf heeft geen hartslag (de plugin schrijft alleen bij
      // verandering, §9), dus `player-state.json` is hier de enige onafhankelijke
      // aanwijzing of de speler nog leeft.
      try {
        const state = await readPlayerState();
        const age = state.ageSeconds;
        if (age !== null && age > DEAD_AFTER_SECONDS) {
          lines.push(
            "",
            `**Let op: \`player-state.json\` is ${Math.round(age)} seconden oud — de client ` +
              "draait vermoedelijk niet meer.** De status hierboven is dan de laatste stand " +
              "van vóór het afsluiten, niet per se van nu.",
          );
        }
      } catch (error: unknown) {
        lines.push(
          "",
          `Spelstaat niet te lezen (${
            error instanceof Error ? error.message : String(error)
          }) — geen onafhankelijke aanwijzing of de client nog draait.`,
        );
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.registerTool(
    "delete_task",
    {
      title: "Een taak verwijderen",
      description:
        "Verwijdert definitie en voortgang van een taak. Weigert als de taak volgens de " +
        "voortgang `active` is, tenzij `force: true` meegegeven wordt. **Onomkeerbaar.**",
      inputSchema: {
        id: z.string().trim().min(1).describe("De taak-id."),
        force: z
          .boolean()
          .optional()
          .describe("Verwijder ook als de taak actief is. Standaard false."),
      },
    },
    async ({ id, force }) => {
      const fail = (text: string) => ({
        content: [{ type: "text" as const, text }],
        isError: true,
      });

      let definition: Record<string, unknown> | null;
      try {
        definition = await readTaskDefinitionRaw(id);
      } catch (error: unknown) {
        return fail(taskError(error, "het verwijderen van de taak"));
      }
      if (definition === null) {
        return fail(`Taak \`${id}\` bestaat niet in \`${dataDir()}/tasks\`; er is niets verwijderd.`);
      }

      let progress: { data: Record<string, unknown>; fileModified: string } | null;
      try {
        progress = await readTaskProgressRaw(id);
      } catch (error: unknown) {
        return fail(taskError(error, "het verwijderen van de taak"));
      }

      const status = typeof progress?.data["status"] === "string" ? progress.data["status"] : null;
      if (status === "active" && force !== true) {
        return fail(
          `Taak \`${id}\` is actief volgens de voortgang; er is niets verwijderd. Geef ` +
            "`force: true` als de taak toch weg moet, bijvoorbeeld omdat de speler er in " +
            "de client zelf al mee gestopt is.",
        );
      }

      try {
        await deleteTask(id);
      } catch (error: unknown) {
        return fail(taskError(error, "het verwijderen van de taak"));
      }

      const goal = typeof definition["goal"] === "string" ? definition["goal"] : id;
      return {
        content: [
          {
            type: "text",
            text:
              `Taak \`${id}\` verwijderd: "${goal}".` +
              (status === "active" ? " Was actief; verwijderd met `force`." : ""),
          },
        ],
      };
    },
  );
};

export { requireDataDir, dataDir };
