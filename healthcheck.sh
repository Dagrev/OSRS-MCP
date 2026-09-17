#!/bin/sh
# Healthcheck met een GET, bewust geen POST.
#
# Een POST `initialize` zou de hele keten bewijzen (HTTP -> supergateway ->
# stdio -> server), maar supergateway start per sessie een eigen kindproces en
# een healthcheck sluit die sessie nooit netjes af. Nagemeten in LXC 103: drie
# POSTs lieten zes processen achter, en die container stond op 125 opgebouwde
# processen. Elke 30 seconden een sessie openen is dus een lek.
#
# Een GET op /mcp geeft 405: streamableHttp staat alleen POST toe. Dat antwoord
# is genoeg bewijs dat supergateway leeft en /mcp routeert, en het kost geen
# sessie. Wat het níet bewijst is dat het stdio-proces achter de gateway
# gezond is; daarvoor is een echte clientaanroep nodig.
#
# 2xx wordt ook goedgekeurd: een latere supergateway kan GET gaan ondersteunen
# voor een SSE-stream. 5xx of geen antwoord is ongezond.
status=$(wget -S -q -O /dev/null "http://127.0.0.1:${PORT:-3000}/mcp" 2>&1 |
	awk '/^ *HTTP\//{print $2; exit}')

case "$status" in
2* | 4*)
	exit 0
	;;
*)
	echo "healthcheck: onverwacht antwoord van /mcp: ${status:-geen antwoord}"
	exit 1
	;;
esac
