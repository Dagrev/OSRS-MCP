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

// Let op: stdout is het MCP-protocolkanaal. Alles wat naar stdout wordt
// geschreven breekt de verbinding met de client. Loggen gaat naar stderr.
const log = (message: string) => console.error(`[osrs-mcp] ${message}`);

const server = new McpServer({
  name: "osrs-mcp",
  version: "0.1.0",
});

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
      username: z
        .string()
        .trim()
        .min(1, "Accountnaam mag niet leeg zijn.")
        .max(12, "Een OSRS-accountnaam is maximaal 12 tekens lang.")
        .regex(
          /^[A-Za-z0-9 _-]+$/,
          "Een OSRS-accountnaam bevat alleen letters, cijfers, spaties, koppeltekens en underscores.",
        )
        .describe("De OSRS-accountnaam, bijvoorbeeld 'Lynx Titan'."),
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("verbonden via stdio");
}

main().catch((error: unknown) => {
  log(`fatale fout: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
