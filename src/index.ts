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
  CONTAINERS,
  DATA_DIR_ENV,
  PluginDataError,
  STALE_AFTER_SECONDS,
  dataDir,
  readContainer,
  type ContainerData,
  type ContainerKind,
} from "./plugindata.js";
import { checkMaterials, type MaterialCheck, type MaterialsReport, type RecipeCheck } from "./materials.js";
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
 * wiki-naam kan afwijken van de in-game naam. Het daadwerkelijk koppelen van
 * in-game data aan wiki-items gebeurt in `itemindex.ts` op item-ID
 * (ORS-009); hier, waar alleen een naam is ingetypt, is dat niet mogelijk.
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

/* ------------------------------------------------------------------ *
 * Lokale plugindata — bank en inventory
 * ------------------------------------------------------------------ */

/** Leeftijd in mensentaal; de exacte seconden staan er in het antwoord bij. */
const formatAge = (seconds: number): string => {
  if (seconds < 60) return `${seconds} seconde(n)`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} minuut/minuten`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} uur`;
  return `${Math.round(seconds / 86400)} dag(en)`;
};

/**
 * Dezelfde item-ID kan over meerdere slots verdeeld staan (alles wat niet
 * stapelt). Voor de vraag "wat heb ik" is het totaal per item het antwoord;
 * het aantal bezette slots komt er apart bij, want dat is wat over vrije
 * ruimte gaat.
 */
const aggregateItems = (data: ContainerData) => {
  const totals = new Map<number, { name: string; quantity: number; slots: number }>();
  for (const item of data.items) {
    const existing = totals.get(item.id);
    if (existing) {
      existing.quantity += item.quantity;
      existing.slots += 1;
    } else {
      totals.set(item.id, { name: item.name, quantity: item.quantity, slots: 1 });
    }
  }
  return [...totals.entries()]
    .map(([id, value]) => ({ id, ...value }))
    .sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name, "nl"));
};

const formatContainer = (data: ContainerData): string => {
  const rows = aggregateItems(data);
  const label = CONTAINERS[data.kind].label;

  const lines = [
    `# ${data.kind === "bank" ? "Bank" : "Inventory"} volgens de RuneLite-plugin`,
    "",
    `- Tijdstempel uit de snapshot: ${data.timestamp}` +
      (data.ageSeconds === null
        ? " (niet als datum te lezen)"
        : ` — ${formatAge(data.ageSeconds)} oud`),
    `- Bestand voor het laatst gewijzigd: ${data.fileModified}`,
    `- Gelezen uit: ${data.path}`,
  ];

  if (data.ageSeconds !== null && data.ageSeconds > STALE_AFTER_SECONDS) {
    lines.push(
      `- **Let op: deze snapshot is ${formatAge(data.ageSeconds)} oud.** ` +
        (data.kind === "bank"
          ? "Voor de bank is dat normaal — die wordt alleen herschreven als de " +
            "bank in-game geopend wordt. Behandel het als de laatst bekende " +
            "stand, niet als de huidige."
          : "De inventory verandert tijdens het spelen continu, dus dit is " +
            "vrijwel zeker niet de huidige stand. Waarschijnlijk is de client " +
            "afgesloten of de plugin uit."),
    );
  }

  lines.push("");

  if (rows.length === 0) {
    // Dit is het enige pad waarop "leeg" ook echt leeg betekent: het bestand is
    // gelezen en bevat een geldige, lege lijst.
    lines.push(
      `De ${label} is leeg volgens deze snapshot. Dat is een gelezen waarde, ` +
        "geen storing: het bestand was goed leesbaar en bevatte nul items.",
    );
  } else {
    const slots = data.items.length;
    lines.push(
      `${rows.length} verschillend(e) item(s) over ${slots} bezet(te) slot(s)` +
        (data.kind === "inventory" ? ` van 28 — ${28 - slots} vrij.` : "."),
      "",
      "| Item | Aantal | Item-ID | Slots |",
      "| --- | ---: | ---: | ---: |",
    );
    for (const row of rows) {
      lines.push(
        `| ${row.name} | ${row.quantity.toLocaleString("nl-NL")} | ${row.id} | ${row.slots} |`,
      );
    }
  }

  if (data.skippedItemCount > 0) {
    lines.push(
      "",
      `Let op: ${data.skippedItemCount} regel(s) in het bestand hadden niet de ` +
        "vorm die deze server verwacht en zijn overgeslagen. Het totaal is dus " +
        "mogelijk niet compleet; mogelijk is het formaat van de plugin gewijzigd.",
    );
  }

  lines.push(
    "",
    "Deze data komt van de plugin op de spelmachine, niet uit het spel zelf. Hij " +
      "is zo oud als het tijdstempel hierboven zegt; er wordt niets gecached, dus " +
      "opnieuw opvragen leest het bestand opnieuw.",
  );

  return lines.join("\n");
};

/** Elke plugindata-tool handelt fouten hetzelfde af. */
const respondWithContainer = async (kind: ContainerKind) => {
  try {
    return { content: [{ type: "text" as const, text: formatContainer(await readContainer(kind)) }] };
  } catch (error: unknown) {
    // De boodschap van PluginDataError legt zelf uit wélk soort probleem het is
    // en, belangrijker, dat het geen lege container betekent.
    const message =
      error instanceof PluginDataError
        ? error.message
        : `Onverwachte fout bij het lezen van de ${CONTAINERS[kind].label}: ${
            error instanceof Error ? error.message : String(error)
          }`;
    const kindLabel = error instanceof PluginDataError ? error.kind : "unexpected";
    log(`get_${kind} mislukt (${kindLabel}): ${message}`);
    return { content: [{ type: "text" as const, text: message }], isError: true };
  }
};

/** Dezelfde toelichting voor beide tools; alleen de container verschilt. */
const containerToolDescription = (kind: ContainerKind) =>
  `Leest de laatste ${CONTAINERS[kind].label}-snapshot die de RuneLite-plugin "OSRS ` +
  `Item Check" heeft weggeschreven, met het tijdstempel erbij zodat te zien is hoe ` +
  `oud de data is. ` +
  (kind === "bank"
    ? "De bank wordt alleen herschreven als die in-game geopend is, dus dit is de " +
      "stand van de laatste keer bankieren. "
    : "De inventory wordt bij elke wijziging herschreven. ") +
  `Is de bron niet te lezen, dan komt er een foutmelding — nooit een lege lijst. ` +
  `De datamap is in te stellen met de environment-variabele ${DATA_DIR_ENV} ` +
  `(nu: ${dataDir()}).`;

server.registerTool(
  "get_inventory",
  {
    title: "OSRS inventory ophalen",
    description: containerToolDescription("inventory"),
    inputSchema: {},
  },
  async () => respondWithContainer("inventory"),
);

server.registerTool(
  "get_bank",
  {
    title: "OSRS bank ophalen",
    description: containerToolDescription("bank"),
    inputSchema: {},
  },
  async () => respondWithContainer("bank"),
);

/* ------------------------------------------------------------------ *
 * Gecombineerde vraag — plugindata + wiki + hiscores
 * ------------------------------------------------------------------ */

/** Een statuswoord met een teken ervoor, zodat een lijst in één blik te lezen is. */
const MATERIAL_MARK: Record<MaterialCheck["status"], string> = {
  genoeg: "✅ genoeg",
  "te weinig": "⚠️ te weinig",
  niets: "❌ niets gevonden",
  onbekend: "❔ onbekend",
};

const formatMaterialRow = (check: MaterialCheck): string => {
  const needed =
    check.neededRounded === null
      ? "?"
      : check.needed !== null && check.needed !== check.neededRounded
        ? `${nl(check.neededRounded)} (gem. ${check.needed})`
        : nl(check.neededRounded);
  const where = [...new Set(check.matches.map((m) => m.holding.source))].join(" + ");
  return (
    `| ${check.material.name} | ${needed} | ${nl(check.have)} | ` +
    `${MATERIAL_MARK[check.status]} | ${where || "—"} |`
  );
};

const formatRecipeCheck = (check: RecipeCheck, quantity: number): string[] => {
  const recipe = check.recipe;
  const heading = [recipe.outputName, recipe.method ? `via ${recipe.method}` : null]
    .filter((part) => part !== null)
    .join(" — ");

  const lines = [`## ${heading}`, ""];

  if (recipe.outputQuantity !== null && recipe.outputQuantity !== 1) {
    lines.push(`Eén keer maken levert ${recipe.outputQuantity} op.`);
  }
  lines.push(
    `Nodig voor ${nl(quantity)} stuk(s): ${nl(check.batches)} keer uitvoeren.`,
    "",
    "| Materiaal | Nodig | Gevonden | Oordeel | Waar |",
    "| --- | ---: | ---: | --- | --- |",
  );
  for (const material of check.materials) lines.push(formatMaterialRow(material));

  if (recipe.skills.length > 0) {
    lines.push("", "**Skill-eisen**");
    for (const skill of check.skills) {
      const actual =
        skill.actual === null
          ? "onbekend (geen account opgegeven of niet gerangschikt)"
          : `level ${skill.actual}`;
      const mark =
        skill.status === "gehaald" ? "✅" : skill.status === "te laag" ? "❌" : "❔";
      lines.push(
        `- ${mark} ${skill.name} ${skill.required} — jij: ${actual}` +
          (skill.status === "te laag" && skill.boostable === true
            ? " (de wiki zegt dat deze te boosten is)"
            : ""),
      );
    }
    if (check.skills.length === 0) {
      lines.push("- (de wiki noemt geen level bij deze skills)");
    }
  }

  const facilities = [...recipe.facilities, ...recipe.tools];
  if (facilities.length > 0) {
    lines.push(
      "",
      `**Nodig maar niet geteld:** ${facilities.join(", ")}. Gereedschap en ` +
        "faciliteiten worden niet tegen de bank gelegd — een aambeeld ligt niet " +
        "in je bank, en een hamer kan in je toolbelt zitten.",
    );
  }

  const notes = check.materials.flatMap((material) =>
    material.notes.map((note) => `- ${material.material.name}: ${note}`),
  );
  if (notes.length > 0) lines.push("", "**Kanttekeningen bij de koppeling**", ...notes);

  lines.push(
    "",
    check.uncertain
      ? "**Materialen: niet met zekerheid te zeggen.** Zie de kanttekeningen " +
        'hierboven; er ontbreekt iets in de waarneming, dus dit is geen "nee".'
      : check.complete
        ? "**Materialen: je hebt alles wat dit recept vraagt.**"
        : "**Materialen: je komt tekort** (zie de regels hierboven).",
  );

  // De skill-eis staat bewust apart van het materiaaloordeel: een onbekend
  // level maakt niet onzeker of het spul in je bank ligt.
  const tooLow = check.skills.filter((skill) => skill.status === "te laag");
  const unknown = check.skills.filter((skill) => skill.status === "onbekend");
  if (tooLow.length > 0) {
    lines.push(
      `**Skills: nog niet.** ${tooLow
        .map((skill) => `${skill.name} ${skill.required} (jij ${skill.actual})`)
        .join(", ")}.`,
    );
  } else if (unknown.length > 0) {
    lines.push(
      `**Skills: niet getoetst** (${unknown.map((skill) => skill.name).join(", ")}).`,
    );
  } else if (check.skills.length > 0) {
    lines.push("**Skills: je haalt de eisen.**");
  }

  return lines;
};

const formatMaterials = (report: MaterialsReport): string => {
  // De gevraagde naam in de kop, niet de naam van het eerste recept: die twee
  // verschillen zodra de wiki het resultaat anders noemt dan de pagina
  // ("Super attack" levert "Super attack(3)" op), en dan lijkt het antwoord
  // over iets anders te gaan dan er gevraagd is.
  const lines = [`# Materialen voor ${nl(report.requestedQuantity)}× ${report.requestedItem}`, ""];
  const producedName = report.lookup.recipes[0]?.outputName;
  if (producedName && producedName.toLowerCase() !== report.requestedItem.toLowerCase()) {
    lines.push(`De wiki noemt het resultaat "${producedName}".`, "");
  }

  if (report.lookup.resolvedVia) lines.push(report.lookup.resolvedVia, "");

  const readable = report.sources.filter((source) => source.data !== null);
  const failed = report.sources.filter((source) => source.data === null);

  lines.push("**Bronnen**");
  for (const source of readable) {
    const data = source.data!;
    lines.push(
      `- ${CONTAINERS[source.kind].label}: ${data.items.length} regel(s), snapshot van ` +
        `${data.timestamp}` +
        (data.ageSeconds === null ? "" : ` (${formatAge(data.ageSeconds)} oud)`),
    );
  }
  for (const source of failed) {
    lines.push(`- ${CONTAINERS[source.kind].label}: **niet gelezen** — ${source.error}`);
  }
  lines.push(
    `- wiki-item-index: ${nl(report.index.idCount)} item-ID's, opgebouwd op ` +
      `${new Date(report.index.builtAt).toISOString()}`,
  );
  if (report.skills) {
    lines.push(
      `- hiscores: "${report.skills.username}" (${report.skills.accountType})` +
        (report.skills.cached ? ", uit cache" : ""),
    );
  } else if (report.skillsError) {
    lines.push(`- hiscores: **niet gelezen** — ${report.skillsError}`);
  } else {
    lines.push(
      "- hiscores: niet opgevraagd. Geef `username` mee om ook de skill-eisen te toetsen.",
    );
  }

  if (failed.length > 0) {
    lines.push(
      "",
      "**Let op: niet alle gevraagde bronnen zijn gelezen.** Wat daar in ligt is " +
        "onbekend, niet afwezig. Materialen die niet gevonden zijn, staan daarom op " +
        '"onbekend" in plaats van op een tekort.',
    );
  }

  lines.push("");

  if (report.checks.length > 1) {
    lines.push(
      `De wiki kent ${report.checks.length} manieren om dit te maken. Ze staan er ` +
        "allemaal; kies zelf welke past.",
      "",
    );
  }

  for (const check of report.checks) {
    lines.push(...formatRecipeCheck(check, report.requestedQuantity), "");
  }

  const strong = report.holdings.length - report.unlinked.length - report.weakLinks.length;
  lines.push("## Koppeling van item-ID's", "");
  lines.push(
    `${nl(report.holdings.length)} regel(s) gelezen: ${nl(strong)} gekoppeld op ` +
      `item-ID, ${nl(report.weakLinks.length)} op een zwakkere aanwijzing, ` +
      `${nl(report.unlinked.length)} helemaal niet.`,
  );

  if (report.weakLinks.length > 0) {
    lines.push(
      "",
      `Niet op het ID zelf gekoppeld — weeg deze regels met meer voorbehoud:`,
    );
    for (const holding of report.weakLinks.slice(0, 15)) {
      lines.push(`- ${holding.pluginName} (ID ${holding.id}, ${holding.source}): ${holding.note}`);
    }
    if (report.weakLinks.length > 15) {
      lines.push(`- … en nog ${nl(report.weakLinks.length - 15)} regel(s).`);
    }
  }

  if (report.unlinked.length > 0) {
    lines.push(
      "",
      `**${nl(report.unlinked.length)} regel(s) zijn niet aan een wiki-item te ` +
        "koppelen.** Ze worden hier genoemd en niet weggelaten: zit er een " +
        "materiaal tussen dat je zocht, dan is het oordeel hierboven voor dat " +
        "materiaal niet te vertrouwen.",
    );
    for (const holding of report.unlinked.slice(0, 25)) {
      lines.push(`- ${holding.pluginName} (ID ${holding.id}, ${holding.source})`);
    }
    if (report.unlinked.length > 25) {
      lines.push(`- … en nog ${nl(report.unlinked.length - 25)} regel(s).`);
    }
  } else if (report.holdings.length > 0) {
    lines.push("", "Er bleef geen enkele regel onkoppelbaar.");
  }

  lines.push(
    "",
    "De bank- en inventorydata komt van de plugin op de spelmachine en is zo oud " +
      "als de snapshot hierboven zegt. De recepten en item-ID's komen uit de " +
      "gestructureerde wiki-data.",
  );

  return lines.join("\n");
};

server.registerTool(
  "check_materials",
  {
    title: "Materialen controleren tegen bank en inventory",
    description:
      "Beantwoordt de vraag 'heb ik de materialen voor X?' door drie bronnen te " +
      "combineren: het recept van de OSRS Wiki, de bank- en inventory-snapshot van " +
      "de RuneLite-plugin, en — als je een account meegeeft — de skill-levels uit de " +
      "hiscores. Items worden gekoppeld op item-ID, niet op naam. Wat niet te " +
      "koppelen of niet te lezen is, komt als 'onbekend' terug en nooit als 'je " +
      "hebt het niet'.",
    inputSchema: {
      item: z
        .string()
        .describe(
          "Wat je wilt maken, zoals het in het spel of op de wiki heet — " +
            "bijvoorbeeld 'Super attack(4)' of 'Steel platebody'.",
        ),
      quantity: z
        .number()
        .int()
        .min(1)
        .max(100_000)
        .default(1)
        .describe("Hoeveel je er wilt maken. Standaard 1."),
      sources: z
        .enum(["bank", "inventory", "both"])
        .default("both")
        .describe(
          "Waar gekeken wordt. Standaard 'both': bank én inventory bij elkaar " +
            "opgeteld, want materiaal kan op beide plekken liggen.",
        ),
      username: usernameSchema
        .optional()
        .describe(
          "Optioneel. Geef je dit mee, dan worden ook de skill-eisen van het recept " +
            "tegen de hiscores gelegd.",
        ),
      accountType: z
        .enum(Object.keys(ACCOUNT_TYPES) as [AccountType, ...AccountType[]])
        .default("normal")
        .describe("Alleen van belang als je 'username' meegeeft; zie get_skills."),
    },
  },
  async ({ item, quantity, sources, username, accountType }) => {
    try {
      const report = await checkMaterials({
        item,
        quantity,
        sources,
        username: username ?? null,
        accountType,
      });
      return { content: [{ type: "text", text: formatMaterials(report) }] };
    } catch (error: unknown) {
      // Een fout hier gaat over het recept, de wiki of de index — niet over wat
      // er in de bank ligt. De melding moet dat verschil overbrengen.
      const message =
        error instanceof WikiError
          ? error.message
          : `Onverwachte fout bij het controleren van de materialen: ${
              error instanceof Error ? error.message : String(error)
            }`;
      log(`check_materials mislukt voor "${item}": ${message}`);
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
