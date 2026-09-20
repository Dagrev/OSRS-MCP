#!/usr/bin/env node
/**
 * Genereert `src/questdata.ts` uit de `Quest`-enum van RuneLite.
 *
 * Waarom dit bestand bestaat: het [[Stapcontract]] legt vast dat de sleutel in
 * `quests.json` en de `quest`-waarde in een conditie de **enumconstante** is
 * (`COOKS_ASSISTANT`), niet de weergavenaam ("Cook's Assistant"). En §3.4 van
 * datzelfde contract eist dat `set_step` een onbekende quest weigert. Daar is
 * dus een lijst voor nodig, en de enige juiste bron is de enum zelf — niet de
 * questlijst van de wiki en niet WikiSync, want die geven weergavenamen.
 *
 * De jar zit niet in deze repo; hij is een dependency van de plugin. Draai dit
 * script daarom met het pad naar `runelite-api-<versie>.jar` erbij, en commit
 * de uitvoer. Zelfde patroon als `build-landmarks.mjs`: de generator staat in
 * de repo zodat het opnieuw kan, de gegenereerde tabel staat erin zodat er
 * niets nodig is om te bouwen.
 *
 * Gebruik:
 *   node scripts/build-quests.mjs <pad naar runelite-api-x.y.z.jar>
 *
 * De jar staat op een machine met de plugin meestal in de Gradle-cache:
 *   ~/.gradle/caches/modules-2/files-2.1/net.runelite/runelite-api/<versie>/*\/runelite-api-<versie>.jar
 *
 * `javap` komt uit de JDK die de plugin ook bouwt (Temurin 11 volstaat).
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { basename } from "node:path";

const jar = process.argv[2];
if (jar === undefined) {
  console.error("Geef het pad naar runelite-api-<versie>.jar mee.");
  process.exit(1);
}

const version = basename(jar).replace(/^runelite-api-/, "").replace(/\.jar$/, "");

const output = execFileSync("javap", ["-cp", jar, "net.runelite.api.Quest"], {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});

// De enumconstanten zijn de `public static final Quest <NAAM>;`-velden. De
// enum heeft daarnaast gewone methodes; die matchen niet omdat er haakjes
// achter staan.
const quests = [
  ...new Set(
    [...output.matchAll(/\bQuest\s+([A-Z][A-Z0-9_]*);/g)].map((match) => match[1]),
  ),
].sort();

if (quests.length < 100) {
  console.error(
    `Slechts ${quests.length} quests gevonden — dat klopt niet. Wijst het pad naar de ` +
      "juiste jar, en is het `runelite-api` en niet `client`?",
  );
  process.exit(1);
}

const lines = [
  "/**",
  " * De constanten van RuneLite's `Quest`-enum.",
  " *",
  " * GEGENEREERD BESTAND — niet met de hand aanpassen.",
  ` * Bron: runelite-api ${version}, uitgelezen door \`scripts/build-quests.mjs\`.`,
  " *",
  " * Dit is een momentopname. Voegt Jagex een quest toe en bouwt de plugin tegen een",
  " * nieuwere RuneLite, dan kent de plugin een constante die hier nog niet staat en",
  " * weigert `set_step` een conditie die op zichzelf klopt. Regenereer dan deze tabel",
  " * tegen dezelfde jar-versie als de plugin gebruikt.",
  " */",
  "",
  `export const QUEST_NAMES = new Set<string>([`,
  ...quests.map((quest) => `  ${JSON.stringify(quest)},`),
  "]);",
  "",
  `/** De versie waartegen deze lijst is gegenereerd, voor in foutmeldingen. */`,
  `export const QUEST_SOURCE_VERSION = ${JSON.stringify(version)};`,
  "",
];

writeFileSync(new URL("../src/questdata.ts", import.meta.url), lines.join("\n"), "utf8");
console.log(`${quests.length} quests weggeschreven naar src/questdata.ts (runelite-api ${version}).`);
