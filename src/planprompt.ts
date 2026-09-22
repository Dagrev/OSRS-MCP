/**
 * De MCP-prompt `plan_task` (ORS-026).
 *
 * Reist met de server mee, dus is in Claude Desktop, cowork en Claude Code hetzelfde
 * beschikbaar — dat is precies waar dit ticket vanaf wil: geen werkmap meer nodig om
 * consistent te plannen. De tekst hieronder is het "Instructie"-deel van
 * `20 Projects/OSRS stapcoach/Docs/Ontwerp/Planstandaard.md` in de vault, letterlijk
 * overgenomen (het document zegt zelf dat dat deel op één scherm past en de MCP-prompt
 * wordt). Wijzigt de standaard, dan wijzigt deze tekst mee — het is bewust geen losse
 * samenvatting.
 *
 * Vaste waarden (`{{player}}`/`{{accountType}}`) komen uit de omgeving, zodat de speler
 * ze nooit hoeft te typen — zelfde laag als `OSRS_MCP_DATA_DIR`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const PLAYER_ENV = "OSRS_MCP_PLAYER";
export const ACCOUNT_TYPE_ENV = "OSRS_MCP_ACCOUNT_TYPE";

const DEFAULT_PLAYER = "Mr Bilel";
const DEFAULT_ACCOUNT_TYPE = "group_ironman";

export const planPlayer = (): string => process.env[PLAYER_ENV]?.trim() || DEFAULT_PLAYER;
export const planAccountType = (): string =>
  process.env[ACCOUNT_TYPE_ENV]?.trim() || DEFAULT_ACCOUNT_TYPE;

/**
 * Het "Instructie"-deel van de planstandaard, met `{{player}}` en `{{accountType}}` nog
 * als placeholder. Losgehouden van `buildPlanInstruction` zodat de vervanging op één
 * plek gebeurt en niet per ongeluk twee keer met een andere waarde.
 */
const PLAN_INSTRUCTION_TEMPLATE = `Je plant een taak voor **{{player}}** ({{accountType}}). Volg deze volgorde.

**1. Kijk eerst, plan daarna.** Haal \`get_skills\`, \`get_bank\`, \`get_inventory\` en
\`get_equipment\` op vóór je een stap bedenkt. Vraagt een plek of methode een quest,
haal dan ook \`get_quests\` op. Verzin nooit een level, een bezit of een queststatus —
dat staat in de snapshot.

**2. Een plan is compleet, van begin tot eind.** Beschrijf het verloop zoals de speler
het doorloopt, in drie delen:

- **Voorbereiding:** bank, spullen, inventory leeg voor een verzameltaak. De conditie
  toetst het resultaat (de rommel is weg, het gereedschap is er).
- **De werkcyclus als herhaalblok** (\`type: "repeat"\`): doen tot de inventory vol is →
  wat er met de opbrengst gebeurt → terug. \`until\` is het doel, bijvoorbeeld
  \`skillLevel\` op de bovengrens. Zet \`maxRounds\` ruim boven wat je verwacht, als
  noodrem. Een skilldoel is altijd een cyclus; zelfs een Agility-rondje is een blok
  met één stap.
- **Afronding:** de laatste opbrengst wegzetten, geleende spullen terug.

**3. Kies wat er met de opbrengst gebeurt, en zeg het.** Bankieren, verbranden
(Firemaking), fletchen of droppen is een keuze die het plan maakt, niet een
vanzelfsprekendheid. Kies op wat de speler ermee wil en wat het account kan (een
tinderbox en het Firemaking-level, een knife en het Fletching-level), en noem de keuze
en de reden in je samenvatting. Twijfel je, vraag het vóór \`create_task\`.

**4. Per level-bereik een eigen blok** als de plek of het gereedschap verandert:
willows tot 60, daarna een ander blok bij de yews. Kies de beste plek en het beste
gereedschap **voor dit account** (uit de snapshot, niet in het algemeen).

**5. Elke stap:**

- **Instructie:** één handeling, gebiedende wijs, exacte namen. "Hak willows ten
  zuiden van de Draynor-bank tot je inventory vol is."
- **Conditie:** toetst het **resultaat**, nooit alleen de positie. "28 willow logs in
  inventory" voor de hakstap, "geen willow logs in inventory" (een \`not\`) voor de
  bankstap. Zie *Condities die te vroeg afgaan* hieronder.
- **Bestemming, altijd:** een coördinaat via \`find_destination\`, of van de wiki als de
  plek er niet in staat. In een cyclus hebben de doe-stap én de bankstap elk hun eigen
  coördinaat — de lijn wisselt per stap. Is een stap echt geen reis, zet dan
  \`destination: null\` met een korte \`noTravel\`-reden ("zelfde plek als vorige stap").
  Een lege bestemming zonder reden wordt geweigerd.

**6. Ironman-filter, altijd.** Geen Grand Exchange en geen trades buiten de groep.
Alles komt uit eigen verzamelen, skilling, quests of van een groepslid. Gedragen
gereedschap telt mee als bezit — toets het met \`any\` over \`container: "inventory"\` en
\`container: "equipment"\`, nooit \`inventory\` alleen. Een gedragen bijl laat 28 plekken
vrij voor de opbrengst, een bijl in de inventory 27.

**7. Geen conditie is een geldig antwoord.** Is een stap niet machinaal vast te
stellen — een gesprek met een NPC, een keuze in een menu — zet hem dan zonder
conditie. De stap gaat dan alleen handmatig door ("volgende stap" of skip). In een
herhaalblok betekent dat: elke ronde opnieuw een klik. Vermijd dat waar het kan.

**8. Na \`create_task\`:** laat de speler het plan in een paar regels zien — het doel,
de delen (voorbereiding, cyclus, afronding), de keuze voor de opbrengst en de eerste
stap. Laat waarschuwingen uit het antwoord van \`create_task\` zien. De rest
(voortgang, rondes, menu, hervatten) staat in de client; herhaal dat niet in de chat.`;

/** Vult `{{player}}` en `{{accountType}}` in met de huidige omgevingswaarden. */
export const buildPlanInstruction = (): string =>
  PLAN_INSTRUCTION_TEMPLATE.replace(/\{\{player\}\}/g, planPlayer()).replace(
    /\{\{accountType\}\}/g,
    planAccountType(),
  );

export const registerPlanPrompt = (server: McpServer): void => {
  server.registerPrompt(
    "plan_task",
    {
      title: "Een taak plannen",
      description:
        "De planstandaard: hoe je voor dit account een compleet plan opbouwt vóór je " +
        "create_task aanroept — eerst de snapshot bekijken, dan voorbereiding, de werkcyclus " +
        "als herhaalblok met een benoemde keuze voor de opbrengst, en afronding; condities op " +
        "het resultaat, een bestemming per stap en het ironman-filter. Vult accountnaam en " +
        "accounttype al in.",
      argsSchema: {
        goal: z
          .string()
          .trim()
          .min(1, "Geef een doel om te plannen.")
          .describe("Het doel in gewone taal, bijvoorbeeld 'Woodcutting van 40 naar 50'."),
      },
    },
    ({ goal }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `${buildPlanInstruction()}\n\n**Doel:** ${goal}`,
          },
        },
      ],
    }),
  );
};
