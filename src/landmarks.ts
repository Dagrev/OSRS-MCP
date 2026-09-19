/**
 * Van een coördinaat naar iets dat een taalmodel kan gebruiken.
 *
 * `player-state.json` geeft `x`, `y`, `plane` en een region-ID. Dat zijn vier
 * getallen waar Claude niets mee kan: "3244, 3263" antwoordt niet op "is dit
 * dichtbij". Deze module zet ze om naar "62 tiles noordelijk van de bank van
 * Al Kharid, in Misthalin".
 *
 * Er zijn drie lagen, van precies naar grof:
 *
 *   1. **Het dichtstbijzijnde benoemde punt** uit `LANDMARKS` — bank, altaar
 *      of teleportbestemming — met afstand en windrichting.
 *   2. **Het league-gebied** uit `REGION_NAMES`, op region-ID.
 *   3. **Niets** — dan blijven de ruwe coördinaten het antwoord.
 *
 * Laag 1 en 2 vullen elkaar aan in plaats van elkaar te vervangen: het gebied
 * zegt waar je op de kaart zit, het punt zegt waar je precies staat.
 *
 * Alles hier is zuiver rekenwerk op een gegenereerde tabel — geen I/O, geen
 * netwerk. Zie `scripts/build-landmarks.mjs` voor waar die tabel vandaan komt.
 */

import { LANDMARK_CATEGORIES, LANDMARKS, REGION_NAMES } from "./landmarkdata.js";

/**
 * Verder dan dit heet geen landmark meer. 200 tiles is ongeveer twee
 * kaartschermen: "200 tiles van de bank van Catherby" is nog nét informatief,
 * daarbuiten is het misleidend precies — dan is het gebied het echte antwoord.
 */
export const LANDMARK_MAX_TILES = 200;

/**
 * Tot deze afstand is "X tiles van Y" zonder voorbehoud bruikbaar. Daarboven
 * gaat de afstand hemelsbreed steeds vaker over water of door een muur —
 * Brimhaven ligt 128 tiles van het altaar van Witchaven, maar met een zee
 * ertussen. De richting en de afstand blijven waar; de suggestie dat je er zo
 * heen loopt niet.
 */
export const LANDMARK_NEAR_TILES = 100;

export interface NearestLandmark {
  name: string;
  /** "bank", "altaar" of "teleport". */
  category: string;
  x: number;
  y: number;
  plane: number;
  /** Afstand in tiles, hemelsbreed over x/y. */
  tiles: number;
  /** Windrichting van het landmark náár de speler, of null als je erop staat. */
  direction: string | null;
  /** Of het landmark op dezelfde verdieping ligt als de speler. */
  samePlane: boolean;
  /** Verder dan {@link LANDMARK_NEAR_TILES}: bruikbaar, maar met voorbehoud. */
  distant: boolean;
}

export interface PlaceDescription {
  landmark: NearestLandmark | null;
  /** Gebiedsnaam bij het region-ID, of null als dat ID niet in de tabel staat. */
  region: string | null;
  /** Eén regel Nederlands: dit is wat het antwoord uiteindelijk toont. */
  summary: string;
}

/**
 * Acht windrichtingen, Nederlands. Meer dan acht suggereert een precisie die
 * er niet is; minder maakt "ten noorden van" te vaak onwaar.
 */
const DIRECTIONS = [
  { label: "noorden", dx: 0, dy: 1 },
  { label: "noordoosten", dx: 1, dy: 1 },
  { label: "oosten", dx: 1, dy: 0 },
  { label: "zuidoosten", dx: 1, dy: -1 },
  { label: "zuiden", dx: 0, dy: -1 },
  { label: "zuidwesten", dx: -1, dy: -1 },
  { label: "westen", dx: -1, dy: 0 },
  { label: "noordwesten", dx: -1, dy: 1 },
] as const;

/**
 * Windrichting uit het verschil in tiles. In OSRS loopt `y` naar het noorden
 * en `x` naar het oosten, dus `atan2` op (dx, dy) geeft de hoek vanaf noord.
 */
const compass = (dx: number, dy: number): string | null => {
  if (dx === 0 && dy === 0) return null;
  const degrees = (Math.atan2(dx, dy) * 180) / Math.PI;
  const index = Math.round(((degrees + 360) % 360) / 45) % 8;
  return DIRECTIONS[index]!.label;
};

/**
 * Hemelsbrede afstand, afgerond. Niet de looproute: die zou transports en
 * muren moeten kennen en dat is het werk van Shortest Path, niet van deze
 * server. Het antwoord is dus "hoe ver ligt het", niet "hoe lang doe ik erover".
 */
const tileDistance = (dx: number, dy: number): number => Math.round(Math.hypot(dx, dy));

/**
 * Het dichtstbijzijnde benoemde punt binnen {@link LANDMARK_MAX_TILES}.
 *
 * De verdieping telt niet mee in de afstand. Sta je op de eerste verdieping
 * van de bank van Varrock, dan is de bank eronder nog steeds de juiste
 * plaatsaanduiding; een gelijke verdieping breekt alleen de gelijkspelen.
 */
export const nearestLandmark = (
  x: number,
  y: number,
  plane: number,
): NearestLandmark | null => {
  let best: NearestLandmark | null = null;

  for (const [lx, ly, lplane, name, categoryIndex] of LANDMARKS) {
    const dx = x - lx;
    const dy = y - ly;
    const tiles = tileDistance(dx, dy);
    if (tiles > LANDMARK_MAX_TILES) continue;

    const samePlane = lplane === plane;
    if (best !== null) {
      if (tiles > best.tiles) continue;
      // Gelijke afstand: dezelfde verdieping wint, daarna de eerste vondst.
      if (tiles === best.tiles && !(samePlane && !best.samePlane)) continue;
    }

    best = {
      name,
      category: LANDMARK_CATEGORIES[categoryIndex] ?? "punt",
      x: lx,
      y: ly,
      plane: lplane,
      tiles,
      direction: compass(dx, dy),
      samePlane,
      distant: tiles > LANDMARK_NEAR_TILES,
    };
  }

  return best;
};

/** Hoe een soort punt in een zin heet. */
const CATEGORY_PHRASE: Record<string, (name: string) => string> = {
  bank: (name) => `de bank van ${name}`,
  altaar: (name) => `het altaar van ${name}`,
  teleport: (name) => `de teleportbestemming ${name}`,
};

const describeLandmark = (landmark: NearestLandmark): string => {
  const phrase = (CATEGORY_PHRASE[landmark.category] ?? ((name: string) => name))(landmark.name);
  if (landmark.tiles === 0) {
    return `op ${phrase}`;
  }
  const direction = landmark.direction === null ? "" : ` ten ${landmark.direction} van`;
  return `${landmark.tiles} tile(s)${direction} ${phrase}`;
};

/**
 * De volledige plaatsaanduiding. `inInstance` verandert niets aan de
 * berekening maar wél aan de formulering: in een instance geeft de plugin de
 * coördinaat van de gekopieerde sjabloontegel, en die ligt zelden bij het
 * landmark dat de speler om zich heen ziet. Het antwoord mag dan niet klinken
 * alsof het zeker is.
 */
export const describePlace = (
  x: number,
  y: number,
  plane: number,
  regionId: number,
  inInstance: boolean,
): PlaceDescription => {
  const landmark = nearestLandmark(x, y, plane);
  const region = REGION_NAMES[regionId] ?? null;

  const parts: string[] = [];
  if (landmark !== null) {
    parts.push(describeLandmark(landmark));
    if (!landmark.samePlane) {
      parts.push(`(landmark op verdieping ${landmark.plane}, speler op ${plane})`);
    }
  }
  if (region !== null) {
    parts.push(landmark === null ? `in ${region}` : `— ${region}`);
  }
  if (landmark !== null && landmark.distant) {
    parts.push(
      "(hemelsbreed gemeten en dat is hier ver: er kan water, een muur of een " +
        "berg tussen zitten, dus dit zegt waar de speler ongeveer op de kaart " +
        "staat en niet hoe hij bij dat punt komt)",
    );
  }

  let summary: string;
  if (parts.length === 0) {
    summary =
      `Geen benoemd punt binnen ${LANDMARK_MAX_TILES} tiles en region-ID ` +
      `${regionId} staat niet in de gebiedstabel. Alleen de ruwe coördinaat ` +
      `${x}, ${y} (verdieping ${plane}) is bekend.`;
  } else {
    summary = parts.join(" ");
  }

  if (inInstance) {
    summary =
      `${summary} — **maar de speler staat in een instance**, en daar is de ` +
      "coördinaat die van de gekopieerde sjabloontegel. Deze plaatsaanduiding " +
      "zegt dus waar het gebied van de kaart gekopieerd is, niet waar de " +
      "speler zich lijkt te bevinden.";
  }

  return { landmark, region, summary };
};

/* ------------------------------------------------------------------ *
 * Zoeken: van een gewone naam naar een coördinaat
 * ------------------------------------------------------------------ */

export interface DestinationCandidate {
  name: string;
  category: string;
  /** Een representatieve tegel van dit punt; zie {@link searchLandmarks}. */
  x: number;
  y: number;
  plane: number;
  /** Hoeveel tegels er onder deze naam en soort vallen — een bank is zelden één tegel. */
  tileCount: number;
  /**
   * Waar dit punt ligt ten opzichte van de andere punten met dezelfde naam, als er
   * meerdere zijn: "westelijk", "oostelijk". Null als de naam maar één plek aanduidt.
   */
  areaHint: string | null;
  /** Hoe goed de naam op de zoekterm paste; alleen om te sorteren. */
  score: number;
}

/**
 * Woorden die een soort punt aanduiden in plaats van een plek. "varrock bank" moet de
 * bank van Varrock vinden en niet elk punt met "bank" in de naam, dus deze woorden
 * worden tegen de categorie gelegd en niet tegen de naam.
 */
const CATEGORY_WORDS: Readonly<Record<string, string>> = {
  bank: "bank",
  banken: "bank",
  bankchest: "bank",
  altaar: "altaar",
  altar: "altaar",
  altars: "altaar",
  altaren: "altaar",
  teleport: "teleport",
  teleports: "teleport",
  tele: "teleport",
};

/**
 * Verder dan dit uit elkaar zijn het twee plekken en niet één.
 *
 * Vijfentwintig tiles. "Varrock" staat als banknaam op elf tegels, maar dat zijn de
 * west- én de oostbank, achtenzestig tiles uit elkaar. Die middelen tot één punt levert
 * een coördinaat op die naar geen van beide wijst, en dat is het ergste soort antwoord:
 * het ziet er precies zo uit als een goed antwoord. Een bank zelf beslaat hooguit een
 * tegel of tien, dus alles daarboven is een tweede plek.
 */
const CLUSTER_TILES = 25;

type Tile = [number, number, number];

/**
 * Deelt tegels op in groepen die bij elkaar in de buurt liggen.
 *
 * Enkelvoudige koppeling: een tegel hoort bij een groep zodra hij bij één tegel daarvan
 * dichtbij genoeg ligt, en groepen die daardoor aan elkaar raken worden samengevoegd. Bij
 * elf tegels per naam is de kwadratische kosten daarvan niet het overwegen waard.
 */
const clusterPoints = (points: Tile[]): Tile[][] => {
  const clusters: Tile[][] = [];

  for (const point of points) {
    const touching = clusters.filter((cluster) =>
      cluster.some(
        (other) => Math.hypot(other[0] - point[0], other[1] - point[1]) <= CLUSTER_TILES,
      ),
    );

    if (touching.length === 0) {
      clusters.push([point]);
      continue;
    }

    const merged = [point, ...touching.flat()];
    for (const cluster of touching) {
      clusters.splice(clusters.indexOf(cluster), 1);
    }
    clusters.push(merged);
  }

  return clusters;
};

const centreOf = (points: Tile[]): [number, number] => [
  points.reduce((sum, point) => sum + point[0], 0) / points.length,
  points.reduce((sum, point) => sum + point[1], 0) / points.length,
];

/**
 * De tegel die het dichtst bij het midden van de groep ligt.
 *
 * Het midden zélf teruggeven zou een coördinaat opleveren die geen bankkist is — bij een
 * L-vormige bank ligt dat punt buiten de bank. Dit is altijd een echte tegel uit de bron.
 */
const medoid = (points: Tile[]): Tile => {
  const [centreX, centreY] = centreOf(points);
  let best = points[0]!;
  let bestDistance = Infinity;

  for (const point of points) {
    const distance = Math.hypot(point[0] - centreX, point[1] - centreY);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = point;
    }
  }

  return best;
};

/** Kleine letters, geen leestekens, enkele spaties. */
const normalise = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Zoekt benoemde punten op een gewone naam: "varrock bank", "edgeville", "altaar".
 *
 * Alle woorden moeten raken — óf in de naam van het punt, óf op de soort. Dat is
 * strenger dan "een van de woorden" en dat is met opzet: "varrock bank" hoort niet de
 * bank van Ardougne op te leveren omdat daar toevallig ook "bank" bij staat.
 *
 * Meerdere tegels onder dezelfde naam worden één kandidaat. Een bank beslaat vaak zes
 * tot tien tegels en die als losse resultaten tonen zou de lijst vullen met hetzelfde
 * antwoord. De tegel die terugkomt is die het dichtst bij het midden van de groep ligt —
 * niet zomaar de eerste, want dat is een hoek van de bank en soms net de verkeerde kant
 * van een muur.
 */
export const searchLandmarks = (query: string, limit = 10): DestinationCandidate[] => {
  const tokens = normalise(query).split(" ").filter((token) => token.length > 0);
  if (tokens.length === 0) return [];

  /** Alle tegels per naam+soort, zodat de groep daarna te middelen is. */
  const groups = new Map<
    string,
    { name: string; category: string; points: Tile[]; score: number }
  >();

  for (const [lx, ly, lplane, name, categoryIndex] of LANDMARKS) {
    const category = LANDMARK_CATEGORIES[categoryIndex] ?? "punt";
    const haystack = normalise(name);

    let score = 0;
    const matchesAll = tokens.every((token) => {
      if (CATEGORY_WORDS[token] === category) {
        score += 1;
        return true;
      }
      if (haystack === token) {
        score += 100;
        return true;
      }
      if (haystack.startsWith(`${token} `)) {
        score += 50;
        return true;
      }
      if (haystack.includes(token)) {
        score += 10;
        return true;
      }
      return false;
    });
    if (!matchesAll) continue;

    // Precies de gezochte naam weegt zwaarder dan dezelfde woorden in een langere naam:
    // wie "varrock" zoekt bedoelt zelden "Varrock: Grand Exchange".
    if (haystack === tokens.join(" ")) score += 200;

    const key = `${name}|${category}`;
    const group = groups.get(key) ?? { name, category, points: [], score: 0 };
    group.points.push([lx, ly, lplane]);
    group.score = Math.max(group.score, score);
    groups.set(key, group);
  }

  const candidates: DestinationCandidate[] = [];
  for (const group of groups.values()) {
    const clusters = clusterPoints(group.points);

    // Het midden van álle tegels met deze naam, om de clusters onderling te kunnen
    // benoemen: de westbank van Varrock ligt westelijk van dat midden, de oostbank
    // oostelijk. Alleen zinvol als er meer dan één cluster is.
    const centre = centreOf(group.points);

    for (const cluster of clusters) {
      const representative = medoid(cluster);
      candidates.push({
        name: group.name,
        category: group.category,
        x: representative[0],
        y: representative[1],
        plane: representative[2],
        tileCount: cluster.length,
        areaHint:
          clusters.length > 1
            ? compass(representative[0] - centre[0], representative[1] - centre[1])
            : null,
        score: group.score,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "en"));
  return candidates.slice(0, limit);
};
