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

**2. Vaste vorm per stap:** bank → benodigde spullen → plek → doen. De bankstap is
er bijna altijd: ook als het gereedschap al om hangt, moet de inventory leeg voor
een verzameltaak, en dat is een stap met een eigen conditie (de rommel is weg, het
gereedschap is er nog). Sla een schakel alleen over als hij echt niets doet (spullen
bij de hand én inventory al leeg, geen reis nodig), en noem hem nooit zonder hem uit
te voeren.

- **Instructie:** één handeling, gebiedende wijs, exacte namen. "Hak willows ten
  zuiden van Draynor tot je inventory vol is."
- **Conditie:** toetst het **resultaat**, nooit alleen de positie. "Aangekomen bij de
  bomen" is geen goede conditie voor een hakstap — "27 willow logs in inventory" wel.
  Vraag jezelf bij elke conditie af of hij ook waar zou zijn als de speler de
  handeling nog moet beginnen maar toevallig al op de goede plek staat — is het
  antwoord ja, dan toetst hij de positie in plaats van het resultaat, en moet hij
  anders.
- **Bestemming:** zoek de coördinaat met \`find_destination\`. Staat de plek er niet in
  (een specifieke boom, een mijningang), zoek hem dan op de wiki op of laat de
  bestemming weg en zeg dat in de instructie.

**3. Een skilldoel deel je op in level-bereiken.** Elk bereik krijgt een eigen stap:
de beste plek en het beste gereedschap **voor dit account** (uit de snapshot, niet in
het algemeen), met een \`skillLevel\`-conditie op de bovengrens van dat bereik.

**4. Ironman-filter, altijd.** Geen Grand Exchange en geen trades buiten de groep.
Alles komt uit eigen verzamelen, skilling, quests of van een groepslid. Gedragen
gereedschap telt mee als bezit — toets het met \`any\` over \`container: "inventory"\` en
\`container: "equipment"\`, nooit \`inventory\` alleen.

**5. Geen conditie is een geldig antwoord.** Is een stap niet machinaal vast te
stellen — een gesprek met een NPC, een keuze in een menu, "praat met de bankier" —
zet hem dan zonder conditie. De stap gaat dan alleen handmatig door ("volgende stap"
of skip), en dat is geen tekortkoming.

**6. Na \`create_task\`:** laat de speler het plan in een paar regels zien — het doel,
het aantal stappen, de eerste stap. De rest (voortgang, menu, hervatten) staat in de
client; herhaal dat niet in de chat.`;

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
        "De planstandaard: hoe je voor dit account een taak opbouwt vóór je create_task " +
        "aanroept — eerst de snapshot bekijken, de vaste vorm per stap, condities op het " +
        "resultaat in plaats van de positie, het ironman-filter en wanneer een stap geen " +
        "conditie mag hebben. Vult accountnaam en accounttype al in.",
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
