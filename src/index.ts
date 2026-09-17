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
import {
  WikiError,
  fetchDropTable,
  lookupItem,
  lookupMonster,
  type DropTable,
  type ItemLookup,
  type ItemVersion,
  type MonsterLookup,
  type MonsterVersion,
} from "./wiki.js";

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

/* ------------------------------------------------------------------ *
 * OSRS Wiki — items, monsters en drop tables
 * ------------------------------------------------------------------ */

/**
 * Elke wiki-naam die in de uitvoer komt, krijgt hetzelfde voorbehoud mee: de
 * wiki-naam kan afwijken van de in-game naam. Het koppelen van in-game data
 * aan wiki-pagina's is ORS-009; hier wordt het alleen gesignaleerd.
 */
const WIKI_NAME_NOTE =
  "Namen op de wiki wijken soms af van de in-game itemnaam: varianten staan " +
  "onder een eigen paginanaam met een achtervoegsel tussen haakjes.";

/** Een regel "Label: waarde", of niets als de waarde ontbreekt. */
const field = (label: string, value: string | number | null | undefined): string[] =>
  value === null || value === undefined || value === "" ? [] : [`- ${label}: ${value}`];

const nl = (n: number): string => n.toLocaleString("nl-NL");

/**
 * Bonustabellen tonen alleen als er tenminste één waarde in staat.
 *
 * `signed` zet een `+` voor positieve waarden — passend voor bonussen, maar
 * niet voor skill-levels: "Attack +97" suggereert een bonus terwijl het een
 * level is.
 */
const bonusRow = (
  stats: Record<string, number | null>,
  signed = true,
): string | null => {
  const filled = Object.entries(stats).filter(([, v]) => v !== null);
  if (filled.length === 0) return null;
  return filled
    .map(([k, v]) => `${k} ${signed && v! > 0 ? "+" : ""}${v}`)
    .join(" · ");
};

const formatItemVersion = (version: ItemVersion, showHeading: boolean): string[] => {
  const lines: string[] = [];
  if (showHeading) {
    // `default_version` alleen noemen als de pagina meerdere versies heeft;
    // anders staat het bij elke variant en zegt het niets. Zie lookupItem.
    const marker = version.isBaseItem
      ? " (het gewone item)"
      : version.hasSiblingVersions && version.isDefault
        ? " (standaardversie van deze pagina)"
        : "";
    lines.push(
      "",
      `## ${version.pageName}` +
        (version.versionAnchor ? ` — versie "${version.versionAnchor}"` : "") +
        marker,
    );
  }

  if (version.examine) lines.push("", `_${version.examine}_`, "");

  lines.push(
    ...field("Item-ID", version.itemIds.length > 0 ? version.itemIds.join(", ") : null),
    ...field("Members", version.membersOnly === null ? null : version.membersOnly ? "ja" : "nee"),
    ...field(
      "Verhandelbaar",
      version.tradeable === null ? null : version.tradeable ? "ja" : "nee",
    ),
    ...field("Winkelwaarde", version.value === null ? null : `${nl(version.value)} gp`),
    ...field(
      "High alchemy",
      version.highAlchemyValue === null ? null : `${nl(version.highAlchemyValue)} gp`,
    ),
    ...field("Gewicht", version.weight === null ? null : `${version.weight} kg`),
    ...field("Kooplimiet", version.buyLimit === null ? null : `${nl(version.buyLimit)} per 4 uur`),
    ...field("Questitem voor", version.quest),
    ...field("Uitgebracht", version.releaseDate),
    ...field("Verwijderd", version.removalDate),
  );

  const b = version.bonuses;
  if (b) {
    lines.push("", "### Uitrusting");
    lines.push(
      ...field("Slot", b.slot),
      ...field("Combat style", b.combatStyle),
      ...field(
        "Aanvalssnelheid",
        b.attackSpeed === null ? null : `${b.attackSpeed} ticks (${(b.attackSpeed * 0.6).toFixed(1)} s)`,
      ),
      ...field("Bereik", b.attackRange),
    );
    const attack = bonusRow(b.attack);
    const defence = bonusRow(b.defence);
    const other = bonusRow(b.other);
    if (attack) lines.push(`- Attack bonus: ${attack}`);
    if (defence) lines.push(`- Defence bonus: ${defence}`);
    if (other) lines.push(`- Overig: ${other}`);
  }

  return lines;
};

const formatItem = (result: ItemLookup): string => {
  const first = result.versions[0]!;
  const lines = [
    `# ${first.itemName}`,
    ...(result.cached ? ["", "_Uit cache, maximaal een uur oud._"] : []),
  ];

  if (result.versions.length > 1) {
    lines.push(
      "",
      `De wiki kent ${result.versions.length} items met deze naam. Het gewone item ` +
        "staat bovenaan; de rest zijn varianten met een eigen item-ID " +
        "(quest-, minigame- of league-versies), die alleen in die context bestaan.",
    );
  }

  for (const version of result.versions) {
    lines.push(...formatItemVersion(version, result.versions.length > 1));
  }

  lines.push(
    "",
    WIKI_NAME_NOTE,
    "Geen Grand Exchange-prijs: die komt uit een andere bron dan de wiki-infobox. " +
      "De winkelwaarde hierboven is de basiswaarde uit het spel, niet de handelsprijs.",
  );
  return lines.join("\n");
};

server.registerTool(
  "lookup_item",
  {
    title: "OSRS-item opzoeken",
    description:
      "Zoekt een item op bij de OSRS Wiki en geeft de belangrijkste eigenschappen: " +
      "item-ID, examine, waarde, high alchemy, gewicht, kooplimiet en — als het " +
      "uitrusting is — de aanvals- en verdedigingsbonussen. Geen Grand " +
      "Exchange-prijs; dat is een aparte bron.",
    inputSchema: {
      name: z
        .string()
        .describe("De itemnaam zoals in het spel of op de wiki, bijvoorbeeld 'Abyssal whip'."),
    },
  },
  async ({ name }) => {
    try {
      return { content: [{ type: "text", text: formatItem(await lookupItem(name)) }] };
    } catch (error: unknown) {
      const message =
        error instanceof WikiError
          ? error.message
          : `Onverwachte fout bij het opzoeken van het item: ${
              error instanceof Error ? error.message : String(error)
            }`;
      log(`lookup_item mislukt voor "${name}": ${message}`);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  },
);

const formatMonsterVersion = (version: MonsterVersion, showHeading: boolean): string[] => {
  const lines: string[] = [];
  if (showHeading) {
    lines.push(
      "",
      `## ${version.versionAnchor ?? version.pageName}` +
        (version.isDefault ? " (standaardversie)" : ""),
    );
  }

  if (version.examine) lines.push("", `_${version.examine}_`, "");

  lines.push(
    ...field("Combat level", version.combatLevel),
    ...field("Hitpoints", version.hitpoints),
    ...field("Max hit", version.maxHits.length > 0 ? version.maxHits.join(" / ") : null),
    ...field(
      "Aanvalssnelheid",
      version.attackSpeed === null
        ? null
        : `${version.attackSpeed} ticks (${(version.attackSpeed * 0.6).toFixed(1)} s)`,
    ),
    ...field(
      "Aanvalsstijl",
      version.attackStyles.length > 0 ? version.attackStyles.join(", ") : null,
    ),
    ...field(
      "Attributen",
      version.attributes.length > 0 ? version.attributes.join(", ") : null,
    ),
    ...field("Grootte", version.size === null ? null : `${version.size}x${version.size}`),
    ...field("Giftig", version.poisonous),
    ...field("Monster-ID", version.monsterIds.length > 0 ? version.monsterIds.join(", ") : null),
    ...field("Members", version.membersOnly === null ? null : version.membersOnly ? "ja" : "nee"),
    ...field("Uitgebracht", version.releaseDate),
  );

  const slayer = version.slayer;
  if (slayer.level !== null || slayer.categories.length > 0) {
    lines.push("", "### Slayer");
    lines.push(
      ...field("Vereist level", slayer.level),
      ...field("XP per kill", slayer.experience),
      ...field("Categorie", slayer.categories.length > 0 ? slayer.categories.join(", ") : null),
      ...field(
        "Toegewezen door",
        slayer.assignedBy.length > 0 ? slayer.assignedBy.join(", ") : null,
      ),
    );
  }

  const stats = bonusRow(version.combatStats, false);
  const attack = bonusRow(version.attackBonuses);
  const defence = bonusRow(version.defenceBonuses);
  const otherBonuses = bonusRow(version.otherBonuses);
  if (stats || attack || defence || otherBonuses || version.flatArmour !== null) {
    lines.push("", "### Combat stats");
    if (stats) lines.push(`- Levels: ${stats}`);
    if (attack) lines.push(`- Attack bonus per type: ${attack}`);
    if (otherBonuses) lines.push(`- Overige bonussen: ${otherBonuses}`);
    if (defence) lines.push(`- Defence bonus: ${defence}`);
    lines.push(...field("Flat armour", version.flatArmour));
  }

  lines.push("", "### Zwaktes en weerstanden");
  if (version.elementalWeakness) {
    lines.push(
      `- Elementaire zwakte: ${version.elementalWeakness.element}` +
        (version.elementalWeakness.percent === null
          ? ""
          : ` (+${version.elementalWeakness.percent}%)`),
    );
  } else {
    lines.push(
      "- Elementaire zwakte: niet vermeld in de infobox. Dat betekent niet " +
        "automatisch dat het monster er geen heeft.",
    );
  }

  const resistances = Object.entries(version.resistances).filter(([, v]) => v !== null);
  for (const [label, value] of resistances) lines.push(`- ${label}: ${value}`);

  if (defence) {
    lines.push(
      "- De defence bonussen hierboven zijn de praktische zwakte: hoe lager de " +
        "bonus tegen een aanvalstype, hoe beter dat type werkt.",
    );
  }

  return lines;
};

const formatMonster = (result: MonsterLookup): string => {
  const first = result.versions[0]!;
  const lines = [
    `# ${first.name}`,
    ...(result.cached ? ["", "_Uit cache, maximaal een uur oud._"] : []),
  ];

  if (result.versions.length > 1) {
    lines.push(
      "",
      `De wiki kent ${result.versions.length} versies van dit monster (verschillende ` +
        "locaties of quest-fases, vaak met eigen stats). De standaardversie staat bovenaan.",
    );
  }

  for (const version of result.versions) {
    lines.push(...formatMonsterVersion(version, result.versions.length > 1));
  }

  lines.push(
    "",
    `Drop table opvragen: get_drop_table met "${first.pageName}".`,
    WIKI_NAME_NOTE,
  );
  return lines.join("\n");
};

server.registerTool(
  "lookup_monster",
  {
    title: "OSRS-monster opzoeken",
    description:
      "Zoekt een monster op bij de OSRS Wiki: combat level, hitpoints, max hit, " +
      "aanvals- en verdedigingsbonussen, slayer-eisen en de vermelde zwaktes. " +
      "Heeft een monster meerdere versies (locaties, quest-fases), dan komen ze " +
      "allemaal terug met de standaardversie bovenaan.",
    inputSchema: {
      name: z
        .string()
        .describe("De monsternaam zoals op de wiki, bijvoorbeeld 'Abyssal demon'."),
    },
  },
  async ({ name }) => {
    try {
      return { content: [{ type: "text", text: formatMonster(await lookupMonster(name)) }] };
    } catch (error: unknown) {
      const message =
        error instanceof WikiError
          ? error.message
          : `Onverwachte fout bij het opzoeken van het monster: ${
              error instanceof Error ? error.message : String(error)
            }`;
      log(`lookup_monster mislukt voor "${name}": ${message}`);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  },
);

/** Kans als percentage met drie significante cijfers, zoals de wiki hem toont. */
const asPercent = (chance: number): string => {
  const percent = chance * 100;
  const digits = percent >= 1 ? 2 : percent >= 0.01 ? 4 : 6;
  return `${Number(percent.toFixed(digits))}%`;
};

const formatDropTable = (result: DropTable): string => {
  const lines = [
    `# Drop table — ${result.requestedName}`,
    ...(result.cached ? ["", "_Uit cache, maximaal een uur oud._"] : []),
    "",
    `${result.lines.length} regel(s).`,
    "",
    "| Item | Aantal | Zeldzaamheid | Kans op ≥1 per kill | Type | Versie |",
    "| --- | --- | --- | --- | --- | --- |",
  ];

  for (const line of result.lines) {
    // Rolls > 1 betekent dat de breuk meerdere keren per kill gegooid wordt.
    // De zeldzaamheid blijft de breuk per roll, zoals de wiki hem noteert; de
    // kans-kolom combineert ze tot de kans op minstens één exemplaar.
    const rolls = line.rolls !== null && line.rolls > 1 ? `${line.rolls} × ` : "";
    const rarity = line.rarity ? `${rolls}${line.approximate ? "~" : ""}${line.rarity}` : "—";
    const chance =
      line.chancePerKill === null
        ? line.rarity && /^always$/i.test(line.rarity)
          ? "100%"
          : "—"
        : asPercent(line.chancePerKill);
    lines.push(
      `| ${line.itemName} | ${line.quantity ?? "—"} | ${rarity} | ${chance} | ` +
        `${line.dropType ?? "—"} | ${line.version ?? "—"} |`,
    );
  }

  if (result.rareDropTableExcluded > 0) {
    lines.push(
      "",
      `${result.rareDropTableExcluded} regel(s) komen via de rare drop table en staan ` +
        "hier niet in. Zet include_rare_drop_table op true om ze mee te nemen.",
    );
  }

  if (result.truncated) {
    lines.push(
      "",
      "Let op: de lijst is afgekapt op 500 regels. Er kunnen drops ontbreken.",
    );
  }

  lines.push(
    "",
    "De zeldzaamheid is de breuk zoals de wiki hem noteert: bij `2 × 8/150` wordt " +
      "die breuk twee keer per kill gegooid. De kans-kolom combineert dat tot de kans " +
      "op minstens één exemplaar, `1 - (1 - breuk)^rolls` — dus iets lager dan " +
      "breuk × rolls, want beide rolls kunnen ook raken. Een `~` betekent dat de wiki " +
      "de kans zelf al als benadering markeert, en waar de zeldzaamheid een woord is " +
      "(Varies, Random, Conditional) valt er geen getal van te maken.",
    "Het type zegt waar de drop vandaan komt: `combat` is een kill, maar `reward`, " +
      "`thieving` en dergelijke zijn andere bronnen die op dezelfde pagina staan.",
    "Drop rates op de wiki zijn door spelers verzameld en soms een schatting.",
  );
  return lines.join("\n");
};

server.registerTool(
  "get_drop_table",
  {
    title: "OSRS drop table opvragen",
    description:
      "Geeft de drop table van een monster met item, aantal, zeldzaamheid en de " +
      "uitgerekende kans per kill, uit de gestructureerde wiki-data (niet uit " +
      "geparseerde HTML). Regels via de rare drop table zitten er standaard niet " +
      "in, net zoals de wiki zelf doet.",
    inputSchema: {
      monster: z
        .string()
        .describe(
          "De naam van de wiki-pagina met de drop table, bijvoorbeeld 'Abyssal demon'. " +
            "Gebruik de paginanaam zonder versie-achtervoegsel.",
        ),
      include_rare_drop_table: z
        .boolean()
        .default(false)
        .describe(
          "Of de regels van de gedeelde rare drop table meekomen. Standaard false: " +
            "die lijst is lang en hetzelfde voor veel monsters.",
        ),
    },
  },
  async ({ monster, include_rare_drop_table }) => {
    try {
      const result = await fetchDropTable(monster, include_rare_drop_table);
      return { content: [{ type: "text", text: formatDropTable(result) }] };
    } catch (error: unknown) {
      const message =
        error instanceof WikiError
          ? error.message
          : `Onverwachte fout bij het ophalen van de drop table: ${
              error instanceof Error ? error.message : String(error)
            }`;
      log(`get_drop_table mislukt voor "${monster}": ${message}`);
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
