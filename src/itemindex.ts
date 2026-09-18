/**
 * De brug tussen de plugin en de wiki: van een item-ID uit een snapshot naar
 * het item zoals de wiki het kent.
 *
 * Koppelen op naam is verleidelijk maar onbetrouwbaar — de plugin schrijft de
 * naam op die RuneLite in het spel toont, en die is niet altijd de wiki-naam.
 * Het ID is wél hetzelfde getal aan beide kanten, dus dat is de sleutel.
 *
 * Waarom een index in plaats van een query per item: Bucket kan niet op meer
 * dan één waarde tegelijk filteren. `where(veld, {a, b})` geeft "All values
 * must be scalars" en er is geen `orWhere` (beide nagemeten 2026-09-18). Een
 * bank met vierhonderd verschillende items zou dus vierhonderd requests naar
 * de wiki kosten. In plaats daarvan wordt de hele tabel één keer opgehaald —
 * vier requests, ongeveer 16.000 ID's — en daarna in het geheugen bevraagd.
 *
 * De index is bewust *lui*: hij wordt pas gebouwd bij de eerste vraag die hem
 * nodig heeft, niet bij het starten. Een server die opstart mag de wiki niet
 * gaan bevragen voor een gesprek dat misschien alleen `get_skills` gebruikt,
 * en de MCP-handshake mag er niet op wachten.
 */

import { BUCKET_MAX_ROWS, WikiError, asList, asText, runBucket } from "./bucket.js";

/** Eén item-ID zoals de wiki hem kent. */
export interface WikiItem {
  id: number;
  /** De wiki-pagina waar het item op staat. */
  pageName: string;
  /** De naam van het item zelf; kan afwijken van de paginanaam. */
  itemName: string;
  /** Welke versie op die pagina, bij items met varianten of doses. */
  versionAnchor: string | null;
  /** De quest uit de infobox, of null als er geen questeis staat. */
  quest: string | null;
}

export interface ItemIndex {
  builtAt: number;
  /** Aantal rijen dat de wiki teruggaf. */
  rowCount: number;
  /** Aantal unieke numerieke ID's in de index. */
  idCount: number;
  /** Rijen zonder enig item-ID: items die de wiki kent maar het spel niet. */
  rowsWithoutId: number;
  /** ID's als `hist4000` — geen spel-ID, dus overgeslagen. */
  nonNumericIds: number;
  byId: Map<number, WikiItem[]>;
  /** Kleine letters, op `itemName`. */
  byName: Map<string, WikiItem[]>;
  /** Kleine letters, op `pageName`. */
  byPage: Map<string, WikiItem[]>;
}

const INDEX_FIELDS = [
  "page_name",
  "item_name",
  "version_anchor",
  "item_id",
  "quest",
] as const;

/**
 * Item-ID's veranderen alleen bij een game-update, dus een dag is ruim. De
 * index wordt in dezelfde adem opnieuw opgebouwd als hij verlopen is; er is
 * geen achtergrondproces dat hem ververst.
 */
const INDEX_TTL_MS = 24 * 3_600_000;

/**
 * Een noodrem, geen verwachting: bij ongeveer 17.000 rijen zijn vier blokken
 * genoeg. Zou de wiki ooit blijven doorleveren, dan stopt het hier in plaats
 * van de wiki eindeloos te bevragen.
 */
const MAX_PAGES = 12;

let cached: ItemIndex | null = null;
/** De lopende bouw, zodat twee gelijktijdige tools niet allebei gaan ophalen. */
let inFlight: Promise<ItemIndex> | null = null;

const NUMERIC_ID = /^\d+$/;

const push = <K>(map: Map<K, WikiItem[]>, key: K, item: WikiItem): void => {
  const existing = map.get(key);
  if (existing) existing.push(item);
  else map.set(key, [item]);
};

const buildIndex = async (): Promise<ItemIndex> => {
  const byId = new Map<number, WikiItem[]>();
  const byName = new Map<string, WikiItem[]>();
  const byPage = new Map<string, WikiItem[]>();

  let rowCount = 0;
  let rowsWithoutId = 0;
  let nonNumericIds = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    // Niet cachen: dit is ruim anderhalve megabyte ruwe JSON per blok en de
    // verwerkte vorm hieronder wordt zelf al bewaard.
    const { rows } = await runBucket(
      {
        table: "infobox_item",
        select: [...INDEX_FIELDS],
        where: [],
        limit: BUCKET_MAX_ROWS,
        offset: page * BUCKET_MAX_ROWS,
      },
      false,
    );

    for (const row of rows) {
      rowCount += 1;
      const pageName = asText(row.page_name);
      if (pageName === null) continue;
      const itemName = asText(row.item_name) ?? pageName;
      const quest = asText(row.quest);
      const ids = asList(row.item_id);
      if (ids.length === 0) {
        rowsWithoutId += 1;
        continue;
      }

      for (const raw of ids) {
        if (!NUMERIC_ID.test(raw)) {
          // `hist1234` staat voor een item dat alleen in de geschiedenis van de
          // wiki bestaat. Zulke ID's kunnen niet uit een snapshot komen.
          nonNumericIds += 1;
          continue;
        }
        const item: WikiItem = {
          id: Number(raw),
          pageName,
          itemName,
          versionAnchor: asText(row.version_anchor),
          // De infobox schrijft "No" als er geen questeis is; dat is geen quest.
          quest: quest && quest.toLowerCase() !== "no" ? quest : null,
        };
        push(byId, item.id, item);
        push(byName, itemName.toLowerCase(), item);
        push(byPage, pageName.toLowerCase(), item);
      }
    }

    if (rows.length < BUCKET_MAX_ROWS) break;
  }

  if (byId.size === 0) {
    throw new WikiError(
      "De item-index van de wiki kwam leeg terug. Zonder die index zijn item-ID's " +
        "uit de plugin niet aan wiki-items te koppelen; er wordt bewust niet " +
        "teruggevallen op koppelen op naam alleen.",
    );
  }

  return {
    builtAt: Date.now(),
    rowCount,
    idCount: byId.size,
    rowsWithoutId,
    nonNumericIds,
    byId,
    byName,
    byPage,
  };
};

export const loadItemIndex = async (): Promise<ItemIndex> => {
  if (cached && Date.now() - cached.builtAt < INDEX_TTL_MS) return cached;
  if (inFlight) return inFlight;

  inFlight = buildIndex()
    .then((index) => {
      cached = index;
      return index;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
};

/* ------------------------------------------------------------------ *
 * Koppelen
 * ------------------------------------------------------------------ */

export type LinkMethod =
  /** Het ID staat in de wiki-index. De betrouwbare weg. */
  | "id"
  /** Het ID min één staat erin en heeft dezelfde naam: vrijwel zeker noted. */
  | "noted"
  /** Alleen de naam kwam overeen; het ID kent de wiki niet. */
  | "name"
  /** Niets kwam overeen. Wordt gemeld, nooit stilzwijgend weggelaten. */
  | "unlinked";

export interface LinkedHolding {
  /** Uit welke container deze regel komt. */
  source: string;
  id: number;
  /** De naam zoals de plugin hem opschreef (de naam uit het spel). */
  pluginName: string;
  quantity: number;
  match: WikiItem | null;
  method: LinkMethod;
  /** Uitleg bij alles wat geen rechttoe rechtaan ID-match is. */
  note: string | null;
}

/**
 * Kiezen tussen meerdere wiki-items met hetzelfde ID. Dat komt zelden voor —
 * 16 van de 16.027 ID's op 2026-09-18 — en dan gaat het steeds om hetzelfde
 * item op meerdere pagina's (clue scrolls per stap, league-orbs per league).
 * De naam uit de plugin is dan de doorslaggevende stem, daarna de pagina die
 * net zo heet als het item zelf.
 */
const pickBest = (candidates: WikiItem[], pluginName: string): WikiItem => {
  const wanted = pluginName.toLowerCase();
  const scored = [...candidates].sort(
    (a, b) =>
      Number(b.itemName.toLowerCase() === wanted) -
        Number(a.itemName.toLowerCase() === wanted) ||
      Number(b.pageName.toLowerCase() === b.itemName.toLowerCase()) -
        Number(a.pageName.toLowerCase() === a.itemName.toLowerCase()) ||
      a.pageName.localeCompare(b.pageName, "en"),
  );
  return scored[0]!;
};

/** true als alle kandidaten hetzelfde item zijn, alleen op andere pagina's. */
const sameItem = (candidates: WikiItem[]): boolean =>
  new Set(candidates.map((c) => c.itemName.toLowerCase())).size === 1;

export const linkHolding = (
  index: ItemIndex,
  source: string,
  id: number,
  pluginName: string,
  quantity: number,
): LinkedHolding => {
  const base = { source, id, pluginName, quantity };

  const exact = index.byId.get(id);
  if (exact && exact.length > 0) {
    const match = pickBest(exact, pluginName);
    const notes: string[] = [];
    if (exact.length > 1 && !sameItem(exact)) {
      notes.push(
        `ID ${id} staat op de wiki bij meer dan één item (` +
          exact.map((c) => `"${c.itemName}" op "${c.pageName}"`).join(", ") +
          `); gekozen is "${match.itemName}" omdat die naam het dichtst bij de ` +
          `plugin-naam "${pluginName}" ligt.`,
      );
    }
    if (match.itemName.toLowerCase() !== pluginName.toLowerCase()) {
      // Geen fout: het spel en de wiki noemen hetzelfde item soms anders. Wel
      // iets om te tonen, want de gebruiker zoekt op de naam uit het spel.
      notes.push(
        `Het spel noemt dit "${pluginName}", de wiki "${match.itemName}".`,
      );
    }
    return { ...base, match, method: "id", note: notes.join(" ") || null };
  }

  // Noted items hebben een eigen ID dat de wiki niet kent, want de wiki
  // documenteert alleen de gewone vorm. In OSRS is dat ID het gewone ID plus
  // één, en de plugin schrijft voor beide dezelfde naam op (RuneLite's
  // ItemComposition geeft de noted vorm dezelfde naam). Die naamgelijkheid is
  // hier de controle: zonder die eis zou "ID − 1" een willekeurig ander item
  // kunnen aanwijzen.
  const neighbours = index.byId.get(id - 1);
  if (neighbours) {
    const noted = neighbours.find(
      (c) => c.itemName.toLowerCase() === pluginName.toLowerCase(),
    );
    if (noted) {
      return {
        ...base,
        match: noted,
        method: "noted",
        note:
          `ID ${id} kent de wiki niet, maar ${id - 1} is "${noted.itemName}" — ` +
          "dezelfde naam als de plugin opschrijft. Dit is vrijwel zeker de " +
          "noted (beschreven) vorm; de wiki documenteert alleen de gewone.",
      };
    }
  }

  // Laatste kans: de naam. Zwakker dan een ID, dus het wordt er expliciet bij
  // gezet — een naam kan bij meerdere items horen.
  const byName = index.byName.get(pluginName.toLowerCase());
  if (byName && byName.length > 0) {
    const match = pickBest(byName, pluginName);
    return {
      ...base,
      match,
      method: "name",
      note:
        `ID ${id} staat niet in de wiki-data; gekoppeld op de naam ` +
        `"${pluginName}"` +
        (byName.length > 1
          ? ` (die naam hoort bij ${byName.length} wiki-items, waaronder ID's ` +
            `${byName
              .slice(0, 5)
              .map((c) => c.id)
              .join(", ")})`
          : "") +
        ". Een naamkoppeling is minder zeker dan een ID-koppeling.",
    };
  }

  return {
    ...base,
    match: null,
    method: "unlinked",
    note:
      `ID ${id} ("${pluginName}") is niet aan een wiki-item te koppelen: het ID ` +
      "staat niet in de wiki-data en de naam ook niet. Dat kan een item zijn " +
      "dat nieuwer is dan de wiki-index, een minigame-variant, of een naam die " +
      "in het spel anders luidt dan op de wiki.",
  };
};

/* ------------------------------------------------------------------ *
 * Zoeken in wat de speler heeft
 * ------------------------------------------------------------------ */

export interface HoldingMatch {
  holding: LinkedHolding;
  /** Waarop deze regel bij het gezochte item hoort. */
  via: "wiki-item" | "wiki-pagina" | "plugin-naam";
}

/**
 * Alle regels die bij een gezocht item horen. De volgorde van de drie kanalen
 * is niet willekeurig:
 *
 * 1. Op de wiki-itemnaam van de koppeling — de gewone weg.
 * 2. Op de wiki-paginanaam — voor materialen die als pagina genoemd worden
 *    terwijl het item op die pagina anders heet ("Super attack" → "Super
 *    attack(3)").
 * 3. Op de naam die de plugin opschreef, ook als de koppeling mislukte. Dit
 *    kanaal bestaat om het gevaarlijkste soort fout te voorkomen: een item dat
 *    wél in de bank ligt maar niet te koppelen was, en dat daardoor als
 *    "heb je niet" uit de bus zou komen.
 */
export const findHoldings = (
  holdings: LinkedHolding[],
  wantedName: string,
): HoldingMatch[] => {
  const wanted = wantedName.toLowerCase();
  const matches: HoldingMatch[] = [];
  const seen = new Set<LinkedHolding>();

  const add = (holding: LinkedHolding, via: HoldingMatch["via"]): void => {
    if (seen.has(holding)) return;
    seen.add(holding);
    matches.push({ holding, via });
  };

  for (const holding of holdings) {
    if (holding.match && holding.match.itemName.toLowerCase() === wanted) {
      add(holding, "wiki-item");
    }
  }
  for (const holding of holdings) {
    if (holding.match && holding.match.pageName.toLowerCase() === wanted) {
      add(holding, "wiki-pagina");
    }
  }
  for (const holding of holdings) {
    if (holding.pluginName.toLowerCase() === wanted) add(holding, "plugin-naam");
  }

  return matches;
};
