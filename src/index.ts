#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  ACCOUNT_TYPES,
  HiscoresError,
  fetchSkills,
  type AccountType,
  type HiscoresResult,
} from "./hiscores.js";
import {
  QUEST_STATUS_LABEL,
  WikiSyncError,
  fetchWikiSync,
  type QuestStatus,
  type WikiSyncResult,
} from "./wikisync.js";

// Let op: stdout is het MCP-protocolkanaal. Alles wat naar stdout wordt
// geschreven breekt de verbinding met de client. Loggen gaat naar stderr.
const log = (message: string) => console.error(`[osrs-mcp] ${message}`);

const server = new McpServer({
  name: "osrs-mcp",
  version: "0.1.0",
});

/** Dezelfde regels voor elke tool die een OSRS-accountnaam aanneemt. */
const usernameSchema = z
  .string()
  .trim()
  .min(1, "Accountnaam mag niet leeg zijn.")
  .max(12, "Een OSRS-accountnaam is maximaal 12 tekens lang.")
  .regex(
    /^[A-Za-z0-9 _-]+$/,
    "Een OSRS-accountnaam bevat alleen letters, cijfers, spaties, koppeltekens en underscores.",
  );

server.registerTool(
  "ping",
  {
    title: "Ping",
    description:
      "Controleert of de OSRS MCP-server bereikbaar is. Geeft de servertijd terug in ISO 8601.",
    inputSchema: {},
  },
  async () => ({
    content: [{ type: "text", text: `pong — ${new Date().toISOString()}` }],
  }),
);

const formatSkills = (result: HiscoresResult): string => {
  const lines = [
    `Skills voor "${result.username}" (${result.accountType}-hiscores)` +
      (result.cached ? " — uit cache, maximaal een minuut oud" : ""),
    "",
    "| Skill | Level | XP | Rank |",
    "| --- | ---: | ---: | ---: |",
  ];

  for (const skill of result.skills) {
    const level = skill.level ?? "niet gerangschikt";
    const xp = skill.xp === null ? "—" : skill.xp.toLocaleString("nl-NL");
    const rank = skill.rank === null ? "—" : skill.rank.toLocaleString("nl-NL");
    lines.push(`| ${skill.name} | ${level} | ${xp} | ${rank} |`);
  }

  lines.push(
    "",
    'Een streepje of "niet gerangschikt" betekent dat de skill niet op de hiscores ' +
      "staat — dat is iets anders dan level 0.",
    "De hiscores lopen achter op het spel; ze verversen niet real-time.",
  );

  if (result.note) lines.push(result.note);

  if (result.hasUnknownSkills) {
    lines.push(
      "Let op: de hiscores bevatten meer skills dan deze server kent. De skills met " +
        "een placeholdernaam zijn nieuw en moeten nog in SKILL_ORDER worden gezet.",
    );
  }

  return lines.join("\n");
};

server.registerTool(
  "get_skills",
  {
    title: "OSRS skills ophalen",
    description:
      "Haalt level, XP en rank per skill op uit de officiële OSRS Hiscores. " +
      "Let op: de hiscores lopen achter op het spel en verversen niet real-time, " +
      "dus net behaalde levels kunnen ontbreken. Gebruik de character name, niet de " +
      "naam van het Jagex-account.",
    inputSchema: {
      username: usernameSchema.describe(
        "De OSRS-accountnaam, bijvoorbeeld 'Lynx Titan'.",
      ),
      accountType: z
        .enum(Object.keys(ACCOUNT_TYPES) as [AccountType, ...AccountType[]])
        .default("normal")
        .describe(
          "Welke hiscore-tabel geraadpleegd wordt. Standaard 'normal'. Een " +
            "solo-ironman staat niet in de normale tabel. Group Ironman heeft geen " +
            "eigen tabel: 'group_ironman' en 'hardcore_group_ironman' lezen de " +
            "normale tabel, waar die accounts wél in staan.",
        ),
    },
  },
  async ({ username, accountType }) => {
    try {
      const result = await fetchSkills(username, accountType);
      return { content: [{ type: "text", text: formatSkills(result) }] };
    } catch (error: unknown) {
      const message =
        error instanceof HiscoresError
          ? error.message
          : `Onverwachte fout bij het ophalen van de skills: ${
              error instanceof Error ? error.message : String(error)
            }`;
      log(`get_skills mislukt voor "${username}" (${accountType}): ${message}`);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  },
);

/** Welke statussen de gebruiker kan opvragen; 'all' is de standaard. */
const QUEST_FILTERS = {
  all: ["in_progress", "not_started", "finished"],
  not_finished: ["in_progress", "not_started"],
  in_progress: ["in_progress"],
  not_started: ["not_started"],
  finished: ["finished"],
} as const satisfies Record<string, readonly QuestStatus[]>;

type QuestFilter = keyof typeof QUEST_FILTERS;

const formatQuests = (result: WikiSyncResult, filter: QuestFilter): string => {
  const counts: Record<QuestStatus, number> = {
    finished: 0,
    in_progress: 0,
    not_started: 0,
  };
  for (const quest of result.quests) counts[quest.status] += 1;

  const lines = [
    `Quests voor "${result.username}" volgens WikiSync` +
      (result.cached ? " — uit cache, maximaal vijf minuten oud" : ""),
    ...(result.retrievedAt ? [`Opgehaald bij de wiki: ${result.retrievedAt}`] : []),
    "",
    `Afgerond: ${counts.finished} van ${result.quests.length} · ` +
      `bezig: ${counts.in_progress} · niet gestart: ${counts.not_started}`,
  ];

  for (const status of QUEST_FILTERS[filter]) {
    const names = result.quests.filter((q) => q.status === status).map((q) => q.name);
    lines.push("", `## ${QUEST_STATUS_LABEL[status]} (${names.length})`);
    lines.push(names.length > 0 ? names.map((n) => `- ${n}`).join("\n") : "(geen)");
  }

  const { diaries, combatAchievements, musicTracks } = result.extras;
  if (diaries.length > 0 || combatAchievements !== null || musicTracks !== null) {
    lines.push("", "## Ook meegekomen in dezelfde sync");
    if (diaries.length > 0) {
      const done = diaries.filter((d) => d.completed.length === d.all.length).length;
      lines.push(
        `- Achievement diaries: ${done} van ${diaries.length} regio's volledig af. ` +
          diaries
            .map((d) => `${d.region}: ${d.completed.length > 0 ? d.completed.join("/") : "geen"}`)
            .join(" · "),
      );
    }
    if (combatAchievements !== null) {
      lines.push(`- Combat achievements voltooid: ${combatAchievements}`);
    }
    if (musicTracks !== null) {
      lines.push(`- Muzieknummers vrijgespeeld: ${musicTracks.unlocked} van ${musicTracks.total}`);
    }
    if (result.extras.levels) {
      lines.push(
        "- WikiSync gaf ook levels mee; die stonden bij de laatste sync zo. Voor " +
          "actuele XP en rank is get_skills de betere bron.",
      );
    }
  }

  lines.push(
    "",
    "WikiSync is een momentopname: de data komt van de laatste keer dat er met de " +
      "WikiSync-plugin is ingelogd, niet van nu. Hoe oud die momentopname is, valt " +
      "niet te zien — de wiki geeft geen synctijdstip mee (het timestamp-veld in de " +
      "respons is het moment van het antwoord).",
  );

  if (result.unknownStateCount > 0) {
    lines.push(
      `Let op: ${result.unknownStateCount} quest(s) hadden een status die deze server ` +
        "niet kent en zijn overgeslagen. Mogelijk is het formaat van WikiSync gewijzigd.",
    );
  }

  return lines.join("\n");
};

server.registerTool(
  "get_quests",
  {
    title: "OSRS questvoortgang ophalen",
    description:
      "Haalt per quest op of die niet gestart, bezig of afgerond is, via de publieke " +
      "WikiSync-data van de OSRS Wiki. Dit vereist dat het account ooit heeft " +
      "ingelogd met de RuneLite-plugin WikiSync aan; de data is de momentopname van " +
      "die laatste sync en niet live. Gebruik de character name, niet de naam van " +
      "het Jagex-account.",
    inputSchema: {
      username: usernameSchema.describe(
        "De OSRS-accountnaam, bijvoorbeeld 'Mr Bilel'.",
      ),
      filter: z
        .enum(Object.keys(QUEST_FILTERS) as [QuestFilter, ...QuestFilter[]])
        .default("all")
        .describe(
          "Welke quests in de lijst komen. Standaard 'all' (alle quests, gegroepeerd " +
            "op status). De tellingen bovenaan gaan altijd over alle quests, ook als " +
            "er gefilterd wordt. Gebruik 'not_finished' voor alles wat nog openstaat.",
        ),
    },
  },
  async ({ username, filter }) => {
    try {
      const result = await fetchWikiSync(username);
      return { content: [{ type: "text", text: formatQuests(result, filter) }] };
    } catch (error: unknown) {
      const message =
        error instanceof WikiSyncError
          ? error.message
          : `Onverwachte fout bij het ophalen van de questvoortgang: ${
              error instanceof Error ? error.message : String(error)
            }`;
      log(`get_quests mislukt voor "${username}": ${message}`);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("verbonden via stdio");
}

main().catch((error: unknown) => {
  log(`fatale fout: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
