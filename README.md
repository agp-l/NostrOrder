# NostrOrder 🛡️

NostrOrder je plně decentralizovaná, webová chatovací aplikace postavená na protokolu Nostr. Zaměřuje se na absolutní soukromí, maximální bezpečnost a implementaci těch nejnovějších kryptografických standardů (NIPs) pro rok 2026.

Aplikace běží kompletně ve vašem prohlížeči. Žádné centrální servery, žádné ukládání dat třetí stranou, žádné kompromisy.

## ✨ Klíčové vlastnosti

* **Armádní úroveň šifrování (NIP-59 & NIP-44):** Využívá "Matrjoška" architekturu (Gift Wraps). Vaše zprávy, metadata i to, s kým si píšete, je dokonale skryto před zraky relay serverů.
* **Bezpečné přihlašování (NIP-07):** Podpora pro rozšíření v prohlížeči (např. Alby, nos2x). Váš privátní klíč (nsec) nikdy neopustí bezpečí vašeho trezoru a aplikace k němu nemá přístup.
* **Dynamické směrování zpráv (NIP-17):** Aplikace automaticky vyhledává osobní relaye vašich kontaktů a doručuje šifrované balíčky přímo do jejich preferovaných schránek (Outbox model).
* **Multi-Device Synchronizace:** Automatické zálohování odeslaných zpráv (Self-Sync), díky kterému máte historii kompletní na všech svých zařízeních.
* **Samočistící síť (NIP-40):** Zprávy jsou označeny tagem expirace. Relay servery je po 14 dnech automaticky smažou, čímž se šetří místo a zabraňuje se zahlcení sítě (vy je máte samozřejmě stažené lokálně).
* **Bleskurychlá lokální databáze:** Zprávy se ukládají přímo ve vašem prohlížeči pomocí `IndexedDB` s optimalizovanými složenými indexy pro okamžité načítání i při tisících zpráv.
* **100% ochrana proti XSS:** Veškerý uživatelský obsah je striktně escapován.

## 🛠️ Použité technologie

Aplikace je navržena s důrazem na minimalistickou a čistou architekturu. Nepoužívá žádné složité frameworky typu React nebo Vue, což z ní dělá ideální projekt pro audit a další komunitní vývoj.

* **Frontend:** Čisté HTML5, CSS3, Vanilla JavaScript (ES6 Modules)
* **Design:** Bootstrap 5 & Bootstrap Icons
* **Kryptografie:** [nostr-tools](https://github.com/nbd-wtf/nostr-tools) (v2.7.2) a `@noble/hashes`
* **Úložiště:** IndexedDB (Lokální offline databáze)

## 🚀 Jak aplikaci spustit

Vzhledem k tomu, že jde čistě o klientskou (frontendovou) aplikaci, nepotřebujete instalovat žádný backend, Node.js ani databázi.

### Lokální spuštění
1. Naklonujte si tento repozitář:
   ```bash
   git clone [https://github.com/agp-l/NostrOrder.git](https://github.com/agp-l/NostrOrder.git)
