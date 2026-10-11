Övervaka och styr ditt SAJ HS3-hembatteri lokalt via Modbus TCP – inget moln behövs.

Appen visar batteriets laddningsnivå, batterieffekt, om batteriet laddar, laddar ur eller vilar, driftläge, SOC-gränser, batteri- och växelriktartemperatur, totalt laddad och urladdad energi för Homey Energi samt växelriktarens status med felalarm.

Med flödeskort kan du reagera när batteriet börjar ladda eller ladda ur, eller när driftläget ändras. Med skrivåtkomst påslagen kan du ladda eller ladda ur med en vald effekt, pausa batteriet, släppa kontrollen, byta driftläge och sätta SOC-gränser.

Bra att veta innan du installerar:
- Appen ansluter till växelriktarens AIO3-modul (eller en Modbus TCP-omvandlare) på port 502. AIO3-modulen tar bara emot ett begränsat antal Modbus-klienter, så Homey och till exempel Home Assistant kan inte läsa samtidigt.
- Om Tibbers Smartstyrning är påslagen har Tibber företräde och kommandon från Homey ignoreras. Läsning fungerar alltid.
- Appen är skrivskyddad som standard. Slå på "Läs och skriv" i enhetens inställningar för att använda åtgärdskorten.

Det här är en community-app och har ingen koppling till SAJ. Testad på en SAJ HS3 på 12 kW; återkoppling från andra installationer tas gärna emot på GitHub.
