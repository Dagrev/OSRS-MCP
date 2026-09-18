# OSRS MCP

MCP-server die Claude toegang geeft tot mijn Old School RuneScape-account. Leest
lokale data die de RuneLite-plugin ["OSRS Item Check"](../OSRS%20item%20check)
wegschrijft, en combineert die later met de OSRS Hiscores, WikiSync en de
OSRS Wiki API.

Documentatie, tickets en werklogs staan in de Obsidian-vault onder
`20 Projects/OSRS MCP server/`.

## Stack

- Node + TypeScript, officiële `@modelcontextprotocol/sdk`
- stdio-transport; op de homelab zet [supergateway](https://github.com/supercorp-ai/supergateway)
  daar HTTP voor in een Docker-container (zie [Deployen](#deployen-op-de-homelab))

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

| Tool              | Argumenten                             | Beschrijving                                                     |
| ----------------- | -------------------------------------- | ---------------------------------------------------------------- |
| `ping`            | —                                      | Bereikbaarheidstest; geeft de servertijd (ISO 8601).             |
| `get_skills`      | `username`, `accountType`              | Level, XP en rank per skill uit de OSRS Hiscores.                |
| `get_quests`      | `username`, `filter`                   | Status per quest (niet gestart / bezig / afgerond) via WikiSync.  |
| `lookup_item`     | `name`                                 | Item-eigenschappen uit de OSRS Wiki: ID, waarde, bonussen.       |
| `lookup_monster`  | `name`                                 | Monster-stats uit de OSRS Wiki: combat, slayer, zwaktes.         |
| `get_drop_table`  | `monster`, `include_rare_drop_table`   | Drop table met de uitgerekende kans per kill.                    |
| `get_inventory`   | —                                      | Laatste inventory-snapshot van de RuneLite-plugin.               |
| `get_bank`        | —                                      | Laatste bank-snapshot van de RuneLite-plugin.                    |
| `check_materials` | `item`, `quantity`, `sources`, `username`, `accountType` | "Heb ik de materialen voor X?" — recept, bank/inventory en skills in één antwoord. |

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

### Lokale plugindata (bank en inventory)

`get_inventory` en `get_bank` lezen de JSON-snapshots die de RuneLite-plugin
["OSRS Item Check"](../OSRS%20item%20check) bij elke containerwijziging
wegschrijft. Welke map dat is, bepaalt de environment-variabele
`OSRS_MCP_DATA_DIR`; staat die niet, dan is het `~/.runelite/osrs-item-check/`
— hetzelfde standaardpad als in de pluginconfig, zodat het zonder instellen
werkt als de server op de spelmachine draait.

Het antwoord bevat altijd het tijdstempel uit de snapshot én de wijzigingstijd
van het bestand, zodat te zien is hoe oud de data is. Is de snapshot ouder dan
een kwartier, dan staat er een waarschuwing bij.

**Deze tools geven nooit een lege lijst bij een storing.** Dat onderscheid is de
kern ervan: een lege bank teruggeven bij een onbereikbare mount laat Claude
concluderen dat je niets hebt. Vijf uitkomsten, vijf boodschappen:

| Situatie                                     | Uitkomst                                      |
| -------------------------------------------- | --------------------------------------------- |
| Map bestaat niet, of geen leesrechten        | fout — bron niet te vinden / niet te lezen    |
| Map bestaat en is helemaal leeg              | fout — mount waarschijnlijk niet aangehaakt   |
| Map heeft inhoud, dit bestand niet           | fout — plugin heeft nog niet geschreven       |
| Bestand leeg of geen geldige snapshot        | fout — leesprobleem, probeer opnieuw          |
| Bestand gelezen, nul items                   | **geen fout** — de container is echt leeg     |

Alleen de laatste regel mag "leeg" zeggen. Een niet-aangehaakte netwerkmount
laat gewoon een lege map achter, dus "alles ontbreekt" en "dit ene bestand
ontbreekt" zijn expres verschillende meldingen.

De bank wordt door de plugin alleen herschreven als je hem in-game opent; die
snapshot is dus vaak dagen oud zonder dat er iets mis is.

### Bronnen combineren (`check_materials`)

`check_materials` beantwoordt "heb ik de materialen voor X?" door drie bronnen
naast elkaar te leggen: het recept van de wiki, de bank- en
inventory-snapshot van de plugin, en — als je `username` meegeeft — de
skill-levels uit de hiscores.

**De koppeling gaat op item-ID, niet op naam.** De plugin schrijft het ID op
dat het spel gebruikt; de wiki zet dezelfde ID's in `infobox_item`. Namen
lopen daar wél uit elkaar: van de 4.662 verhandelbare items in de spel-cache
hebben er 296 een andere naam in het spel dan op de wiki (nagemeten
2026-09-18), bijna altijd doordat het spel een achtervoegsel toevoegt dat de
wiki op de paginanaam zet in plaats van op de itemnaam — `Annakarl teleport
(tablet)` tegenover `Annakarl teleport`. Koppelen op naam zou daar op ruim
zes procent van de items misgaan.

Om dat op ID te kunnen doen wordt de hele item-tabel van de wiki één keer
opgehaald en in het geheugen gehouden: ongeveer 16.000 ID's in vier requests,
een dag geldig. Dat gebeurt lui — pas bij de eerste vraag die de index nodig
heeft, niet bij het starten. Per item bevragen kan niet: Bucket accepteert
maar één waarde per `where` en kent geen `orWhere`, dus een bank met
vierhonderd soorten zou vierhonderd requests kosten.

Drie dingen die de tool expliciet meldt in plaats van stilzwijgend af te
handelen:

- **Noted items.** De noted vorm heeft een eigen ID dat de wiki niet kent
  (die documenteert alleen de gewone vorm). Is het ID onbekend maar hoort
  `ID − 1` bij een item met exact dezelfde naam, dan is dit vrijwel zeker de
  noted vorm. Dat staat er dan bij; de naamgelijkheid is de controle.
- **Onkoppelbare regels.** Een ID dat de wiki niet kent en waarvan de naam
  ook nergens op past, wordt bij naam genoemd in het antwoord. Weglaten zou
  betekenen dat Claude met vertrouwen zegt dat je iets niet hebt.
- **Onleesbare bronnen.** Is de bank niet te lezen, dan komt elk materiaal
  dat niet gevonden is op *onbekend* te staan, niet op een tekort. Onzekerheid
  is hier geen "nee".

Gereedschap en faciliteiten (hamer, aambeeld, zaagmolen) worden genoemd maar
niet tegen de bank gelegd: een aambeeld ligt niet in je bank en een hamer kan
in je toolbelt zitten.

## Deployen op de homelab

De server draait als Docker-container in LXC 108 (`osrsmcp`,
`192.168.1.154`) op de Proxmox-host, bereikbaar op
`http://192.168.1.154:3000/mcp`. Alleen LAN, plain HTTP, geen authenticatie —
gelijk aan de Obsidian-MCP, en het zijn alleen leestools.

Intern blijft de server stdio; `supergateway` zet daar HTTP voor. Er staat geen
netwerkcode in `src/`.

De gateway draait **stateful**: één sessie hoort bij één serverproces, en
`SESSION_TIMEOUT` (compose, standaard 15 minuten) ruimt dat op na de laatste
request. Stateless start supergateway per request een eigen proces en ruimt het
niet op — nagemeten liep de container daarmee in 21 requests naar 455 MiB van de
512 MiB. Gevolg voor clients: na `initialize` moet de `mcp-session-id`-header
meegestuurd worden. Dat doet elke MCP-client volgens de spec; een handmatige
`curl` zonder die header krijgt terecht "No valid session ID provided".

### Eerste keer

```
ssh pve
pct enter 108
git clone https://github.com/Dagrev/OSRS-MCP.git /opt/osrs-mcp
cd /opt/osrs-mcp
docker compose up -d --build
```

De image bouwt de server zelf (`npm ci` + `npm run build`); er wordt nooit een
`dist/` van een desktop ingekopieerd.

### Nieuwe versie uitrollen

Push naar `main` en dan in LXC 108:

```
cd /opt/osrs-mcp
git pull
docker compose up -d --build
```

`--build` is niet optioneel: zonder die vlag hergebruikt compose de oude image
en verandert er niets, ook al is de code bijgewerkt.

### Controleren

```
docker compose ps          # moet "Up" en "healthy" zijn
docker compose logs -f     # supergateway en de server loggen naar stderr
```

De healthcheck doet een GET op `/mcp` en verwacht een 4xx. Dat lijkt vreemd maar
is opzet: `streamableHttp` staat alleen POST toe, dus een 405 is het bewijs dat
supergateway leeft en `/mcp` routeert. Een POST `initialize` zou meer bewijzen,
maar supergateway start per sessie een kindproces en een healthcheck sluit die
sessie nooit af — elke 30 seconden zou dat een lek zijn. Zie de toelichting in
`healthcheck.sh`.

### Lokaal blijven werken

De container verandert niets aan de lokale werkwijze: `npm start` (stdio) en
`npm run inspect` doen het onveranderd.

## Aansluiten op Claude

De server draait op de homelab, dus een client verbindt met een **HTTP-URL op
het LAN**, niet met een lokaal `node`-commando:

```
http://192.168.1.154:3000/mcp
```

Dat adres is machine-specifiek: het is het IP van LXC 108 en de poort uit
`docker-compose.yml`. Draait de container ergens anders, dan is dat het enige
dat verandert.

**Alleen op het thuisnetwerk.** Plain HTTP, geen authenticatie, geen poort open
naar buiten. De claude.ai-website en de mobiele app kunnen er dus niet bij — die
draaien bij Anthropic en zien `192.168.1.154` niet. Onderweg werkt het ook niet
zonder VPN naar huis.

### Claude Code

Claude Code kan zelf HTTP praten:

```
claude mcp add --scope user --transport http osrs-mcp http://192.168.1.154:3000/mcp
```

`--scope user` zet hem in `~/.claude.json` en maakt hem beschikbaar in elk
project; `--scope project` zou hem in een `.mcp.json` in de repo zetten. Daarna:

```
claude mcp list
```

Dit moet `osrs-mcp: ... (HTTP) - ✔ Connected` geven. Er is geen herstart nodig.

### Claude Desktop

Claude Desktop start MCP-servers als lokaal proces en kan zelf geen HTTP-URL
aan. `mcp-remote` overbrugt dat: dat is een stdio-server die het verkeer
doorzet naar de URL. Zelfde constructie als de Obsidian-MCP.

Het configuratiebestand staat per platform ergens anders:

| Platform | Pad |
| --- | --- |
| Linux | `~/.config/Claude/claude_desktop_config.json` |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

Voeg daar onder `mcpServers` toe:

```json
{
  "mcpServers": {
    "osrs-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://192.168.1.154:3000/mcp",
        "--transport",
        "http-only",
        "--allow-http"
      ]
    }
  }
}
```

`--allow-http` is nodig omdat het geen HTTPS is, en `--transport http-only`
houdt `mcp-remote` weg bij SSE — supergateway serveert alleen streamable HTTP.

**Claude Desktop herstarten** na het opslaan; hij leest de config alleen bij het
opstarten. Onder Linux en Windows is het venster sluiten niet genoeg als de app
naar het systeemvak minimaliseert — afsluiten via het tray-icoon.

Daarna staan de tools onder het gereedschapsicoon in het invoerveld. `ping` is
de goedkoopste test: die geeft de servertijd van de container terug.

### De RuneLite-kant

Twee van de tools (`get_inventory`, `get_bank`) en een deel van
`check_materials` leunen op de plugin
["OSRS Item Check"](../OSRS%20item%20check). Die staat niet op de Plugin Hub en
moet dus zelf draaien:

1. Bouw de plugin en start RuneLite ermee (`./gradlew run` in de plugin-repo),
   of zet de gebouwde jar in `~/.runelite/sideloaded-plugins/` en start
   RuneLite met `--developer-mode`.
2. Zet de plugin aan in het configuratiescherm.
3. Zet in de plugin-instellingen de **uitvoermap** op het NAS-pad, niet op het
   standaardpad. De server draait in de container en leest `/data`; alleen via
   de NAS-share zien die twee dezelfde bestanden. Op het standaardpad
   (`~/.runelite/osrs-item-check/`) schrijft de plugin naar de spelmachine en
   ziet de server niets.
4. Log in, en open één keer de bank — de bank-snapshot wordt alleen geschreven
   als je hem in-game opent.

Voor `get_quests` is daarnaast de WikiSync-plugin nodig, zie
[Questvoortgang](#questvoortgang-wikisync).

### Als het niet werkt

| Symptoom | Waarschijnlijke oorzaak |
| --- | --- |
| Client meldt de server als niet verbonden / niet bereikbaar | Je zit niet op het thuisnetwerk. Van buitenaf is `192.168.1.154` onbereikbaar; er is geen poort doorgezet. |
| Zelfde melding, maar je bent wel thuis | De container draait niet. `pct enter 108`, `cd /opt/osrs-mcp`, `docker compose ps` — moet "Up" en "healthy" zijn. |
| Alle tools werken, maar `get_bank` en `get_inventory` zeggen "bron niet te vinden" of "mount waarschijnlijk niet aangehaakt" | De NAS-share is niet gemount in LXC 108, of niet in de container. De tools zeggen dit expres in plaats van een lege bank terug te geven. |
| Bank en inventory bestaan wel, maar zijn van weken geleden | De plugin schrijft nog naar het oude lokale pad. Controleer de uitvoermap in de plugin-instellingen. |
| Bestanden ontbreken terwijl de map wel gevuld is | De plugin staat uit, of RuneLite draait zonder de plugin. |
| Bank is oud terwijl inventory actueel is | Geen storing: de bank wordt alleen bij het openen in-game herschreven. |
| `curl` geeft "No valid session ID provided" | Verwacht. De gateway draait stateful; na `initialize` hoort de `mcp-session-id`-header mee. Echte clients doen dat, handmatige `curl` niet. |
| Een tool die je verwacht ontbreekt in de lijst | De container draait een oudere versie. Uitrollen: `git pull` + `docker compose up -d --build` in LXC 108. |
