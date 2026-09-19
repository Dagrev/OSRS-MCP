/**
 * De route in tekst: welke transports Shortest Path gebruikt, en wat je daarvoor nodig hebt.
 *
 * De route zelf komt niet uit deze server. Shortest Path berekent hem en post de
 * gebruikte transports terug; de plugin schrijft die naar `route.json` en wij lezen dat.
 * Dat is een bewuste keuze boven een eigen, grovere routeberekening: twee pathfinders
 * naast elkaar geven vroeg of laat twee verschillende antwoorden, en dan is de lijn op de
 * kaart in tegenspraak met de tekst eronder. Nu is de tekst per definitie dezelfde route.
 *
 * Wat het `transports`-bericht níét meestuurt, zijn de eisen: welk item, welke quest,
 * welk level. Die staan in de TSV's waar Shortest Path zijn kaartkennis uit haalt, en
 * `scripts/build-transports.mjs` heeft ze daaruit opgehaald en op de aankondigingstekst
 * gezet. Hier worden ze samengebracht met de bank en de inventory, op item-ID — dezelfde
 * koppeling als `check_materials`, en om dezelfde reden: namen botsen, ID's niet.
 */

import { lastCommandSeq, readRoute, type Route, type RouteLeg } from "./destination.js";
import { PluginDataError, readContainer, type ContainerKind } from "./plugindata.js";
import { loadItemIndex } from "./itemindex.js";
import { TRANSPORT_REQUIREMENTS, type TransportRequirement } from "./transportdata.js";

export interface ItemNeed {
  id: number;
  quantity: number;
  /** De naam uit de bank, de inventory of de wiki-index; null als niets hem kent. */
  name: string | null;
  /** Hoeveel er in de gelezen bronnen ligt, of null als geen bron gelezen kon worden. */
  held: number | null;
}

/** Eén manier om aan de eisen van een etappe te voldoen. */
export interface NeedAlternative {
  items: ItemNeed[];
  /** Of alle items in dit alternatief aanwezig zijn. Null zolang een bron ontbreekt. */
  satisfied: boolean | null;
}

export interface PlannedLeg {
  leg: RouteLeg;
  /** De naam waarop de eisen gevonden zijn, of null als er niets bij hoorde. */
  matchedOn: string | null;
  alternatives: NeedAlternative[];
  quests: string[];
  skills: string[];
  /**
   * Meer dan één eisenpakket onder dezelfde naam: de TSV's kennen die tekst op
   * verschillende plekken met verschillende eisen. Dan worden ze allemaal getoond.
   */
  ambiguous: boolean;
}

export interface RoutePlan {
  route: Route;
  legs: PlannedLeg[];
  /** Welke bronnen gelezen zijn, en wat er misging bij de andere. */
  sources: { kind: ContainerKind; ok: boolean; note: string }[];
  /** Of de wiki-index gelezen is; zonder index blijven onbekende items naamloos. */
  itemNamesResolved: boolean;
  /** Het loopnummer van de laatste opdracht, om een verouderde route te herkennen. */
  currentSeq: number;
}

/**
 * De eisen bij een etappe.
 *
 * Eerst op `displayInfo`, dan op `objectInfo`. Die volgorde is niet willekeurig:
 * `displayInfo` is de tekst die Shortest Path aan een mens toont ("Varrock Teleport") en
 * daarmee het specifiekst, terwijl `objectInfo` ("Travel Spirit tree 26261") hetzelfde
 * object op tientallen plekken kan aanduiden.
 */
const requirementsFor = (leg: RouteLeg): { key: string; found: readonly TransportRequirement[] } | null => {
  for (const key of [leg.displayInfo, leg.objectInfo]) {
    if (key === null || key.trim().length === 0) continue;
    const found = TRANSPORT_REQUIREMENTS[key.trim()];
    if (found !== undefined && found.length > 0) return { key: key.trim(), found };
  }
  return null;
};

/**
 * Bezit per item-ID uit de opgegeven containers.
 *
 * Een container die niet te lezen is levert geen nullen op maar ontbreekt: het verschil
 * tussen "je hebt het niet" en "ik weet het niet" is in dit hele project het punt, en een
 * ontbrekende bank mag geen advies worden om een teleport te gaan kopen die al in de kluis
 * ligt.
 */
const readHoldings = async (): Promise<{
  counts: Map<number, number> | null;
  names: Map<number, string>;
  sources: RoutePlan["sources"];
}> => {
  const counts = new Map<number, number>();
  const names = new Map<number, string>();
  const sources: RoutePlan["sources"] = [];
  let anyRead = false;

  for (const kind of ["bank", "inventory"] as const) {
    try {
      const container = await readContainer(kind);
      for (const item of container.items) {
        counts.set(item.id, (counts.get(item.id) ?? 0) + item.quantity);
        names.set(item.id, item.name);
      }
      anyRead = true;
      sources.push({
        kind,
        ok: true,
        note: `${container.items.length} regel(s), snapshot van ${container.timestamp}`,
      });
    } catch (error: unknown) {
      sources.push({
        kind,
        ok: false,
        note: error instanceof PluginDataError ? error.message : String(error),
      });
    }
  }

  return { counts: anyRead ? counts : null, names, sources };
};

const toAlternative = (
  items: readonly (readonly [number, number])[],
  counts: Map<number, number> | null,
  names: Map<number, string>,
): NeedAlternative => {
  const needs: ItemNeed[] = items.map(([id, quantity]) => ({
    id,
    quantity,
    name: names.get(id) ?? null,
    held: counts === null ? null : (counts.get(id) ?? 0),
  }));

  const satisfied = needs.some((need) => need.held === null)
    ? null
    : needs.every((need) => (need.held ?? 0) >= need.quantity);

  return { items: needs, satisfied };
};

/**
 * Zet de laatst berekende route om in een plan.
 *
 * Verandert niets in de client. Deze functie leest alleen: de route die er al ligt, de
 * bank, de inventory en de wiki-index. Een bestemming zetten gebeurt in `destination.ts`
 * en nergens anders.
 */
export const planRoute = async (): Promise<RoutePlan | null> => {
  const route = await readRoute();
  if (route === null) return null;

  const { counts, names, sources } = await readHoldings();

  // De namen van items die je níét hebt staan per definitie niet in de bank of de
  // inventory. Zonder de wiki-index blijft het dan bij "item-ID 13121", en dat is een
  // antwoord waar niemand iets aan heeft.
  let itemNamesResolved = false;
  try {
    const index = await loadItemIndex();
    for (const [id, items] of index.byId) {
      if (names.has(id) || items.length === 0) continue;
      names.set(id, items[0]!.itemName);
    }
    itemNamesResolved = true;
  } catch {
    // De wiki is onbereikbaar. De route zelf staat er nog; alleen de namen van items die
    // je niet bezit ontbreken, en dat is geen reden om het hele antwoord te laten vallen.
  }

  const legs: PlannedLeg[] = route.legs.map((leg) => {
    const match = requirementsFor(leg);
    if (match === null) {
      return { leg, matchedOn: null, alternatives: [], quests: [], skills: [], ambiguous: false };
    }

    const alternatives: NeedAlternative[] = [];
    const quests = new Set<string>();
    const skills = new Set<string>();

    for (const requirement of match.found) {
      for (const items of requirement.items) {
        alternatives.push(toAlternative(items, counts, names));
      }
      for (const quest of requirement.quests) quests.add(quest);
      for (const skill of requirement.skills) skills.add(skill);
    }

    return {
      leg,
      matchedOn: match.key,
      alternatives,
      quests: [...quests],
      skills: [...skills],
      ambiguous: match.found.length > 1,
    };
  });

  return {
    route,
    legs,
    sources,
    itemNamesResolved,
    currentSeq: await lastCommandSeq(),
  };
};
