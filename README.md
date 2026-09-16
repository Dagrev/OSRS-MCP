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

| Tool         | Argumenten                     | Beschrijving                                         |
| ------------ | ------------------------------ | ---------------------------------------------------- |
| `ping`       | —                              | Bereikbaarheidstest; geeft de servertijd (ISO 8601). |
| `get_skills` | `username`, `accountType`      | Level, XP en rank per skill uit de OSRS Hiscores.    |

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

Meer bronnen (quests, wiki, lokale plugindata) volgen in ORS-006 en verder.
# OSRS-MCP
