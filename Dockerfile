# De server praat zelf alleen stdio. supergateway zet daar HTTP voor, net als bij
# de Obsidian-MCP in LXC 103. Zie README.md voor het deployen.
FROM node:22-alpine

# Vastgezette versie: supergateway zit in het protocolpad tussen Claude en deze
# server, dus een stille major upgrade bij het herbouwen van de image is precies
# wat je niet wil. 3.4.3 is de versie die ook in LXC 103 draait.
RUN npm install -g supergateway@3.4.3

WORKDIR /app

# Eerst alleen de manifesten, zodat de dependency-laag in de cache blijft zolang
# die niet wijzigen. `npm ci` en niet `npm install`: die volgt de lockfile exact.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

COPY healthcheck.sh ./
RUN chmod +x healthcheck.sh

ENV PORT=3000

# Sessieduur in milliseconden; zie `--stateful` hieronder. Een kwartier is ruim
# genoeg voor een gesprek met Claude en kort genoeg om processen op te ruimen.
ENV SESSION_TIMEOUT=900000

EXPOSE 3000

# stdout is het protocolkanaal van de server; supergateway leest dat en logt zelf
# naar stderr. Niets in deze image mag naar stdout van de serverprocessen praten.
#
# `--stateful` is niet optioneel. Zonder die vlag draait supergateway stateless
# en start het per request een eigen `node dist/index.js`, die daarna niet wordt
# opgeruimd: nagemeten liep de container in 21 requests naar 455 MiB van de
# 512 MiB en zou hij dus binnen een gesprek OOM-gekilled worden. Met `--stateful`
# hoort een sessie bij één proces, en `--sessionTimeout` ruimt die op.
CMD ["sh", "-c", "exec supergateway --stdio 'node /app/dist/index.js' --outputTransport streamableHttp --stateful --sessionTimeout \"$SESSION_TIMEOUT\" --port \"$PORT\""]
