/**
 * De user-agent voor elk uitgaand verzoek van deze server.
 *
 * De OSRS Wiki vraagt expliciet om een beschrijvende user-agent met een manier
 * om contact op te nemen; zonder die header riskeer je een blokkade. Dat is
 * geen optionele beleefdheid, dus het staat hier op één plek in plaats van per
 * module. De repo-URL is die contactmogelijkheid — op verzoek van de eigenaar
 * staat er geen e-mailadres in.
 *
 * De hiscores (Jagex) en WikiSync gebruiken dezelfde header. WikiSync loopt
 * via `sync.runescape.wiki`, dus dat is dezelfde partij als de wiki zelf.
 */
export const USER_AGENT = "osrs-mcp/0.1.0 (+https://github.com/Dagrev/OSRS-MCP)";
