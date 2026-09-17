/**
 * OSRS Hiscores — ophalen en parsen.
 *
 * De hiscores geven platte CSV terug zonder kolomnamen. De volgorde van de
 * regels is de enige identificatie van een skill.
 */

import { USER_AGENT } from "./useragent.js";

/**
 * Skillvolgorde van `index_lite.ws`, geverifieerd tegen de live API op
 * 2026-09-16. De index IS de identificatie — er staan geen namen in de
 * respons. Nieuwe skills komen altijd ACHTERAAN erbij (Sailing is zo op
 * index 24 gekomen); voeg ze dus alleen aan het einde toe, herschik nooit.
 *
 * Staat er een skill in de respons die hier nog niet staat, dan valt de parser
 * daar niet over: die krijgt een placeholdernaam. Zie `parseHiscores`.
 */
export const SKILL_ORDER = [
  "Overall",
  "Attack",
  "Defence",
  "Strength",
  "Hitpoints",
  "Ranged",
  "Prayer",
  "Magic",
  "Cooking",
  "Woodcutting",
  "Fletching",
  "Fishing",
  "Firemaking",
  "Crafting",
  "Smithing",
  "Mining",
  "Herblore",
  "Agility",
  "Thieving",
  "Slayer",
  "Farming",
  "Runecraft",
  "Hunter",
  "Construction",
  "Sailing",
] as const;

/**
 * Group Ironman heeft GEEN eigen `index_lite`-tabel. Geverifieerd op 2026-09-16:
 * alle plausibele padnamen (`..._group_ironman`, `..._groupironman`, `..._group`,
 * `..._hardcore_group_ironman`, `..._hardcore_group`, `..._ironman_group`) geven
 * een 303-redirect — dezelfde respons als een expres verzonnen pad, en dus het
 * bewijs dat het endpoint niet bestaat. Een bestaand pad met een onbekende
 * speler geeft namelijk 404, geen 303.
 *
 * GIM-accounts staan wél in de normale tabel: die bevat alle accounttypes.
 * De groepsranglijsten op de site zijn een aparte, niet-publieke weg.
 */
const GROUP_NOTE =
  "Group Ironman heeft geen eigen hiscore-tabel in deze API. Deze cijfers komen " +
  "uit de normale tabel, waar alle accounttypes in staan — ze zijn dus correct, " +
  "maar de rank is de rank tussen álle spelers, niet binnen de group-ironmen.";

/** De hiscore-tabellen. Paden geverifieerd tegen de live API op 2026-09-16. */
export const ACCOUNT_TYPES = {
  normal: { endpoint: "hiscore_oldschool", note: null },
  ironman: { endpoint: "hiscore_oldschool_ironman", note: null },
  hardcore_ironman: { endpoint: "hiscore_oldschool_hardcore_ironman", note: null },
  ultimate_ironman: { endpoint: "hiscore_oldschool_ultimate", note: null },
  // Vallen bewust terug op de normale tabel; zie GROUP_NOTE hierboven.
  group_ironman: { endpoint: "hiscore_oldschool", note: GROUP_NOTE },
  hardcore_group_ironman: { endpoint: "hiscore_oldschool", note: GROUP_NOTE },
} as const;

export type AccountType = keyof typeof ACCOUNT_TYPES;

export interface SkillEntry {
  name: string;
  /** null = niet gerangschikt op de hiscores (API geeft -1). */
  rank: number | null;
  /** null = geen waarde op de hiscores (API geeft -1), NIET level 0. */
  level: number | null;
  xp: number | null;
}

export interface HiscoresResult {
  username: string;
  accountType: AccountType;
  skills: SkillEntry[];
  /** true als de respons meer skills bevatte dan SKILL_ORDER kent. */
  hasUnknownSkills: boolean;
  /** true als dit uit de cache kwam in plaats van een verse call. */
  cached: boolean;
  /** Toelichting die bij dit accounttype hoort, of null. */
  note: string | null;
}

/** Fout met een melding die rechtstreeks aan de gebruiker getoond kan worden. */
export class HiscoresError extends Error {}

const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60_000;

const cache = new Map<string, { at: number; result: HiscoresResult }>();

/** -1 betekent "niet op de hiscores", niet "nul". */
const numOrNull = (raw: string): number | null => {
  const n = Number(raw);
  if (!Number.isFinite(n) || n === -1) return null;
  return n;
};

export function parseHiscores(body: string): { skills: SkillEntry[]; hasUnknownSkills: boolean } {
  const lines = body.trim().split("\n");
  const skills: SkillEntry[] = [];
  let hasUnknownSkills = false;

  // Skillregels hebben drie velden (rank,level,xp); daarna beginnen de
  // activiteiten met twee velden (rank,score). Die grens is waar we stoppen.
  for (const line of lines) {
    const parts = line.trim().split(",");
    if (parts.length !== 3) break;

    const index = skills.length;
    const known = index < SKILL_ORDER.length;
    if (!known) hasUnknownSkills = true;

    skills.push({
      name: known ? SKILL_ORDER[index]! : `Onbekende skill (index ${index})`,
      rank: numOrNull(parts[0]!),
      level: numOrNull(parts[1]!),
      xp: numOrNull(parts[2]!),
    });
  }

  if (skills.length === 0) {
    throw new HiscoresError(
      "De hiscores gaven een respons terug die niet als skilldata te lezen was. " +
        "Mogelijk is de API tijdelijk uit de lucht of is het antwoord een foutpagina.",
    );
  }

  return { skills, hasUnknownSkills };
}

export async function fetchSkills(
  username: string,
  accountType: AccountType,
): Promise<HiscoresResult> {
  const name = username.trim();
  const { endpoint, note } = ACCOUNT_TYPES[accountType];
  // Op endpoint cachen, niet op accounttype: de group-varianten delen een tabel.
  const key = `${endpoint}:${name.toLowerCase()}`;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { ...hit.result, accountType, note, cached: true };
  }

  const url =
    `https://secure.runescape.com/m=${endpoint}` +
    `/index_lite.ws?player=${encodeURIComponent(name)}`;

  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { "User-Agent": USER_AGENT },
    });
  } catch (error: unknown) {
    // AbortSignal.timeout levert een TimeoutError op; al het andere is netwerk.
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new HiscoresError(
        `De hiscores reageerden niet binnen ${REQUEST_TIMEOUT_MS / 1000} seconden. ` +
          "Probeer het zo nog eens.",
      );
    }
    throw new HiscoresError(
      `Kon de hiscores niet bereiken: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (response.status === 404) {
    throw new HiscoresError(
      `Geen vermelding gevonden voor "${name}" op de ${accountType}-hiscores. ` +
        "Mogelijke oorzaken: een typefout, een verkeerd accounttype (een solo-ironman " +
        "staat niet in de normale tabel), of een account dat nog nergens gerangschikt " +
        "is. Let op dat dit de character name moet zijn, niet de naam van het " +
        "Jagex-account. Group Ironman hoort hier op 'group_ironman'.",
    );
  }

  if (!response.ok) {
    throw new HiscoresError(
      `De hiscores gaven een onverwachte status terug (HTTP ${response.status}).`,
    );
  }

  const { skills, hasUnknownSkills } = parseHiscores(await response.text());
  const result: HiscoresResult = {
    username: name,
    accountType,
    skills,
    hasUnknownSkills,
    cached: false,
    note,
  };

  cache.set(key, { at: Date.now(), result });
  return result;
}
