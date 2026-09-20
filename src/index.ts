#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  ACCOUNT_TYPES,
  HiscoresError,
  SKILL_ORDER,
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
import {
  DEAD_AFTER_SECONDS,
  HEARTBEAT_SECONDS,
  PLAYER_STATE_FILE,
  WRITE_INTERVAL_SECONDS,
  playerStateHint,
  readPlayerState,
  type PlayerState,
} from "./playerstate.js";
import {
  LANDMARK_MAX_TILES,
  searchLandmarks,
  type DestinationCandidate,
} from "./landmarks.js";
import {
  CommandChannelError,
  ROUTE_TIMEOUT_MS,
  sendCommand,
  waitForRoute,
  type CommandResult,
} from "./destination.js";
import {
  SNAPSHOT_MAX_AGE_SECONDS,
  chooseSource,
  prettifyQuestKey,
  questKey,
  readQuestsSnapshot,
  readSkillsSnapshot,
  type QuestsSnapshot,
  type SkillsSnapshot,
  type SourceChoice,
} from "./authority.js";
import {
  countLeaves,
  describeCondition,
  relativeXpTargets,
  validateCondition,
  type Condition,
} from "./condition.js";
import {
  StepWriteError,
  XpBaselineError,
  checkDataDir,
  nextStepSeq,
  readCurrentStep,
  writeStep,
  xpBaseline,
  type StepFile,
} from "./step.js";
import { planRoute, type ItemNeed, type PlannedLeg, type RoutePlan } from "./routeplan.js";
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

/**
 * Eén regel die zegt waar het antwoord vandaan komt.
 *
 * Staat in élk antwoord van de drie tools die twee bronnen kennen, ook als er maar één
 * beschikbaar was. Weglaten zodra er niets te kiezen valt zou betekenen dat de afwezigheid
 * van die regel iets betekent, en dat is precies het soort stilte waar dit ticket vanaf wil.
 */
const sourceLine = (choice: SourceChoice): string => `**Bron:** ${choice.reason}`;

/**
 * Meldt waar de publieke bron van de verse snapshot afwijkt.
 *
 * Alleen zinvol als de snapshot gewonnen heeft: dan is de publieke bron toch opgehaald (voor
 * de rank, of voor de diaries) en is het verschil gratis zichtbaar. Stil overschrijven zou
 * betekenen dat een achterlopende hiscore-stand ongemerkt verdwijnt — terwijl juist dát
 * verschil vertelt hoeveel de hiscores achterlopen.
 */
const disagreementNote = (differences: string[], what: string): string[] => {
  if (differences.length === 0) return [];
  return [
    "",
    `## De publieke bron zegt iets anders (${nl(differences.length)}×)`,
    "",
    ...differences.map((line) => `- ${line}`),
    "",
    `Dit is geen fout. ${what} De snapshot is gebruikt; dit staat erbij zodat zichtbaar is ` +
      "hoever de publieke bron achterloopt.",
  ];
};

const formatSkills = (result: HiscoresResult, choice: SourceChoice): string => {
  const lines = [
    `Skills voor "${result.username}" (${result.accountType}-hiscores)` +
      (result.cached ? " — uit cache, maximaal een minuut oud" : ""),
    "",
    sourceLine(choice),
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

/**
 * Skills uit de plugin-snapshot, met de rank uit de hiscores erbij.
 *
 * De verdeling is niet willekeurig. Level en XP kent de snapshot beter dan wie ook: die
 * komen uit de draaiende client. De rank kent hij helemaal niet — dat is een positie in een
 * ranglijst en die bestaat alleen bij de hiscores. Klakkeloos overstappen op de snapshot zou
 * die kolom laten verdwijnen; daarom worden de hiscores nog steeds opgehaald, alleen niet
 * meer geloofd waar de snapshot iets weet.
 */
const formatSkillsFromSnapshot = (
  username: string,
  snapshot: SkillsSnapshot,
  choice: SourceChoice,
  hiscores: HiscoresResult | null,
  hiscoresError: string | null,
): string => {
  const rankOf = (skillName: string): string => {
    const entry = hiscores?.skills.find((s) => s.name === skillName);
    return entry?.rank === null || entry?.rank === undefined
      ? "—"
      : entry.rank.toLocaleString("nl-NL");
  };

  const lines = [
    `Skills voor "${username}"`,
    "",
    sourceLine(choice),
    "",
    "| Skill | Level | XP | Rank |",
    "| --- | ---: | ---: | ---: |",
  ];

  let totalLevel = 0;
  let totalXp = 0;
  const differences: string[] = [];

  // De volgorde van de hiscores aanhouden, zodat de tabel er hetzelfde uitziet als
  // voorheen. `Overall` slaan we over: dat is een som en geen skill, en de snapshot kent
  // hem niet — wij rekenen hem zelf uit.
  for (const skillName of SKILL_ORDER) {
    if (skillName === "Overall") continue;
    const entry = snapshot.skills[skillName.toUpperCase()];
    if (entry === undefined) continue;

    totalLevel += entry.level;
    totalXp += entry.xp;

    const boosted =
      entry.boostedLevel !== undefined && entry.boostedLevel !== entry.level
        ? ` (nu ${entry.boostedLevel})`
        : "";
    lines.push(
      `| ${skillName} | ${entry.level}${boosted} | ${nl(entry.xp)} | ${rankOf(skillName)} |`,
    );

    const publicEntry = hiscores?.skills.find((s) => s.name === skillName);
    if (publicEntry !== undefined && publicEntry.xp !== null && publicEntry.xp !== entry.xp) {
      differences.push(
        `${skillName}: de hiscores staan op ${nl(publicEntry.xp)} XP` +
          (publicEntry.level === null ? "" : ` (level ${publicEntry.level})`) +
          `, de client op ${nl(entry.xp)} XP (level ${entry.level})`,
      );
    }
  }

  lines.push(`| **Overall** | **${totalLevel}** | **${nl(totalXp)}** | ${rankOf("Overall")} |`);

  // Overall is hier een som en geen gemeten waarde: de snapshot kent hem niet. Wijkt hij
  // af van de hiscores, dan komt dat doordat de plugin een skill niet wegschrijft die daar
  // wél meetelt — Sailing, op het moment van schrijven. Zwijgen zou betekenen dat iemand
  // een totaal van 738 naast een hiscore-pagina van 739 legt en gaat zoeken naar een fout
  // die er niet is. De regel noemt de skills bij naam, zodat hij blijft kloppen als er
  // later nog een bijkomt.
  const hiscoresOverall = hiscores?.skills.find((s) => s.name === "Overall")?.level ?? null;
  if (hiscoresOverall !== null && hiscoresOverall !== totalLevel) {
    const missing = (hiscores?.skills ?? [])
      .filter(
        (entry) =>
          entry.name !== "Overall" &&
          entry.level !== null &&
          snapshot.skills[entry.name.toUpperCase()] === undefined,
      )
      .map((entry) => `${entry.name} (${entry.level})`);

    lines.push(
      "",
      `**Overall is hier opgeteld uit de ${nl(Object.keys(snapshot.skills).length)} skills ` +
        `die de plugin wegschrijft en komt op ${totalLevel}; de hiscores zeggen ` +
        `${hiscoresOverall}.** ` +
        (missing.length > 0
          ? `Het verschil zit in ${missing.join(", ")} — die telt de plugin niet mee.`
          : "Welke skill het verschil maakt, is hier niet te zien."),
    );
  }

  lines.push(
    "",
    `Level en XP komen uit de snapshot van ${snapshot.ageSeconds} seconden geleden ` +
      `(${snapshot.timestamp}) en zijn het échte level, niet het geboostte. Staat er een ` +
      "waarde tussen haakjes, dan is die skill op dit moment geboost.",
  );

  if (hiscores === null) {
    lines.push(
      "",
      `**De rank ontbreekt**, want de hiscores waren niet te bereiken: ${hiscoresError}`,
      "Level en XP kloppen wel — die komen niet van daar.",
    );
  } else {
    lines.push(
      "De rank komt wél van de hiscores, want die bestaat alleen daar. Hij hoort bij de " +
        "stand van de laatste keer dat de hiscores ververst zijn.",
    );
  }

  // De GIM-toelichting hoort hier juist níét te staan: die gaat erover dat Group Ironman
  // geen eigen hiscore-tabel heeft, en dat is betekenisloos als de cijfers niet van de
  // hiscores komen. Hem meenemen zou misleidend zijn.

  lines.push(
    ...disagreementNote(
      differences,
      "De hiscores verversen niet real-time, dus ze lopen normaal gesproken achter.",
    ),
  );

  return lines.join("\n");
};

server.registerTool(
  "get_skills",
  {
    title: "OSRS skills ophalen",
    description:
      "Haalt level, XP en rank per skill op. **Twee bronnen, en het antwoord zegt " +
      "welke gebruikt is.** Draait de client van dit account en is de snapshot van de " +
      "plugin jonger dan twee minuten, dan komen level en XP daaruit — die kunnen niet " +
      "achterlopen. Anders komen ze uit de OSRS Hiscores, die niet real-time verversen, " +
      "dus dan kan een net behaald level ontbreken. De rank komt altijd van de " +
      "hiscores; die bestaat alleen daar. Wijken de twee af, dan staat dat erbij in " +
      "plaats van dat het stil wordt overschreven. Een andere accountnaam dan die in " +
      "de client gaat altijd naar de hiscores. Gebruik de character name, niet de " +
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
    const snapshot = await readSkillsSnapshot();
    const choice = await chooseSource(username, snapshot?.ageSeconds ?? null);

    // De hiscores worden ook opgehaald als de snapshot wint. Niet uit gewoonte: zij weten
    // de rank, en die kent de plugin niet. Mislukt dat, dan is dat geen fout meer zolang
    // de snapshot er is — een antwoord zonder rank is beter dan geen antwoord.
    let hiscores: HiscoresResult | null = null;
    let hiscoresError: string | null = null;
    try {
      hiscores = await fetchSkills(username, accountType);
    } catch (error: unknown) {
      hiscoresError =
        error instanceof HiscoresError
          ? error.message
          : `Onverwachte fout bij het ophalen van de skills: ${
              error instanceof Error ? error.message : String(error)
            }`;
    }

    if (choice.use === "snapshot" && snapshot !== null) {
      return {
        content: [
          { type: "text", text: formatSkillsFromSnapshot(username, snapshot, choice, hiscores, hiscoresError) },
        ],
      };
    }

    if (hiscores === null) {
      log(`get_skills mislukt voor "${username}" (${accountType}): ${hiscoresError}`);
      return { content: [{ type: "text", text: hiscoresError! }], isError: true };
    }

    return { content: [{ type: "text", text: formatSkills(hiscores, choice) }] };
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

const formatQuests = (
  result: WikiSyncResult,
  filter: QuestFilter,
  choice: SourceChoice,
): string => {
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
    sourceLine(choice),
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

/** De drie standen uit het contract naar de statusnamen die deze server al gebruikt. */
const SNAPSHOT_QUEST_STATUS: Record<string, QuestStatus> = {
  FINISHED: "finished",
  IN_PROGRESS: "in_progress",
  NOT_STARTED: "not_started",
};

/**
 * Quests uit de plugin-snapshot, met de rest van WikiSync eromheen.
 *
 * De snapshot wint voor de queststanden, want die leest de varps van de draaiende client;
 * WikiSync verstuurt alleen bij het inloggen en kan dus een hele avond achterlopen. Maar
 * WikiSync blijft nodig voor drie dingen die de plugin niet wegschrijft — diaries, combat
 * achievements en muziek — en voor de weergavenamen: de snapshot kent alleen
 * `COOKS_ASSISTANT`, en die naam wil niemand in een lijst zien.
 */
const formatQuestsFromSnapshot = (
  username: string,
  snapshot: QuestsSnapshot,
  filter: QuestFilter,
  choice: SourceChoice,
  wikiSync: WikiSyncResult | null,
  wikiSyncError: string | null,
): string => {
  // Weergavenaam per enumconstante, uit WikiSync. Namen die niet op een constante passen
  // worden overgeslagen in plaats van geraden — zie questKey.
  const displayNames = new Map<string, string>();
  const publicStatus = new Map<string, QuestStatus>();
  if (wikiSync !== null) {
    for (const quest of wikiSync.quests) {
      const key = questKey(quest.name);
      if (key.length === 0) continue;
      displayNames.set(key, quest.name);
      publicStatus.set(key, quest.status);
    }
  }

  const counts: Record<QuestStatus, number> = { finished: 0, in_progress: 0, not_started: 0 };
  const byStatus: Record<QuestStatus, string[]> = { finished: [], in_progress: [], not_started: [] };
  const differences: string[] = [];
  let unknownStates = 0;

  for (const [key, rawState] of Object.entries(snapshot.quests)) {
    const status = SNAPSHOT_QUEST_STATUS[rawState];
    if (status === undefined) {
      unknownStates += 1;
      continue;
    }

    const name = displayNames.get(key) ?? prettifyQuestKey(key);
    counts[status] += 1;
    byStatus[status].push(name);

    const other = publicStatus.get(key);
    if (other !== undefined && other !== status) {
      differences.push(
        `${name}: WikiSync zegt ${QUEST_STATUS_LABEL[other].toLowerCase()}, de client ` +
          `zegt ${QUEST_STATUS_LABEL[status].toLowerCase()}`,
      );
    }
  }

  for (const status of Object.keys(byStatus) as QuestStatus[]) {
    byStatus[status].sort((a, b) => a.localeCompare(b, "nl"));
  }

  const total = counts.finished + counts.in_progress + counts.not_started;
  const lines = [
    `Quests voor "${username}"`,
    "",
    sourceLine(choice),
    "",
    `Afgerond: ${counts.finished} van ${total} · bezig: ${counts.in_progress} · ` +
      `niet gestart: ${counts.not_started}`,
  ];

  for (const status of QUEST_FILTERS[filter]) {
    const names = byStatus[status];
    lines.push("", `## ${QUEST_STATUS_LABEL[status]} (${names.length})`);
    lines.push(names.length > 0 ? names.map((n) => `- ${n}`).join("\n") : "(geen)");
  }

  if (wikiSync === null) {
    lines.push(
      "",
      `**Diaries, combat achievements en muziek ontbreken**, want WikiSync was niet te ` +
        `bereiken: ${wikiSyncError}`,
      "De queststanden hierboven kloppen wel — die komen niet van daar. En de namen zijn " +
        "afgeleid van de enumconstante, dus leestekens kunnen ontbreken.",
    );
  } else {
    const { diaries, combatAchievements, musicTracks } = wikiSync.extras;
    if (diaries.length > 0 || combatAchievements !== null || musicTracks !== null) {
      lines.push("", "## Ook meegekomen, uit WikiSync");
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
      lines.push(
        "",
        "Die drie komen nog steeds van WikiSync, want de plugin schrijft ze niet weg. Ze " +
          "zijn dus van de laatste sync en niet van nu.",
      );
    }
  }

  lines.push(
    "",
    `De standen komen uit de snapshot van ${snapshot.ageSeconds} seconden geleden ` +
      `(${snapshot.timestamp}), rechtstreeks uit de varps van de client.`,
  );

  if (unknownStates > 0) {
    lines.push(
      `Let op: ${nl(unknownStates)} quest(s) in de snapshot hadden een stand die deze ` +
        "server niet kent en zijn overgeslagen. Mogelijk lopen de plugin en deze server " +
        "uit de pas qua versie.",
    );
  }

  lines.push(
    ...disagreementNote(
      differences,
      "WikiSync verstuurt alleen bij het inloggen, dus die momentopname kan een hele avond oud zijn.",
    ),
  );

  return lines.join("\n");
};

server.registerTool(
  "get_quests",
  {
    title: "OSRS questvoortgang ophalen",
    description:
      "Haalt per quest op of die niet gestart, bezig of afgerond is. **Twee bronnen, en " +
      "het antwoord zegt welke gebruikt is.** Draait de client van dit account en is " +
      "de snapshot van de plugin jonger dan twee minuten, dan komen de standen " +
      "daaruit — rechtstreeks uit de varps, dus van nu. Anders komen ze uit de " +
      "publieke WikiSync-data van de OSRS Wiki, die alleen bij het inloggen verstuurd " +
      "wordt en dus een hele avond oud kan zijn. Diaries, combat achievements en " +
      "muziek komen altijd van WikiSync; die schrijft de plugin niet weg. Wijken de " +
      "twee af, dan staat dat erbij. Een andere accountnaam gaat altijd naar " +
      "WikiSync. Gebruik de character name, niet de naam van het Jagex-account.",
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
    const snapshot = await readQuestsSnapshot();
    const choice = await chooseSource(username, snapshot?.ageSeconds ?? null);

    // WikiSync wordt ook opgehaald als de snapshot wint: daar zitten de diaries, combat
    // achievements en muziek in, en dat weet de plugin niet. Bovendien levert het de
    // weergavenamen waarmee de enumconstanten leesbaar getoond kunnen worden.
    let wikiSync: WikiSyncResult | null = null;
    let wikiSyncError: string | null = null;
    try {
      wikiSync = await fetchWikiSync(username);
    } catch (error: unknown) {
      wikiSyncError =
        error instanceof WikiSyncError
          ? error.message
          : `Onverwachte fout bij het ophalen van de questvoortgang: ${
              error instanceof Error ? error.message : String(error)
            }`;
    }

    if (choice.use === "snapshot" && snapshot !== null) {
      return {
        content: [
          {
            type: "text",
            text: formatQuestsFromSnapshot(username, snapshot, filter, choice, wikiSync, wikiSyncError),
          },
        ],
      };
    }

    if (wikiSync === null) {
      log(`get_quests mislukt voor "${username}": ${wikiSyncError}`);
      return { content: [{ type: "text", text: wikiSyncError! }], isError: true };
    }

    return { content: [{ type: "text", text: formatQuests(wikiSync, filter, choice) }] };
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

/**
 * Kop en verouderingstekst per container.
 *
 * Wat "oud" betekent verschilt per bron, en dat is het hele punt van deze tabel. De
 * inventory verandert continu tijdens het spelen, dus een oude snapshot betekent daar
 * vrijwel zeker dat er niemand speelt. De bank en de uitrusting worden alleen bij een
 * wijziging herschreven — uren oud is daar de normale toestand, en het als verdacht
 * presenteren zou de gebruiker laten twijfelen aan data die gewoon klopt.
 */
const CONTAINER_PRESENTATION: Record<ContainerKind, { heading: string; staleNote: string }> = {
  inventory: {
    heading: "Inventory",
    staleNote:
      "De inventory verandert tijdens het spelen continu, dus dit is vrijwel zeker " +
      "niet de huidige stand. Waarschijnlijk is de client afgesloten of de plugin uit.",
  },
  bank: {
    heading: "Bank",
    staleNote:
      "Voor de bank is dat normaal — die wordt alleen herschreven als de bank in-game " +
      "geopend wordt. Behandel het als de laatst bekende stand, niet als de huidige.",
  },
  equipment: {
    heading: "Uitrusting",
    staleNote:
      "Voor de uitrusting is dat normaal — die wordt alleen herschreven als er iets " +
      "aan- of uitgaat, en wie uren in dezelfde set speelt verandert er niets aan. " +
      "Behandel het als de laatst bekende stand.",
  },
};

const formatContainer = (data: ContainerData): string => {
  const rows = aggregateItems(data);
  const label = CONTAINERS[data.kind].label;

  const lines = [
    `# ${CONTAINER_PRESENTATION[data.kind].heading} volgens de RuneLite-plugin`,
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
        CONTAINER_PRESENTATION[data.kind].staleNote,
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
const CONTAINER_TOOL_NOTE: Record<ContainerKind, string> = {
  inventory: "De inventory wordt bij elke wijziging herschreven. ",
  bank:
    "De bank wordt alleen herschreven als die in-game geopend is, dus dit is de " +
    "stand van de laatste keer bankieren. ",
  equipment:
    "Dit is wat de speler draagt: wapen, schild, helm, amulet, cape, ringen en de " +
    "rest. Die items zitten in géén van beide andere containers, dus wie alleen " +
    "get_bank en get_inventory raadpleegt mist wat er aan het lijf hangt. Lege " +
    "uitrustingsslots leveren geen regel op. ",
};

const containerToolDescription = (kind: ContainerKind) =>
  `Leest de laatste ${CONTAINERS[kind].label}-snapshot die de RuneLite-plugin "OSRS ` +
  `Item Check" heeft weggeschreven, met het tijdstempel erbij zodat te zien is hoe ` +
  `oud de data is. ` +
  CONTAINER_TOOL_NOTE[kind] +
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

server.registerTool(
  "get_equipment",
  {
    title: "OSRS uitrusting ophalen",
    description: containerToolDescription("equipment"),
    inputSchema: {},
  },
  async () => respondWithContainer("equipment"),
);

/* ------------------------------------------------------------------ *
 * Live spelstaat — positie, run energy, HP en prayer
 * ------------------------------------------------------------------ */

/** "55/55 (100%)" — de verhouding is waar het om gaat, niet het losse getal. */
const formatRatio = (current: number | null, max: number | null): string => {
  if (current === null || max === null) return "onbekend";
  if (max <= 0) return `${current}/${max}`;
  return `${current}/${max} (${Math.round((current / max) * 100)}%)`;
};

/**
 * Wat de leeftijd van dit bestand betekent. Anders dan bij de bank is "oud"
 * hier een uitspraak over de client en niet over het spelen: de hartslag van de
 * plugin schrijft ook als er niets verandert, dus een oud tijdstempel betekent
 * dat er niet meer geschreven wordt.
 */
const playerStateFreshness = (state: PlayerState): string => {
  if (state.ageSeconds === null) {
    return (
      `- **Leeftijd onbekend**: "${state.timestamp}" is niet als datum te lezen. ` +
      `Het bestand is voor het laatst gewijzigd op ${state.fileModified}; ga van ` +
      "die tijd uit en behandel de staat hieronder met voorbehoud."
    );
  }

  const age = formatAge(state.ageSeconds);

  if (state.ageSeconds > DEAD_AFTER_SECONDS) {
    return (
      `- **Deze staat is ${age} oud en dus niet actueel.** De plugin schrijft ` +
      `ook zonder dat er iets verandert, elke ${HEARTBEAT_SECONDS} seconden. ` +
      `Staat er langer dan ${DEAD_AFTER_SECONDS} seconden niets bij, dan draait ` +
      "de client vrijwel zeker niet meer — of hij kan de map niet bereiken. Dit " +
      "is de laatst bekende stand, niet waar de speler nu staat. Zeg dat er ook " +
      "bij: antwoorden die van de positie afhangen zijn nu onbetrouwbaar."
    );
  }

  if (state.ageSeconds > HEARTBEAT_SECONDS + 10) {
    return (
      `- **Let op: ${age} oud**, net iets meer dan de hartslag van ` +
      `${HEARTBEAT_SECONDS} seconden. Waarschijnlijk kwam één schrijfactie niet ` +
      "door (dat herstelt zichzelf) of loopt de klok van de spelmachine iets uit " +
      "de pas. Behandel het als vrijwel actueel, maar niet als zeker."
    );
  }

  return (
    `- ${age} oud — de client draait en dit is de huidige stand. De plugin ` +
    `verschrijft hooguit eens per ${WRITE_INTERVAL_SECONDS} seconden, dus tot ` +
    "die marge kan de speler alweer een paar tiles verder zijn."
  );
};

const formatPlayerState = (state: PlayerState): string => {
  const lines = [
    "# Spelstaat volgens de RuneLite-plugin",
    "",
    `- Tijdstempel uit de snapshot: ${state.timestamp}`,
    playerStateFreshness(state),
    `- Gelezen uit: ${state.path}`,
    "",
    "## Waar",
    "",
    `- **${state.place.summary}**`,
    `- Coördinaat: ${state.x}, ${state.y} — verdieping ${state.plane}` +
      (state.plane === 0 ? " (grondniveau)" : ""),
    `- Region-ID: ${state.regionId}${
      state.place.region === null ? " (niet in de gebiedstabel)" : ` (${state.place.region})`
    }`,
    `- In een instance: ${state.inInstance ? "ja" : "nee"}`,
  ];

  if (state.place.landmark === null) {
    lines.push(
      `- Geen benoemd punt binnen ${LANDMARK_MAX_TILES} tiles. De landmarktabel ` +
        "kent banken, altaren en teleportbestemmingen; in leeg gebied, een " +
        "dungeon of een instance ligt daar niets van in de buurt.",
    );
  }

  lines.push(
    "",
    "## Hoe het ervoor staat",
    "",
    `- Run energy: ${state.runEnergy === null ? "onbekend" : `${state.runEnergy}%`}`,
    `- Hitpoints: ${formatRatio(state.hpCurrent, state.hpMax)}`,
    `- Prayer: ${formatRatio(state.prayerCurrent, state.prayerMax)}`,
    `- Combat level: ${state.combatLevel ?? "onbekend"}`,
    "",
    "## Account",
    "",
    `- Speler: ${state.playerName ?? "onbekend"}`,
    `- Wereld: ${state.world ?? "onbekend"}`,
  );

  // HP en prayer zijn *boosted* tegenover *real*: een lopende boost of drain
  // zit er dus in, maar het huidige getal alleen verraadt niet welk van de twee.
  lines.push(
    "",
    "Hitpoints en prayer zijn de actuele waarden tegenover het echte level, dus " +
      "een boost of drain zit erin verwerkt. Staat er meer dan het echte level, " +
      "dan werkt er een boost; staat er minder, dan is er schade of prayer " +
      "verbruikt.",
  );

  if (state.missingFields.length > 0) {
    lines.push(
      "",
      `Let op: de velden ${state.missingFields.join(", ")} stonden niet in het ` +
        "bestand of waren niet van het verwachte type, en staan hierboven als " +
        "'onbekend'. Mogelijk is het formaat van de plugin gewijzigd; de positie " +
        "zelf is wel gelezen.",
    );
  }

  lines.push(
    "",
    "Deze data komt van de plugin op de spelmachine, niet uit het spel zelf. Er " +
      "wordt niets gecached, dus opnieuw opvragen leest het bestand opnieuw — " +
      "maar het bestand zelf ververst hooguit eens per " +
      `${WRITE_INTERVAL_SECONDS} seconden.`,
  );

  return lines.join("\n");
};

server.registerTool(
  "get_player_state",
  {
    title: "OSRS spelstaat ophalen",
    description:
      "Leest waar de speler staat en hoe hij ervoor staat: coördinaat, " +
      "verdieping, region-ID, een leesbare plaatsaanduiding (het dichtstbijzijnde " +
      "bekende punt met afstand en windrichting), run energy, hitpoints, prayer, " +
      "combat level en de wereld. Gebruik dit voor elke vraag die van de positie " +
      `afhangt — 'is dit dichtbij', 'kan ik dit halen', 'heb ik genoeg run ` +
      "energy'. De plugin verschrijft de staat alleen bij verandering en hooguit " +
      `eens per ${WRITE_INTERVAL_SECONDS} seconden, plus een hartslag van ` +
      `${HEARTBEAT_SECONDS} seconden; aan het tijdstempel is dus te zien of de ` +
      "client nog draait. Is de bron niet te lezen, dan komt er een foutmelding " +
      `— nooit een verzonnen positie. ${playerStateHint()}`,
    inputSchema: {},
  },
  async () => {
    try {
      return {
        content: [{ type: "text" as const, text: formatPlayerState(await readPlayerState()) }],
      };
    } catch (error: unknown) {
      const message =
        error instanceof PluginDataError
          ? error.message
          : `Onverwachte fout bij het lezen van ${PLAYER_STATE_FILE}: ${
              error instanceof Error ? error.message : String(error)
            }`;
      const kindLabel = error instanceof PluginDataError ? error.kind : "unexpected";
      log(`get_player_state mislukt (${kindLabel}): ${message}`);
      return { content: [{ type: "text" as const, text: message }], isError: true };
    }
  },
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
    lines.push("- hiscores: niet opgevraagd.");
  }

  // Welke van de twee de levels leverde. Altijd vermelden, ook als er niets te kiezen
  // viel: zou deze regel alleen bij een keuze verschijnen, dan betekent zijn afwezigheid
  // iets, en dat is precies de stilte die ORS-023 wegneemt.
  lines.push(`- skill-levels: ${report.skillSource.reason}`);
  lines.push(
    ...disagreementNote(
      report.skillDifferences,
      "De hiscores verversen niet real-time, dus ze lopen normaal gesproken achter.",
    ),
  );

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
    "De bank-, inventory- en uitrustingsdata komt van de plugin op de spelmachine " +
      "en is zo oud als de snapshot hierboven zegt. De recepten en item-ID's komen " +
      "uit de gestructureerde wiki-data.",
  );

  return lines.join("\n");
};

server.registerTool(
  "check_materials",
  {
    title: "Materialen controleren tegen bank, inventory en uitrusting",
    description:
      "Beantwoordt de vraag 'heb ik de materialen voor X?' door drie bronnen te " +
      "combineren: het recept van de OSRS Wiki, de bank-, inventory- en " +
      "uitrustingssnapshot van de RuneLite-plugin, en — als je een account meegeeft — de skill-levels uit de " +
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
        .enum(["bank", "inventory", "equipment", "all"])
        .default("all")
        .describe(
          "Waar gekeken wordt. Standaard 'all': bank, inventory én de gedragen " +
            "uitrusting bij elkaar opgeteld. Een gedragen item is bezit, ook al zit " +
            "het in geen van beide andere containers.",
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

/* ------------------------------------------------------------------ *
 * Bestemmingen — zoeken, zetten, wissen en de route voorlezen
 * ------------------------------------------------------------------ */

/**
 * Deze vier tools zijn de enige in deze server die niet puur lezen. Wat ze kunnen is
 * precies één ding: Shortest Path een lijn op de kaart laten tekenen. Er is geen tool,
 * en in de plugin geen codepad, dat een menu-actie zet, klikt of de speler verplaatst.
 * Lopen doet de eigenaar zelf; dit wijst alleen de weg.
 */

/** Hoe een soort punt in een zin heet. Zelfde woorden als in `landmarks.ts`. */
const CANDIDATE_PHRASE: Record<string, string> = {
  bank: "bank",
  altaar: "altaar",
  teleport: "teleportbestemming",
};

const formatCandidate = (candidate: DestinationCandidate, state: PlayerState | null): string => {
  const soort = CANDIDATE_PHRASE[candidate.category] ?? candidate.category;
  // De gebiedshint hoort bij de naam en niet achteraan: "Varrock (bank, westelijk)" is
  // wat de lezer moet onthouden om de west- van de oostbank te onderscheiden.
  const hint = candidate.areaHint === null ? "" : `, ${candidate.areaHint}`;
  const parts = [
    `**${candidate.name}** (${soort}${hint}) — ${candidate.x}, ${candidate.y}` +
      (candidate.plane === 0 ? "" : `, verdieping ${candidate.plane}`),
  ];

  if (state !== null) {
    const tiles = Math.round(Math.hypot(candidate.x - state.x, candidate.y - state.y));
    parts.push(`${nl(tiles)} tiles hiervandaan (hemelsbreed)`);
  }
  if (candidate.tileCount > 1) {
    parts.push(`${nl(candidate.tileCount)} tegels onder deze naam; dit is de middelste`);
  }

  return `- ${parts.join(" · ")}`;
};

/** De spelstaat als die te lezen is, anders null. Nooit een reden om te falen. */
const playerStateOrNull = async (): Promise<PlayerState | null> => {
  try {
    return await readPlayerState();
  } catch {
    return null;
  }
};

/** Eén foutafhandeling voor alles wat in het kanaal mis kan gaan. */
const destinationError = (error: unknown, what: string): string => {
  if (error instanceof CommandChannelError || error instanceof PluginDataError) {
    return error.message;
  }
  return `Onverwachte fout bij ${what}: ${
    error instanceof Error ? error.message : String(error)
  }`;
};

server.registerTool(
  "find_destination",
  {
    title: "Een bestemming opzoeken op naam",
    description:
      "Zoekt een plek op een gewone naam — 'varrock bank', 'edgeville', 'altaar " +
      "Lumbridge' — en geeft de coördinaten terug die set_destination nodig heeft. De " +
      "tabel komt uit Shortest Path en kent banken, altaren en teleportbestemmingen; " +
      "een willekeurige boom of een dungeon-ingang staat er niet in. Verandert niets in " +
      "het spel. Staat de gezochte plek er niet bij, geef dan de coördinaat rechtstreeks " +
      "aan set_destination.",
    inputSchema: {
      query: z
        .string()
        .trim()
        .min(1, "Geef een naam om op te zoeken.")
        .describe(
          "De naam van de plek, zoals een speler hem zou noemen. Meerdere woorden " +
            "werken als 'en': 'varrock bank' geeft alleen banken in Varrock.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(25)
        .default(10)
        .describe("Hoeveel kandidaten er hoogstens terugkomen. Standaard 10."),
    },
  },
  async ({ query, limit }) => {
    const candidates = searchLandmarks(query, limit);
    if (candidates.length === 0) {
      return {
        content: [
          {
            type: "text",
            text:
              `Geen enkel bekend punt past op "${query}". De tabel kent alleen banken, ` +
              "altaren en teleportbestemmingen uit Shortest Path — geen willekeurige " +
              "gebouwen, NPC's of dungeon-ingangen. Probeer een kortere zoekterm (alleen " +
              "de plaatsnaam), of zoek de coördinaat op de wereldkaart op en geef die " +
              "rechtstreeks aan set_destination.",
          },
        ],
      };
    }

    const state = await playerStateOrNull();
    const lines = [
      `# Kandidaten voor "${query}"`,
      "",
      `${nl(candidates.length)} punt(en) gevonden.` +
        (state === null
          ? " De spelstaat is niet te lezen, dus de afstanden ontbreken."
          : ` Afstanden zijn gemeten vanaf ${state.x}, ${state.y}.`),
      "",
      ...candidates.map((candidate) => formatCandidate(candidate, state)),
      "",
      "Geef de naam of de coördinaat van de juiste aan `set_destination`.",
    ];

    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

server.registerTool(
  "set_destination",
  {
    title: "Een bestemming in de client laten tekenen",
    description:
      "Laat de Shortest Path-plugin een pad naar een bestemming op de wereldkaart en in " +
      "de client tekenen. **Dit zet alleen een markering: er wordt niets aangeklikt en " +
      "de speler beweegt niet.** Geef óf een naam (die wordt met dezelfde zoekactie als " +
      "find_destination opgezocht), óf een coördinaat. Het startpunt is standaard waar " +
      "de speler nu staat. Er wordt gewacht op bevestiging van de plugin, dus staat " +
      "Shortest Path uit of draait de client niet, dan komt dat als fout terug en niet " +
      "als een geslaagde opdracht. Vraag daarna plan_route voor de route in tekst.",
    inputSchema: {
      name: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          "De plek op naam, zoals 'varrock bank'. Past er meer dan één punt even goed, " +
            "dan wordt er niets gezet en krijg je de kandidaten terug om uit te kiezen. " +
            "Geef je ook `x` en `y`, dan gelden die en dient de naam alleen als label.",
        ),
      x: z.number().int().optional().describe("X-coördinaat, als je geen naam geeft."),
      y: z.number().int().optional().describe("Y-coördinaat, als je geen naam geeft."),
      plane: z
        .number()
        .int()
        .min(0)
        .max(3)
        .default(0)
        .describe("Verdieping van de bestemming. 0 is de begane grond."),
    },
  },
  async ({ name, x, y, plane }) => {
    const hasCoordinates = x !== undefined && y !== undefined;
    if (name === undefined && !hasCoordinates) {
      return {
        content: [
          {
            type: "text",
            text:
              "Geef een bestemming: óf `name` (een plek op naam), óf `x` en `y`. Zonder " +
              "een van beide is er niets om naartoe te tekenen.",
          },
        ],
        isError: true,
      };
    }

    let target: { x: number; y: number; plane: number };
    let chosen: DestinationCandidate | null = null;

    // Coördinaten winnen van een naam. Dat is niet willekeurig: als er meerdere punten
    // op een naam passen, vraagt deze tool om de coördinaat van de juiste erbij te geven
    // — en dan moet die coördinaat ook echt de doorslag geven. Anders is het antwoord op
    // de vraag niet op te volgen.
    if (hasCoordinates) {
      target = { x: x!, y: y!, plane };
    } else {
      // De controle hierboven heeft al afgedwongen dat er dan een naam is.
      const candidates = searchLandmarks(name!, 10);
      if (candidates.length === 0) {
        return {
          content: [
            {
              type: "text",
              text:
                `Geen bekend punt past op "${name!}", dus er is niets gezet. Zoek met ` +
                "find_destination naar een andere schrijfwijze, of geef `x` en `y` " +
                "rechtstreeks.",
            },
          ],
          isError: true,
        };
      }

      // Gelijkspel niet zelf beslechten. Twee even goede kandidaten betekent dat de
      // zoekterm niet zegt welke bedoeld wordt, en een gok zou hier een pad naar de
      // verkeerde kant van de kaart opleveren zonder dat dat opvalt.
      if (candidates.length > 1 && candidates[0]!.score === candidates[1]!.score) {
        const state = await playerStateOrNull();
        const tied = candidates.filter((candidate) => candidate.score === candidates[0]!.score);
        return {
          content: [
            {
              type: "text",
              text: [
                `"${name!}" past even goed op ${nl(tied.length)} punten. Er is niets ` +
                  "gezet — roep deze tool opnieuw aan met de `x` en `y` van de juiste.",
                "",
                ...tied.map((candidate) => formatCandidate(candidate, state)),
              ].join("\n"),
            },
          ],
          isError: true,
        };
      }

      chosen = candidates[0]!;
      target = { x: chosen.x, y: chosen.y, plane: chosen.plane };
    }

    let result: CommandResult;
    try {
      result = await sendCommand("path", target, null);
    } catch (error: unknown) {
      return {
        content: [{ type: "text", text: destinationError(error, "het zetten van de bestemming") }],
        isError: true,
      };
    }

    if (result.status !== "ok") {
      return {
        content: [
          {
            type: "text",
            text:
              `**De bestemming is niet gezet.** ${result.message}\n\nEr is dus niets ` +
              "veranderd in de client; ga er niet van uit dat er een pad op de kaart staat.",
          },
        ],
        isError: true,
      };
    }

    const lines = [
      "# Bestemming gezet",
      "",
      chosen === null
        ? `- Doel: ${target.x}, ${target.y} (verdieping ${target.plane})`
        : `- Doel: **${chosen.name}** (${CANDIDATE_PHRASE[chosen.category] ?? chosen.category}` +
          `${chosen.areaHint === null ? "" : `, ${chosen.areaHint}`}) ` +
          `op ${target.x}, ${target.y}` +
          (target.plane === 0 ? "" : `, verdieping ${target.plane}`),
      `- ${result.message}`,
      `- Bevestigd door de plugin na ${(result.waitedMs / 1000).toFixed(1)} seconden.`,
    ];

    // De ack zegt dat het bericht aankwam; de route zegt dat er ook echt een pad uit
    // kwam. Dat tweede is het bewijs dat er iets te zien is op de kaart.
    const route = await waitForRoute(result.seq);
    if (route === null) {
      lines.push(
        "",
        "Shortest Path heeft nog geen route teruggemeld binnen " +
          `${Math.round(ROUTE_TIMEOUT_MS / 1000)} seconden. Het pad wordt waarschijnlijk ` +
          "nog berekend — vraag zo `plan_route` voor de route in tekst. Bestaat er geen " +
          "route naar dit punt, dan meldt de client dat zelf op de kaart.",
      );
    } else if (route.legs.length === 0) {
      // Geen etappes betekent niet per se "te voet te doen". Shortest Path post ook een
      // lege lijst als hij helemaal geen route vond — live gemeten op 2026-09-19: een
      // pad naar Karamja, met zee ertussen, kwam terug met nul transports. Welke van de
      // twee het is, staat niet in het bericht; alleen de kaart in de client weet het.
      lines.push(
        "",
        "Shortest Path meldt geen transports in deze route. Dat betekent óf dat hij " +
          "volledig te belopen is, óf dat er helemaal geen route gevonden is — die twee " +
          "zijn hier niet uit elkaar te houden. **Kijk op de kaart in de client**: staat " +
          "daar een lijn, dan is het het eerste.",
      );
    } else {
      lines.push(
        "",
        `De route is berekend en gebruikt ${nl(route.legs.length)} transport(en). Vraag ` +
          "`plan_route` voor de etappes en wat je ervoor nodig hebt.",
      );
    }

    lines.push(
      "",
      "Het pad staat getekend; er is niet geklikt en er is niemand verplaatst. Lopen doe " +
        "je zelf.",
    );

    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

server.registerTool(
  "clear_destination",
  {
    title: "De getekende bestemming weghalen",
    description:
      "Wist het pad dat set_destination in de client heeft laten tekenen. Verandert " +
      "verder niets. Net als bij set_destination wordt er op bevestiging van de plugin " +
      "gewacht, dus 'gewist' betekent hier ook echt gewist.",
    inputSchema: {},
  },
  async () => {
    let result: CommandResult;
    try {
      result = await sendCommand("clear", null, null);
    } catch (error: unknown) {
      return {
        content: [{ type: "text", text: destinationError(error, "het wissen van de bestemming") }],
        isError: true,
      };
    }

    if (result.status !== "ok") {
      return {
        content: [
          {
            type: "text",
            text: `**Er is niets gewist.** ${result.message}`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `${result.message} Bevestigd door de plugin na ${(result.waitedMs / 1000).toFixed(1)} seconden.`,
        },
      ],
    };
  },
);

const formatNeed = (need: ItemNeed): string => {
  const label = need.name === null ? `item-ID ${need.id}` : `${need.name} (ID ${need.id})`;
  const amount = need.quantity === 1 ? "" : ` ×${nl(need.quantity)}`;
  if (need.held === null) return `${label}${amount} — **bezit onbekend**`;
  // Wáár het ligt bepaalt of je het nu kunt gebruiken: in de bank betekent eerst langs
  // de bank, in de inventory betekent meteen, gedragen betekent dat het al aan is.
  const where =
    need.heldBySource.length === 0
      ? ""
      : ` (${need.heldBySource
          .map((source) => `${nl(source.quantity)} in de ${CONTAINERS[source.kind].label}`)
          .join(", ")})`;
  if (need.held >= need.quantity) {
    return `${label}${amount} — je hebt er ${nl(need.held)}${where}`;
  }
  return `${label}${amount} — **je hebt er ${nl(need.held)}**${where}`;
};

const formatPlannedLeg = (planned: PlannedLeg, position: number): string => {
  const { leg } = planned;
  const naam = leg.displayInfo ?? leg.objectInfo ?? "naamloos transport";
  const lines = [
    `### ${position}. ${naam}`,
    "",
    `- Instappen op ${leg.from.x}, ${leg.from.y}` +
      (leg.from.plane === 0 ? "" : `, verdieping ${leg.from.plane}`) +
      ` → uitkomen op ${leg.to.x}, ${leg.to.y}` +
      (leg.to.plane === 0 ? "" : `, verdieping ${leg.to.plane}`),
  ];

  if (leg.objectInfo !== null && leg.objectInfo !== leg.displayInfo) {
    lines.push(`- In het spel: ${leg.objectInfo}`);
  }

  if (planned.matchedOn === null) {
    lines.push(
      "- Geen eisen bekend voor dit transport. Dat betekent niet dat er geen zijn: de " +
        "tabel koppelt op de tekst die Shortest Path meestuurt, en die staat hier niet in.",
    );
    return lines.join("\n");
  }

  if (planned.skills.length > 0) {
    lines.push(`- Skills: ${planned.skills.join(", ")}`);
  }
  if (planned.quests.length > 0) {
    lines.push(`- Quests: ${planned.quests.join(", ")}`);
  }

  if (planned.alternatives.length === 0) {
    lines.push("- Geen items nodig.");
  } else if (planned.alternatives.length === 1) {
    lines.push(`- Nodig: ${planned.alternatives[0]!.items.map(formatNeed).join(" en ")}`);
  } else {
    const usable = planned.alternatives.filter((alternative) => alternative.satisfied === true);
    lines.push(
      `- Nodig: één van ${nl(planned.alternatives.length)} mogelijkheden` +
        (usable.length > 0 ? ` — ${nl(usable.length)} daarvan heb je liggen:` : ":"),
    );
    // De bruikbare eerst: dat is het antwoord op "kan ik hier langs".
    const ordered = [
      ...planned.alternatives.filter((alternative) => alternative.satisfied === true),
      ...planned.alternatives.filter((alternative) => alternative.satisfied !== true),
    ];
    for (const alternative of ordered.slice(0, 8)) {
      const mark = alternative.satisfied === null ? "?" : alternative.satisfied ? "✓" : "✗";
      lines.push(`  - ${mark} ${alternative.items.map(formatNeed).join(" en ")}`);
    }
    if (ordered.length > 8) {
      lines.push(`  - … en nog ${nl(ordered.length - 8)} mogelijkheid(en).`);
    }
  }

  if (planned.ambiguous) {
    lines.push(
      `- Let op: "${planned.matchedOn}" komt in de brondata op meer dan één plek voor, ` +
        "met verschillende eisen. Ze staan hierboven allemaal; welke hier geldt is niet " +
        "met zekerheid te zeggen.",
    );
  }

  return lines.join("\n");
};

server.registerTool(
  "plan_route",
  {
    title: "De route naar de gezette bestemming in tekst",
    description:
      "Leest de route die Shortest Path heeft berekend voor de bestemming die met " +
      "set_destination is gezet, en beschrijft de etappes: welke boten, teleports, " +
      "fairy rings en shortcuts erin zitten, en welke items, quests en levels die " +
      "vragen. Items worden op item-ID tegen de bank, de inventory en de gedragen " +
      "uitrusting gelegd, met de bron erbij, dus je ziet niet alleen wat je hebt maar " +
      "ook of je er nog voor langs de bank moet. **Verandert niets in de client** — zet eerst " +
      "een bestemming met set_destination. De route komt uit de plugin zelf, dus hij is " +
      "altijd dezelfde als de lijn die op de kaart staat.",
    inputSchema: {},
  },
  async () => {
    let plan: RoutePlan | null;
    try {
      plan = await planRoute();
    } catch (error: unknown) {
      return {
        content: [{ type: "text", text: destinationError(error, "het uitlezen van de route") }],
        isError: true,
      };
    }

    if (plan === null) {
      return {
        content: [
          {
            type: "text",
            text:
              "Er ligt nog geen berekende route. Zet eerst een bestemming met " +
              "`set_destination`; Shortest Path rekent dan en de plugin schrijft de " +
              "etappes weg. Staat er wel een pad op de kaart maar hier niets, dan is " +
              "dat pad met de rechtermuisknop in de client gezet en niet via deze server.",
          },
        ],
      };
    }

    const stale = plan.route.seq < plan.currentSeq;
    const lines = [
      "# Route naar de gezette bestemming",
      "",
      `- Berekend op ${plan.route.timestamp}` +
        (plan.route.ageSeconds === null ? "" : ` (${formatAge(plan.route.ageSeconds)} geleden)`),
      `- ${nl(plan.route.legs.length)} transport(en) onderweg`,
    ];

    if (stale) {
      lines.push(
        "",
        `**Let op: deze route hoort bij een eerdere opdracht** (route ${nl(plan.route.seq)}, ` +
          `laatste opdracht ${nl(plan.currentSeq)}). Shortest Path was waarschijnlijk nog ` +
          "aan het rekenen. Vraag het zo nog eens; wat hieronder staat gaat over de vorige " +
          "bestemming.",
      );
    }

    lines.push("", "## Bronnen", "");
    for (const source of plan.sources) {
      lines.push(`- ${source.kind}: ${source.ok ? source.note : `**niet gelezen** — ${source.note}`}`);
    }
    if (!plan.itemNamesResolved) {
      lines.push(
        "- wiki-item-index: **niet gelezen**. Items die je niet bezit staan daarom alleen " +
          "met hun ID vermeld.",
      );
    }
    if (plan.sources.every((source) => !source.ok)) {
      lines.push(
        "",
        "**Geen enkele bron met bezit is gelezen.** Alles hieronder staat daarom op " +
          "'bezit onbekend' — dat is iets anders dan 'je hebt het niet'.",
      );
    }

    if (plan.legs.length === 0) {
      lines.push(
        "",
        "Er staan geen transports in deze route. Dat betekent óf dat hij volledig te " +
          "belopen is en er onderweg niets nodig is, óf dat Shortest Path geen route " +
          "naar dat punt kon vinden — het bericht dat hij terugstuurt is in beide " +
          "gevallen leeg. **Kijk op de kaart in de client** welke van de twee het is: " +
          "staat er een lijn getekend, dan is er een route.",
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    lines.push("", "## Etappes", "");
    plan.legs.forEach((planned, position) => {
      lines.push(formatPlannedLeg(planned, position + 1), "");
    });

    lines.push(
      "Dit zijn de transports die Shortest Path in de berekende route gebruikt, in de " +
        "volgorde van het pad; de loopstukken ertussen staan er niet in. De eisen komen " +
        "uit dezelfde brondata als de route zelf. Runes voor teleportspreuken staan daar " +
        "niet bij — die zijn dus niet tegen je bank gelegd.",
    );

    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

/**
 * De actieve stap zetten of wissen — de schrijfkant van het Stapcontract.
 *
 * Alles hierboven leest; deze tool en `set_destination` zijn de enige twee die iets
 * neerleggen, en dit is de enige waar geen bevestiging op volgt. Zie de kop van
 * `step.ts` voor waarom dat hier klopt en bij een bestemming niet.
 */

/** Eén foutafhandeling voor alles wat bij het schrijven van een stap mis kan gaan. */
const stepError = (error: unknown, what: string): string => {
  if (error instanceof StepWriteError || error instanceof PluginDataError) {
    return error.message;
  }
  return `Onverwachte fout bij ${what}: ${
    error instanceof Error ? error.message : String(error)
  }`;
};

/** Het conditieschema, in de beschrijving van de tool zelf. */
const CONDITION_HELP = [
  "Een conditie is een boom van objecten met elk een `type`.",
  "",
  "Bladeren:",
  "- `position`: `x`, `y`, `plane`, `radius` (alle vier verplicht, geheel). Afstand is " +
    "Chebyshev, dus een radius is een vierkant.",
  "- `region`: `regionId`.",
  "- `item`: `container` (inventory/bank/equipment), `itemId`, optioneel `name` (alleen " +
    "toelichting) en `minQuantity` (standaard 1). Matchen gaat op ID, nooit op naam.",
  "- `skillLevel`: `skill` (hoofdletters, bv. MINING), `minLevel`. Altijd het echte level.",
  "- `skillXp`: `skill`, plus **óf** `minXp` (absolute drempel) **óf** `xpGain` (zoveel " +
    "XP erbij vanaf nu; wordt bij het schrijven omgerekend met de stand uit skills.json).",
  "- `quest`: `quest` (de RuneLite-enumconstante, bv. COOKS_ASSISTANT), `state` " +
    "(NOT_STARTED/IN_PROGRESS/FINISHED).",
  "",
  "Combinatoren: `all` en `any` met `of` (lijst, minstens twee), `not` met `of` (één " +
    "conditie). Negatie is altijd een `not`-knoop, nooit een vlag op een blad. Hoogstens " +
    "drie combinatoren boven elkaar en zestien bladeren.",
  "",
  "Onbekende velden en onbekende waarden worden geweigerd, en dan wordt er niets " +
    "geschreven — liever een correctieronde dan een stap die nooit afgaat.",
].join("\n");

server.registerTool(
  "set_step",
  {
    title: "De actieve stap voor de speler vastleggen",
    description:
      "Legt één stap vast in `current-step.json` op de gedeelde map: de instructie voor " +
      "de speler, en de conditie waaraan te zien is dat hij uitgevoerd is. De overlay in " +
      "de client toont de stap en het wachtscript wacht erop. **Verandert niets in het " +
      "spel** — er wordt niet geklikt en niemand wordt verplaatst; dit zet alleen een " +
      "bestand neer.\n\n" +
      "Eén stap tegelijk: elke aanroep vervangt de vorige en verhoogt het volgnummer, " +
      "zodat een lezer een verse stap van een oude kan onderscheiden. Roep de tool aan " +
      "met `clear: true` om de stap weg te halen als de run klaar of afgebroken is.\n\n" +
      "De conditie wordt streng gecontroleerd. Klopt er iets niet, dan wordt er **niets** " +
      "geschreven en krijg je te horen wát er waar in de boom mis is.\n\n" +
      CONDITION_HELP,
    inputSchema: {
      instruction: z
        .string()
        .trim()
        .min(1, "Een instructie mag niet leeg zijn.")
        .max(500, "Houd de instructie kort genoeg om in de overlay te passen.")
        .optional()
        .describe(
          "De stap voor de speler, in gewone taal en in de gebiedende wijs: 'Hak drie " +
            "logs bij de bomen ten noorden van Lumbridge'. Verplicht, tenzij `clear` aan staat.",
        ),
      note: z
        .string()
        .trim()
        .min(1)
        .max(300)
        .optional()
        .describe(
          "Eén of twee zinnen toelichting, bijvoorbeeld waar het gereedschap al ligt.",
        ),
      timeoutSeconds: z
        .number()
        .int()
        .min(10, "Minder dan tien seconden is geen stap maar een druk op de knop.")
        .max(7200, "Langer dan twee uur op één stap wachten is geen stap meer.")
        .optional()
        .describe(
          "Hoe lang het wachtscript hoogstens op deze stap wacht. Laat weg om het script " +
            "zijn eigen standaard te laten kiezen.",
        ),
      condition: z
        .record(z.string(), z.unknown())
        .nullable()
        .optional()
        .describe(
          "Waaraan te zien is dat de stap is uitgevoerd. Laat weg (of geef null) als de " +
            "stap niet machinaal vast te stellen is — het wachtscript weigert dan te " +
            "wachten en zegt dat erbij. Zie de beschrijving van deze tool voor het schema.",
        ),
      clear: z
        .boolean()
        .optional()
        .describe(
          "Wist de actieve stap. Laat dan alle andere velden weg. Het volgnummer loopt " +
            "ook bij het wissen op, zodat een lezer ziet dat er iets veranderd is.",
        ),
    },
  },
  async ({ instruction, note, timeoutSeconds, condition, clear }) => {
    const fail = (text: string) => ({
      content: [{ type: "text" as const, text }],
      isError: true,
    });

    // Wissen is een eigen aanroep, geen bijvangst van een ontbrekende instructie. Zou
    // een weggelaten `instruction` stilzwijgend wissen, dan haalt één vergeten veld de
    // stap van het scherm zonder dat iemand dat bedoelde.
    if (clear === true) {
      const extras = [
        instruction === undefined ? null : "instruction",
        note === undefined ? null : "note",
        timeoutSeconds === undefined ? null : "timeoutSeconds",
        condition === undefined ? null : "condition",
      ].filter((name): name is string => name !== null);

      if (extras.length > 0) {
        return fail(
          "`clear` staat aan, maar er is ook " +
            extras.map((name) => `\`${name}\``).join(", ") +
            " meegegeven. Wissen en zetten zijn twee verschillende aanroepen; er is " +
            "niets geschreven.",
        );
      }
    } else if (instruction === undefined) {
      return fail(
        "Geef een `instruction` — de stap zoals de speler hem te zien krijgt. Wil je de " +
          "actieve stap juist weghalen, roep deze tool dan aan met `clear: true`. Er is " +
          "niets geschreven.",
      );
    }

    // Valideren vóór er naar de map gekeken wordt. Een afgekeurde conditie mag nooit
    // half landen, en een fout in de conditie is iets anders dan een fout in de omgeving.
    let validated: Condition | null = null;
    if (clear !== true && condition !== undefined && condition !== null) {
      const result = validateCondition(condition);
      if (!result.ok) {
        return fail(
          [
            "**De conditie is afgekeurd; er is niets geschreven.**",
            "",
            ...result.problems.map((problem) => `- \`${problem.path}\` ${problem.message}`),
            "",
            "Corrigeer de conditie en roep `set_step` opnieuw aan. De vorige stap staat " +
              "nog onveranderd in het bestand.",
          ].join("\n"),
        );
      }
      validated = result.condition;
    }

    // Map bestaat, is leesbaar en is niet leeg — dezelfde drie gevallen als bij het
    // lezen, hier om een verkeerde mount te betrappen vóór er een stap in het niets valt.
    let pluginFilesPresent: boolean;
    try {
      ({ pluginFilesPresent } = await checkDataDir());
    } catch (error: unknown) {
      return fail(stepError(error, "het zetten van de stap"));
    }

    // Een relatief XP-doel kan alleen nú omgerekend worden: de basis is de stand op het
    // moment van schrijven. Lukt dat niet, dan gaat er niets naar de map — een stap met
    // een halve conditie is erger dan geen stap.
    if (validated !== null) {
      for (const target of relativeXpTargets(validated)) {
        let baseline: { xp: number; at: string };
        try {
          baseline = await xpBaseline(target.node.skill);
        } catch (error: unknown) {
          const reason =
            error instanceof XpBaselineError
              ? error.message
              : `Onverwachte fout bij het omrekenen van het XP-doel: ${
                  error instanceof Error ? error.message : String(error)
                }`;
          return fail(`${reason}\n\nHet gaat om \`${target.path}\` (${target.node.skill}).`);
        }

        target.node.minXp = baseline.xp + target.node.xpGain!;
        target.node.baselineXp = baseline.xp;
        target.node.baselineAt = baseline.at;
        delete target.node.xpGain;
      }
    }

    const previous = await readCurrentStep();
    const seq = await nextStepSeq();
    const step: StepFile = {
      seq,
      issuedAt: new Date().toISOString(),
      instruction: clear === true ? null : instruction!,
      note: clear === true ? null : (note ?? null),
      timeoutSeconds: clear === true ? null : (timeoutSeconds ?? null),
      condition: clear === true ? null : validated,
    };

    let path: string;
    try {
      path = await writeStep(step);
    } catch (error: unknown) {
      return fail(stepError(error, "het zetten van de stap"));
    }

    // Geschreven, maar mogelijk in een map die niemand leest. Een mislukte CIFS-mount
    // laat een lege map achter; schrijven lukt daar prima en de overlay ziet niets.
    const mountWarning =
      "\n**Er ligt geen enkel bestand van de plugin in deze map.** De stap is wel " +
      "geschreven, maar een map zonder `player-state.json` of `inventory.json` is " +
      "meestal een mount die niet aangehaakt is — en dan leest niemand wat hier staat. " +
      "Controleer met `get_player_state` of de keten klopt.";

    if (clear === true) {
      const lines = [
        `# Stap gewist (volgnummer ${seq})`,
        "",
        `De envelop in \`${path}\` staat nu leeg: geen instructie, geen conditie. De ` +
          "overlay toont niets meer en het wachtscript heeft niets om op te wachten.",
      ];
      if (previous !== null && previous.instruction !== null) {
        lines.push("", `De gewiste stap was: "${previous.instruction}".`);
      }
      if (!pluginFilesPresent) lines.push("", mountWarning.trim());
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    const lines = [`# Stap ${seq} gezet`, "", `- Instructie: **${instruction!}**`];
    if (note !== undefined) lines.push(`- Toelichting: ${note}`);
    lines.push(
      `- Conditie: ${
        validated === null
          ? "**geen**"
          : `${describeCondition(validated)} — ${nl(countLeaves(validated))} blad(eren)`
      }`,
      `- Wachttijd: ${
        timeoutSeconds === undefined
          ? "de standaard van het wachtscript"
          : `${timeoutSeconds} seconden`
      }`,
      `- Geschreven naar \`${path}\` op ${step.issuedAt}.`,
    );

    if (previous !== null && previous.instruction !== null) {
      lines.push(
        "",
        `Dit vervangt stap ${previous.seq} ("${previous.instruction}"). Een wachtscript ` +
          "dat daar nog op wachtte ziet het hogere volgnummer en stopt.",
      );
    }

    if (validated === null) {
      lines.push(
        "",
        "**Er is geen conditie meegegeven.** De stap komt wel in de overlay, maar het " +
          "wachtscript weigert erop te wachten — het kan niet vaststellen dat hij klaar " +
          "is. Vraag de speler het zelf te melden, of zet de stap opnieuw met een conditie.",
      );
    }

    if (!pluginFilesPresent) lines.push("", mountWarning.trim());

    lines.push(
      "",
      "Er is niets veranderd in het spel: de stap staat alleen op de gedeelde map. De " +
        "plugin leest hem via SMB, dus tussen schrijven en tonen zit ongeveer een seconde.",
    );

    return { content: [{ type: "text", text: lines.join("\n") }] };
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
