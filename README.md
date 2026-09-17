# OSRS MCP

MCP-server die Claude toegang geeft tot mijn Old School RuneScape-account. Leest
lokale data die de RuneLite-plugin ["OSRS Item Check"](../OSRS%20item%20check)
wegschrijft, en combineert die later met de OSRS Hiscores, WikiSync en de
OSRS Wiki API.

Documentatie, tickets en werklogs staan in de Obsidian-vault onder
`20 Projects/OSRS MCP server/`.

## Stack

- Node + TypeScript, officiële `@modelcontextprotocol/sdk`
- stdio-transport (lokale server, geen netwerkpoort)

## Installeren

```
npm install
```

## Bouwen en starten

```
npm run build   # TypeScript -> dist/
npm start       # start de server op stdio
```

Een MCP-server op stdio praat via stdin/stdout. Handmatig starten in een
terminal levert dus geen zichtbare uitvoer op behalve de logregel op stderr —
dat is normaal. De server is bedoeld om door een client gestart te worden.

Tijdens ontwikkelen kan het ook zonder buildstap (Node draait TypeScript direct):

```
npm run dev
```

## Testen met de MCP-inspector

```
npm run build
npm run inspect
```

De inspector opent in de browser. Onder **Tools** staat `ping`; die geeft
`pong — <servertijd>` terug.

## Beschikbare tools

| Tool         | Argumenten                | Beschrijving                                              |
| ------------ | ------------------------- | --------------------------------------------------------- |
| `ping`       | —                         | Bereikbaarheidstest; geeft de servertijd (ISO 8601).       |
| `get_skills` | `username`, `accountType` | Level, XP en rank per skill uit de OSRS Hiscores.          |
| `get_quests` | `username`, `filter`      | Status per quest (niet gestart / bezig / afgerond) via WikiSync. |

`accountType` is optioneel en is er een van `normal` (standaard), `ironman`,
`hardcore_ironman`, `ultimate_ironman`, `group_ironman` of
`hardcore_group_ironman`.

Drie dingen om te weten bij `get_skills`:

- **Gebruik de character name, niet de naam van het Jagex-account.** De hiscores
  kennen `Mr Bilel`, niet `Dagrev#2898`.
- **De hiscores lopen achter op het spel.** Ze verversen niet real-time, dus een
  net behaald level kan ontbreken.
- **Een `-1` in de API betekent "niet op de hiscores", niet "level 0".** De tool
  geeft daar een streepje of "niet gerangschikt" voor terug.

### Group Ironman

Group Ironman heeft geen eigen `index_lite`-tabel — geverifieerd tegen de live
API: elke plausibele padnaam geeft een 303-redirect, dezelfde respons als een
verzonnen pad (een bestaand pad met een onbekende speler geeft 404). GIM-accounts
staan wél in de normale tabel, want die bevat alle accounttypes.

`group_ironman` en `hardcore_group_ironman` lezen daarom de normale tabel. Dat is
er als eigen optie in gelaten omdat "ik ben een group ironman, dus `ironman`"
anders een 404 oplevert; nu krijg je het goede antwoord plus een regel die
uitlegt dat de rank tussen álle spelers is, niet binnen de group-ironmen.

De skillvolgorde staat hardgecodeerd in `SKILL_ORDER` in `src/hiscores.ts` — de
hiscores geven geen kolomnamen mee, dus de volgorde ís de identificatie. Nieuwe
skills komen altijd achteraan erbij (zo is Sailing op index 24 gekomen). Komt er
een skill bij die de server nog niet kent, dan valt de parser daar niet over maar
zet er een placeholdernaam neer plus een waarschuwing in de uitvoer.

### Questvoortgang (WikiSync)

`get_quests` leest de publieke WikiSync-data van de OSRS Wiki. `filter` is
optioneel en is er een van `all` (standaard), `not_finished`, `in_progress`,
`not_started` of `finished`. De tellingen bovenaan de uitvoer gaan altijd over
alle quests, ook als er gefilterd wordt.

**Wat er aan RuneLite-kant nodig is**, anders is er niets op te halen:

1. Open in RuneLite de **Plugin Hub** (configuratiescherm → puzzelstukje onderaan).
2. Zoek op **WikiSync** en installeer die plugin.
3. Zet hem aan en laat de questoptie aanstaan (standaard aan).
4. **Log één keer in op het account op een gewone wereld.** De sync gebeurt bij
   het inloggen, niet bij het opstarten van de client.

Let op de volgorde in stap 3 en 4: installeer je WikiSync terwijl je al ingelogd
bent, dan is het inlogmoment al voorbij en wordt er niets verstuurd. In de
RuneLite-log is dat te zien als een `Loading external plugin "wikisync"`-regel
ná de regel waarin het accountprofiel wordt aangemaakt. Opnieuw inloggen lost het
op.

Is er nooit gesynchroniseerd, dan geeft de tool een melding met precies deze
stappen erin in plaats van een lege lijst.

Drie dingen om te weten:

- **Het is een momentopname, geen live data.** Je ziet de stand van de laatste
  keer dat er met WikiSync aan is ingelogd.
- **Hoe oud die momentopname is, valt niet te zien.** Het `timestamp`-veld in de
  respons is het moment van het antwoord, niet van de sync — nagemeten: twee
  opvragingen een seconde na elkaar geven twee verschillende, actuele tijden, en
  er komt geen `Last-Modified`-header mee.
- **Spaties tellen mee in de naam.** WikiSync matcht op de display name zelf,
  hoofdletterongevoelig, maar rekent een underscore niet als spatie zoals de
  hiscores dat doen. De tool zet underscores daarom om naar spaties. Spaties
  wéglaten doet hij bewust niet: `MrBilel` en `Mr Bilel` zijn twee verschillende
  accounts, dus "behulpzaam" normaliseren zou de data van een vreemde opleveren.
- **Er is geen accounttype-parameter.** Het pad eindigt op een *wereldtype*, en
  alleen `STANDARD` is opvraagbaar; `IRONMAN`, `GROUP_IRONMAN`, `DEADMAN` en
  `LEAGUE` geven allemaal HTTP 400 "Cannot query data for this world type".
  Ironmen en group-ironmen spelen op gewone werelden en zitten dus gewoon in
  `STANDARD` — geverifieerd tegen een ironman-account.

Naast de quests levert dezelfde respons achievement diaries, combat
achievements, muzieknummers en levels. Die worden samengevat onderaan de uitvoer
meegegeven omdat ze gratis meekomen; eigen tools ervoor zijn een apart ticket.

Het endpoint is `https://sync.runescape.wiki/runelite/player/<naam>/STANDARD`.
Dit is community-infrastructuur, geen officiële Jagex-API: het formaat kan
wijzigen. `src/wikisync.ts` parst daarom defensief — onbekende questwaarden
worden overgeslagen met een waarschuwing in de uitvoer in plaats van een crash.

Meer bronnen (wiki, lokale plugindata) volgen in ORS-007 en verder.
# OSRS-MCP
