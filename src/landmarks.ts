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
