# NostrOrder

Česká webová aplikace pro soukromé konverzace přes Nostr. Běží jako statická stránka bez vlastního backendu: HTML, Bootstrap a JavaScript moduly.

## Používání

1. Přihlas se pomocí rozšíření NIP-07 s podporou NIP-44, vlož soukromý klíč nebo vytvoř nový účet.
2. Zálohuj svůj soukromý klíč. Ztracený klíč nelze obnovit.
3. V Nastavení → Relaye vyber servery a použij **Zveřejnit moje relaye**, aby kontakty našly tvoji schránku NIP-17. Rozšíření tě může požádat o podpis.
4. Přidej kontakt pomocí jeho `npub`. Pro příjem musí mít zveřejněný seznam relayů druhu 10050.
5. Enter odešle zprávu, Shift+Enter vloží nový řádek. Rozepsaný text se uchovává při přepínání kontaktů v aktuální relaci; po obnovení stránky se neobnovuje.

## Odesílání a historie

- Zpráva a její šifrované, podepsané obaly se uloží do IndexedDB **před publikováním**.
- Stav **Přijato relayem** se objeví až po potvrzení `OK=true` alespoň od jednoho relaye příjemce. Nepotvrzuje přečtení ani doručení do zařízení příjemce.
- Bez potvrzení zůstává zpráva v historii jako **Nepotvrzeno**. Tlačítko **Zkusit znovu** použije původní obaly a ID, takže nevytváří novou zprávu.
- Kopie pro vlastní zařízení se potvrzuje samostatně. Při jejím selhání je dostupné **Znovu synchronizovat**.
- Opakování funguje i po obnovení stránky, dokud má prohlížeč uložená data a nevypršela platnost obalů. Opakování není automatické.
- Historie se řadí podle času a ID, odstraňuje duplicity z více relayů a odděluje účty i kontakty.
- Přijaté zprávy používají NIP-44/NIP-59; aplikace kontroluje podpis obalu a pečeti, hash zprávy, shodu autora a účastníky konverzace. Starší zprávy NIP-04 lze číst. Skupinové konverzace tato aplikace nepodporuje.
- Časy pečetí i obalů jsou nezávisle posunuté až o dva dny do minulosti.

## Soukromí a omezení

Relay servery ukládají šifrované obaly a mohou vidět veřejné směrovací údaje. Aplikace neposkytuje absolutní anonymitu ani záruku doručení. DM obal odesílá pouze na relaye zveřejněné příjemcem v události 10050 (nejvýše 10 platných adres `wss:`). Relaye vyžadující NIP-42 autentizaci nejsou zatím podporované.

Obaly mají expiraci 14 dní; dodržení expirace závisí na serveru. Příjemce si může zprávu ponechat. **Smazat historii** odstraní místní záznamy včetně nepotvrzených zpráv, nikoli kopie na jiných zařízeních nebo serverech; při nové synchronizaci se historie může znovu načíst.

Trezor šifruje uložené soukromé klíče heslem, ne lokální historii zpráv. Bez nastaveného trezoru se lokální účty ukládají nešifrovaně. Aktivní lokální relace používá klíč v paměti a sessionStorage; zámek aplikace je vizuální překrytí, ne kryptografické uzamčení relace. Odhlášení relaci ukončí. Smazání dat prohlížeče odstraní místní historii i neodeslané zprávy.

Aplikace načítá připnuté verze nostr-tools 2.7.2 a @noble/hashes 1.3.0 z CDN. Zobrazení profilových obrázků může kontaktovat externí server.

## Lokální spuštění

```bash
git clone https://github.com/agp-l/NostrOrder.git
cd NostrOrder
python3 -m http.server 8080
```

Otevři `http://localhost:8080`. Nepoužívej `file://`; moduly vyžadují HTTP a kryptografie bezpečný kontext (localhost nebo HTTPS).

## Ověření změn

Node.js 22 nebo novější:

```bash
npm install --ignore-scripts
npm run check
npm test
npx playwright install chromium
npm run test:browser
```

Testy ověřují skutečné šifrování a dešifrování s připnutou knihovnou nostr-tools, podvržené zprávy, potvrzení relayů, výpadky, opakování, slučování IndexedDB záznamů a souběžné akce v chatu. Síťová část používá simulované relaye. Test pro Chromium navíc otevírá skutečnou stránku na mobilním a desktopovém rozměru a kontroluje víceřádkové psaní, odmítnutí zprávy, reload, opakování se stejnými ID a rozepsané texty. Externí síť je v testovacím prohlížeči blokovaná; stejné připnuté závislosti se pro test načtou místně. GitHub Actions spouští tuto sadu při pushi a pull requestu.

## Protokoly

- [NIP-01: události a potvrzení relayů](https://github.com/nostr-protocol/nips/blob/master/01.md)
- [NIP-17: soukromé zprávy a schránky](https://github.com/nostr-protocol/nips/blob/master/17.md)
- [NIP-44: šifrování](https://github.com/nostr-protocol/nips/blob/master/44.md)
- [NIP-59: gift wraps](https://github.com/nostr-protocol/nips/blob/master/59.md)
