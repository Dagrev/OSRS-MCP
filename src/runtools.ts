/**
 * De twee tools rond het run-bestand: `get_run` en `update_run` (ORS-024).
 *
 * Twee en niet vijf, omdat elke tool plek kost in de systeemprompt van élke sessie.
 * `update_run` bundelt de vijf bewerkingen onder een `action`; dat is één tool met
 * een keuzeveld in plaats van vijf die zelden allemaal nodig zijn.
 *
 * De opbouw volgt `set_step`: valideren vóór er naar de map gekeken wordt, dan de map,
 * dan pas schrijven. Een afgekeurd argument mag nooit half landen.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { PluginDataError, dataDir } from "./plugindata.js";
import { DEAD_AFTER_SECONDS, readPlayerState } from "./playerstate.js";
import { readCurrentStep } from "./step.js";
import {
  RunFileError,
  activeStepOf,
  addDeviation,
  completeStep,
  createRunText,
  goalOf,
  nextOpenStep,
  setActiveStep,
  summarize,
} from "./run.js";
import {
  RunWriteError,
  archiveCurrentRun,
  currentRunPath,
  readCurrentRun,
  requireDataDir,
  writeCurrentRun,
} from "./runfile.js";

/**
 * De klok waarmee tijden in het run-bestand worden opgeschreven.
 *
 * De server draait in een container die vrijwel zeker op UTC staat, maar het bestand
 * wordt gelezen door iemand die naast zijn spel zit. Een run-bestand met tijden die
 * twee uur afwijken van de klok van de speler is onbruikbaar om "wat deed ik om 20:15"
 * mee te beantwoorden — en dat soort klokverschil heeft in ORS-013 al een keer een
 * halve sessie gekost. Daarom expliciet de tijdzone van de eigenaar, met een
 * ontsnappingsluik voor wie ergens anders speelt.
 */
const TIMEZONE_ENV = "OSRS_MCP_TIMEZONE";
const timeZone = (): string => {
  const configured = process.env[TIMEZONE_ENV]?.trim();
  return configured && configured.length > 0 ? configured : "Europe/Amsterdam";
};

/** `HH:MM` in de tijdzone van de eigenaar. */
export const clockNow = (now: Date = new Date()): string =>
  new Intl.DateTimeFormat("nl-NL", {
    timeZone: timeZone(),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);

/** `YYYY-MM-DD` in dezelfde tijdzone — anders archiveert een avondrun op de dag erna. */
export const dateNow = (now: Date = new Date()): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return parts;
};

const runError = (error: unknown, what: string): string => {
  if (
    error instanceof RunWriteError ||
    error instanceof PluginDataError ||
    error instanceof RunFileError
  ) {
    return error.message;
  }
  return `Onverwachte fout bij ${what}: ${
    error instanceof Error ? error.message : String(error)
  }`;
};

/**
 * Wat er te melden valt als er geen run loopt.
 *
 * Deze tekst mag alleen verschijnen als de datamap aantoonbaar bereikbaar was. Is dat
 * niet vastgesteld, dan is "er loopt geen run" een gok die een lopende run kan
 * overschrijven — de bug uit OSC-007.
 */
const NO_RUN = (path: string): string =>
  [
    `Er loopt geen run: "${path}" bestaat niet, en de map eromheen is wél bereikbaar.`,
    "",
    "Begin er een met `update_run` en `action: \"start\"`, met een doel en een plan.",
  ].join("\n");

/** Het nummer uit `seq 7 — gezet …` in de sectie *Actieve stap*, als het er staat. */
const activeSeqOf = (text: string): number | undefined => {
  const active = activeStepOf(text);
  if (active.length === 0) return undefined;
  const match = /^seq (\d+)/.exec(active[0]!);
  return match ? Number(match[1]) : undefined;
};

/**
 * De stand uit de snapshots naast het run-bestand, plus waar ze van elkaar afwijken.
 *
 * **Condities worden hier niet geëvalueerd.** Dat doet het wachtscript op de
 * spelmachine (OSC-002/OSC-003), en die evaluator staat bewust in de stapcoach-repo:
 * hij hoort bij het blokkerende wachten, het enige stuk dat volgens het contract lokaal
 * blijft. Deze tool vergelijkt wat er zonder evaluator vast te stellen is — volgnummers,
 * of er überhaupt een stap staat, en of de client nog leeft. Dat dekt de afwijkingen die
 * een hervattende sessie op het verkeerde been zetten.
 */
const snapshotView = async (
  text: string | null,
): Promise<{ lines: string[]; mismatches: string[] }> => {
  const lines: string[] = [];
  const mismatches: string[] = [];
  const runSeq = text === null ? undefined : activeSeqOf(text);

  const step = await readCurrentStep();
  if (step === null) {
    lines.push("`current-step.json`: bestaat niet — er staat geen stap voor de speler.");
    if (runSeq !== undefined) {
      mismatches.push(
        `het run-bestand noemt een actieve stap (seq ${runSeq}) maar \`current-step.json\` ` +
          "is er niet; de overlay toont de speler dus niets",
      );
    }
  } else {
    lines.push(
      `\`current-step.json\`: seq ${step.seq} — ` +
        (step.instruction ?? "(lege envelop, geen stap)"),
    );
    lines.push(
      step.condition === null
        ? "  geen conditie: niet machinaal detecteerbaar, dus het wachtscript weigert te wachten"
        : "  er staat een conditie; het wachtscript op de spelmachine beoordeelt of hij klopt",
    );

    if (runSeq !== undefined && runSeq !== step.seq) {
      mismatches.push(
        `het run-bestand staat op seq ${runSeq} maar \`current-step.json\` op seq ${step.seq} ` +
          "— er is buiten het run-bestand om een stap gezet",
      );
    }
    if (runSeq === undefined && step.instruction !== null) {
      mismatches.push(
        "`current-step.json` heeft een actieve stap maar het run-bestand niet — noteer hem " +
          'met `action: "active"`',
      );
    }
  }

  try {
    const state = await readPlayerState();
    const age = state.ageSeconds;
    if (age === null) {
      lines.push("`player-state.json`: tijdstempel onleesbaar, leeftijd onbekend.");
    } else if (age > DEAD_AFTER_SECONDS) {
      lines.push(
        `\`player-state.json\`: ${Math.round(age)} s oud — de client draait niet meer.`,
      );
      mismatches.push(
        "de client leeft niet meer; vraag of hij weer ingelogd moet worden voordat er " +
          "een stap gezet wordt",
      );
    } else {
      lines.push(
        `\`player-state.json\`: ${Math.round(age)} s oud — de client leeft` +
          (state.playerName ? ` (${state.playerName})` : "") +
          `, bij ${state.place.summary}.`,
      );
    }
  } catch (error: unknown) {
    lines.push(
      `\`player-state.json\`: niet gelezen — ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return { lines, mismatches };
};

export const registerRunTools = (server: McpServer): void => {
  server.registerTool(
    "get_run",
    {
      title: "De lopende run opvragen",
      description:
        "Geeft het run-bestand van de lopende speelsessie — doel, plan, actieve stap, " +
        "afgeronde stappen en afwijkingen — samen met de stand uit de snapshots en de " +
        "plekken waar die twee van elkaar afwijken. Dit is waar een sessie mee begint " +
        "als de speler zegt dat hij verder wil waar hij was.\n\n" +
        "**Verandert niets.** Leest alleen.\n\n" +
        "Wijken het bestand en de snapshots af, dan is dat een vraag aan de speler en " +
        "geen reden om door te schuiven: het bestand zegt wat de bedoeling was, de " +
        "snapshots zeggen wat er is.\n\n" +
        "Een onbereikbare datamap is een eigen uitkomst en wordt nooit gemeld als " +
        '"er loopt geen run" — begin in dat geval geen nieuwe run, want er kan er een ' +
        "lopen die je dan overschrijft.",
      inputSchema: {},
    },
    async () => {
      const fail = (text: string) => ({
        content: [{ type: "text" as const, text }],
        isError: true,
      });

      let text: string | null;
      try {
        text = await readCurrentRun();
      } catch (error: unknown) {
        return fail(runError(error, "het lezen van de run"));
      }

      if (text === null) {
        // De map is hierboven aantoonbaar gelezen, dus dit is écht "geen run".
        const view = await snapshotView(null);
        return {
          content: [
            {
              type: "text" as const,
              text: [NO_RUN(currentRunPath()), "", "**De snapshots**", ...view.lines].join("\n"),
            },
          ],
        };
      }

      const view = await snapshotView(text);
      const lines = [
        "**Het run-bestand — wat de bedoeling was**",
        "",
        text.trimEnd(),
        "",
        "**De snapshots — wat er is**",
        ...view.lines,
        "",
        "**Stand**",
      ];

      try {
        lines.push(summarize(text));
        const next = nextOpenStep(text);
        lines.push(
          next
            ? `Volgende open stap: ${next.number}. ${next.label}`
            : "Geen open stappen meer in het plan — de run is toe aan `finish`.",
        );
      } catch (error: unknown) {
        lines.push(
          `De stand is niet samen te vatten: ${runError(error, "het lezen van het plan")}`,
        );
      }

      if (view.mismatches.length > 0) {
        lines.push(
          "",
          "**Het bestand en de snapshots wijken af**",
          ...view.mismatches.map((mismatch) => `- ${mismatch}`),
          "",
          "Leg dit aan de speler voor voordat je verder gaat. Schuif niet door en trek " +
            "het bestand niet stilzwijgend recht.",
        );
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  server.registerTool(
    "update_run",
    {
      title: "De lopende run bijwerken",
      description:
        "Werkt het run-bestand van de speelsessie bij. Vijf bewerkingen onder één " +
        "`action`:\n\n" +
        "- `start` — een nieuwe run beginnen, met `goal` en `plan`. Weigert als er al " +
        "een run loopt.\n" +
        "- `active` — de stap die nu loopt noteren. Leest zelf `current-step.json`, " +
        "zodat het bestand niet uit de pas kan lopen met wat de speler in de overlay ziet.\n" +
        "- `done` — een stap afvinken op het moment dat hij afgaat, met eventueel wat " +
        "er anders bleek in `note`. Niet aan het eind van de run in één keer.\n" +
        "- `deviation` — noteren wat er anders bleek dan gepland, of wat er nog beslist " +
        "moet worden.\n" +
        "- `finish` — de run archiveren als `YYYY-MM-DD doel.md`. Dat is een hernoeming; " +
        "er gaat niets verloren.\n\n" +
        "**Bewerkingen zijn chirurgisch.** Alleen de regels die veranderen worden " +
        "aangeraakt. Een met de hand aangepaste steplabel, een zelf toegevoegde stap, " +
        "een eigen sectie of een eigen tabelregel blijft staan. Wie het bestand met de " +
        "hand aanpast, heeft gelijk — het wordt nooit opnieuw opgebouwd uit het beeld " +
        "dat deze tool van de run heeft.\n\n" +
        "Ontbreekt een sectie die nodig is, dan volgt er een fout die de sectie noemt en " +
        "wordt er niets geschreven.",
      inputSchema: {
        action: z
          .enum(["start", "active", "done", "deviation", "finish"])
          .describe("Welke bewerking. Zie de beschrijving van deze tool."),
        goal: z
          .string()
          .trim()
          .min(1)
          .max(300)
          .optional()
          .describe(
            "Alleen bij `start`: één of twee zinnen over wat er bereikt moet worden en " +
              "waar dat aan te zien is.",
          ),
        plan: z
          .array(z.string().trim().min(1).max(200))
          .min(1)
          .max(60)
          .optional()
          .describe(
            "Alleen bij `start`: de stappen in gewone taal, in volgorde. Ze worden " +
              "genummerd vanaf 1.",
          ),
        note: z
          .string()
          .trim()
          .min(1)
          .max(300)
          .optional()
          .describe(
            "Bij `done`: wat er anders bleek dan gepland, of leeg laten. Bij " +
              "`deviation`: de afwijking zelf, en dan verplicht.",
          ),
        stepNumber: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "Alleen bij `done`: welke stap uit het plan. Laat weg om de eerstvolgende " +
              "open stap af te vinken, wat vrijwel altijd de bedoeling is.",
          ),
        conditionText: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe(
            "Alleen bij `active`: de conditie in één regel mensentaal, voor wie het " +
              "bestand met de hand leest. Laat weg als de stap geen conditie heeft.",
          ),
      },
    },
    async (args: {
      action: "start" | "active" | "done" | "deviation" | "finish";
      goal?: string;
      plan?: string[];
      note?: string;
      stepNumber?: number;
      conditionText?: string;
    }) => {
      const fail = (text: string) => ({
        content: [{ type: "text" as const, text }],
        isError: true,
      });
      const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });

      const { action } = args;

      // Argumenten die niet bij de actie horen, zijn bijna altijd een vergissing over
      // wélke actie bedoeld was. Liever een correctieronde dan een stille bewerking.
      const misplaced: string[] = [];
      if (action !== "start" && args.goal !== undefined) misplaced.push("goal");
      if (action !== "start" && args.plan !== undefined) misplaced.push("plan");
      if (action !== "done" && args.stepNumber !== undefined) misplaced.push("stepNumber");
      if (action !== "active" && args.conditionText !== undefined) {
        misplaced.push("conditionText");
      }
      if (action !== "done" && action !== "deviation" && args.note !== undefined) {
        misplaced.push("note");
      }
      if (misplaced.length > 0) {
        return fail(
          `\`action: "${action}"\` hoort niet samen te gaan met ` +
            misplaced.map((name) => `\`${name}\``).join(", ") +
            ". Er is niets geschreven.",
        );
      }

      if (action === "start") {
        if (args.goal === undefined || args.plan === undefined) {
          return fail(
            "`start` heeft zowel `goal` als `plan` nodig. Er is niets geschreven.",
          );
        }

        let existing: string | null;
        try {
          existing = await readCurrentRun();
        } catch (error: unknown) {
          return fail(runError(error, "het beginnen van een run"));
        }
        if (existing !== null) {
          return fail(
            [
              "Er loopt al een run; er is niets geschreven.",
              "",
              summarizeSafe(existing),
              "",
              "Rond die eerst af met `action: \"finish\"`, of vraag de speler wat er met " +
                "de lopende run moet gebeuren. Een run overschrijven wist het enige " +
                "verslag van die sessie.",
            ].join("\n"),
          );
        }

        let text: string;
        try {
          text = createRunText({ goal: args.goal, plan: args.plan });
        } catch (error: unknown) {
          return fail(runError(error, "het opstellen van de run"));
        }

        try {
          await writeCurrentRun(text);
        } catch (error: unknown) {
          return fail(runError(error, "het beginnen van een run"));
        }

        return ok(
          [
            `Run begonnen met ${args.plan.length} stappen in het plan.`,
            "",
            summarizeSafe(text),
            "",
            "Zet de eerste stap met `set_step` en noteer hem hier met " +
              '`action: "active"`.',
          ].join("\n"),
        );
      }

      // Alle overige acties werken op een lopende run.
      let text: string;
      try {
        const current = await readCurrentRun();
        if (current === null) return fail(NO_RUN(currentRunPath()));
        text = current;
      } catch (error: unknown) {
        return fail(runError(error, "het bijwerken van de run"));
      }

      if (action === "active") {
        const step = await readCurrentStep();
        if (step === null || step.instruction === null) {
          return fail(
            "Er staat geen actieve stap in `current-step.json`, dus er valt niets te " +
              "noteren. Zet eerst een stap met `set_step`. Er is niets geschreven.",
          );
        }

        let updated: string;
        try {
          updated = setActiveStep(text, {
            seq: step.seq,
            at: clockNow(),
            instruction: step.instruction,
            ...(args.conditionText === undefined ? {} : { condition: args.conditionText }),
          });
        } catch (error: unknown) {
          return fail(runError(error, "het noteren van de actieve stap"));
        }

        try {
          await writeCurrentRun(updated);
        } catch (error: unknown) {
          return fail(runError(error, "het noteren van de actieve stap"));
        }

        return ok(
          `Actieve stap genoteerd: seq ${step.seq} — ${step.instruction}\n\n` +
            summarizeSafe(updated),
        );
      }

      if (action === "done") {
        let result: { text: string; step: { number: number; label: string } };
        try {
          result = completeStep(text, {
            at: clockNow(),
            ...(args.note === undefined ? {} : { note: args.note }),
            ...(args.stepNumber === undefined ? {} : { stepNumber: args.stepNumber }),
          });
        } catch (error: unknown) {
          return fail(runError(error, "het afvinken van een stap"));
        }

        try {
          await writeCurrentRun(result.text);
        } catch (error: unknown) {
          return fail(runError(error, "het afvinken van een stap"));
        }

        const next = nextOpenStep(result.text);
        return ok(
          [
            `Stap ${result.step.number} afgevinkt: ${result.step.label}`,
            "",
            summarizeSafe(result.text),
            next
              ? `Volgende open stap: ${next.number}. ${next.label}`
              : "Geen open stappen meer — de run is toe aan `finish`.",
          ].join("\n"),
        );
      }

      if (action === "deviation") {
        if (args.note === undefined) {
          return fail(
            "`deviation` heeft een `note` nodig: wat er anders bleek, of wat er nog " +
              "beslist moet worden. Er is niets geschreven.",
          );
        }

        let updated: string;
        try {
          updated = addDeviation(text, args.note);
        } catch (error: unknown) {
          return fail(runError(error, "het noteren van een afwijking"));
        }

        try {
          await writeCurrentRun(updated);
        } catch (error: unknown) {
          return fail(runError(error, "het noteren van een afwijking"));
        }

        return ok(`Afwijking genoteerd.\n\n${summarizeSafe(updated)}`);
      }

      // finish
      let goal: string;
      try {
        goal = goalOf(text);
      } catch (error: unknown) {
        return fail(runError(error, "het archiveren van de run"));
      }

      let name: string;
      try {
        name = await archiveCurrentRun({ goal, date: dateNow() });
      } catch (error: unknown) {
        return fail(runError(error, "het archiveren van de run"));
      }

      return ok(
        [
          `Run gearchiveerd als \`${name}\`.`,
          "",
          summarizeSafe(text),
          "",
          "`current-run.md` is hernoemd, niet verwijderd — het verslag van deze sessie " +
            "staat er nog. Er loopt nu geen run meer.",
        ].join("\n"),
      );
    },
  );
};

/**
 * De stand samenvatten zonder dat een kapotte sectie de hele melding sloopt.
 *
 * De samenvatting is bijvangst bij een geslaagde bewerking; die mag niet alsnog als
 * fout eindigen omdat de eigenaar een sectie met de hand heeft verbouwd.
 */
const summarizeSafe = (text: string): string => {
  try {
    return summarize(text);
  } catch (error: unknown) {
    return `(stand niet samen te vatten: ${
      error instanceof Error ? error.message : String(error)
    })`;
  }
};

export { requireDataDir, dataDir };
