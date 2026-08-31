// js/nostr.js
import { getPublicKey, finalizeEvent, generateSecretKey, getEventHash, nip04, nip44 } from 'https://cdn.jsdelivr.net/npm/nostr-tools@2.7.2/+esm';
import { hexToBytes } from 'https://cdn.jsdelivr.net/npm/@noble/hashes@1.3.0/utils/+esm';

const DEFAULT_RELAYS = [
  "wss://relay.damus.io", 
  "wss://nos.lol", 
  "wss://relay.nostr.band", 
  "wss://relay.primal.net"
];

// Načtení preferovaných serverů z paměti prohlížeče
export let RELAYS = JSON.parse(localStorage.getItem("my_nostr_relays")) || DEFAULT_RELAYS;

export function saveRelays(newRelaysArray) { 
  RELAYS = newRelaysArray; 
  localStorage.setItem("my_nostr_relays", JSON.stringify(RELAYS)); 
}

// -----------------------------------------------------------------
// GLOBÁLNÍ STAV (Předchází memory leakům a duplikacím)
// -----------------------------------------------------------------
const activeSockets = new Map(); 
const profileCallbacks = new Map(); 
const partnerRelaysCache = new Map(); // Zde se ukládají NIP-17 schránky přátel
const activeSubscriptions = new Map(); // Fronta dotazů pro Relay servery

let privateKeyBytes = null;
let publicKeyHex = null;
let isNip07 = false; 
let debugCallback = () => {};
let globalMessageCallback = () => {};

// ==========================================
// 1. INICIALIZACE A KLÍČE
// ==========================================
export async function initNostr(key, useNip07, onDebug) {
  if (onDebug) {
    debugCallback = onDebug;
  }
  
  isNip07 = useNip07;
  
  if (isNip07) {
    publicKeyHex = key; // Při NIP-07 nám klíč dává přímo rozšíření (např. Alby)
    debugCallback('INFO', '✅ Nostr inicializován přes bezpečné rozšíření (NIP-07).');
  } else {
    privateKeyBytes = hexToBytes(key);
    publicKeyHex = getPublicKey(privateKeyBytes);
    debugCallback('INFO', '✅ Nostr inicializován z lokálního klíče.');
  }
}

export function getMyPublicKey() { 
  return publicKeyHex; 
}

// ==========================================
// 2. SPRÁVA WEBSOCKETŮ A RECONNECT LOGIKA
// ==========================================
function ensureConnections() {
  RELAYS.forEach(url => {
    // Pokud už spojení existuje a funguje, nevytváříme nové (brání memory leaku)
    if (activeSockets.has(url)) {
      const state = activeSockets.get(url).readyState;
      if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) {
        return;
      }
    }
    
    const ws = new WebSocket(url);
    activeSockets.set(url, ws);

    ws.onopen = () => {
      debugCallback('INFO', `Připojeno k ${url}`);
      // Jakmile se spojení otevře, serveru nasypeme všechny požadavky z fronty
      activeSubscriptions.forEach(reqMsg => {
        ws.send(reqMsg); 
      });
    };
    
    ws.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);
        
        if (data[0] === "EVENT") {
          const subId = data[1];
          const ev = data[2];

          // A) Zpracování požadavků na profily (Kind 0) a Relaye kontaktů (Kind 10050, 10002)
          if (subId.startsWith("profiles-sync-")) {
            if (ev.kind === 0 && profileCallbacks.has(subId)) {
              profileCallbacks.get(subId)(ev.pubkey, JSON.parse(ev.content));
            } else if (ev.kind === 10050 || ev.kind === 10002) {
              if (!partnerRelaysCache.has(ev.pubkey)) {
                partnerRelaysCache.set(ev.pubkey, new Set());
              }
              // NIP-17: Vyhledání doručovacích adres
              ev.tags.forEach(t => {
                if ((t[0] === 'relay' || t[0] === 'r') && t[1]) {
                  // Ignorujeme servery, kam partner jen zapisuje (write), ale nečte z nich
                  if (ev.kind === 10002 && t[2] === 'write') return; 
                  partnerRelaysCache.get(ev.pubkey).add(t[1]);
                }
              });
            }
            return;
          }
          
          // B) Stažení mého vlastního profilu (pokud ho zachytí Global Sync)
          if (ev.kind === 0 && ev.pubkey === publicKeyHex) {
             globalMessageCallback({ type: 'profile', data: JSON.parse(ev.content) });
             return;
          }
          
          // C) Zpracování soukromých zpráv z Globální synchronizace
          if (subId === "global-sync") {
            const msgObj = await processIncomingEvent(ev);
            if (msgObj) {
              globalMessageCallback({ type: 'message', data: msgObj });
            }
          }
        }
      } catch (e) {
        // Ignorujeme poškozené packety, ať nám nespadne aplikace
      } 
    };
    
    ws.onclose = () => { 
      activeSockets.delete(url); 
      // Automatický reconnect při ztrátě signálu
      setTimeout(() => {
        ensureConnections();
      }, 5000); 
    };
    
    ws.onerror = () => {
      // Zpracováno skrze onclose
    };
  });
}

// ==========================================
// 3. START GLOBÁLNÍ SYNCHRONIZACE
// ==========================================
export function startGlobalSync(lastTimestamp, onMessageReceived) {
  globalMessageCallback = onMessageReceived; 
  
  // Stahujeme náš profil a všechny typy šifrovaných zpráv
  const filter1 = { kinds: [0, 4, 1059], authors: [publicKeyHex], limit: 200 };
  const filter2 = { kinds: [0, 4, 1059], '#p': [publicKeyHex], limit: 200 };
  
  if (lastTimestamp) {
    const dny = 14 * 24 * 60 * 60;
    filter1.since = lastTimestamp - dny; 
    filter2.since = lastTimestamp - dny;
  }
  
  const reqMsg = JSON.stringify(["REQ", "global-sync", filter1, filter2]);
  activeSubscriptions.set("global-sync", reqMsg); 
  
  ensureConnections();
  
  activeSockets.forEach(ws => { 
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(reqMsg); 
    }
  });
}

// ==========================================
// 4. DEŠIFROVÁNÍ (NIP-04 a NIP-59 Matrjoška)
// ==========================================
async function processIncomingEvent(ev) {
  // --- ZASTARALÝ STANDARD NIP-04 ---
  if (ev.kind === 4) {
    const isMe = ev.pubkey === publicKeyHex;
    const pTag = ev.tags.find(t => t[0] === 'p');
    // Zjistíme, kdo je náš partner v konverzaci
    const partner = isMe ? (pTag ? pTag[1] : null) : ev.pubkey;
    
    if (!partner) return null;

    try {
      let text;
      // Dekódování se liší podle toho, zda používáme rozšíření nebo lokální klíč
      if (isNip07) {
        text = await window.nostr.nip04.decrypt(partner, ev.content);
      } else {
        text = await nip04.decrypt(privateKeyBytes, partner, ev.content);
      }
        
      return { 
        id: ev.id, 
        text: text, 
        isMe: isMe, 
        timestamp: ev.created_at, 
        partnerPubkey: partner, 
        ownerPubkey: publicKeyHex 
      };
    } catch (e) {
      return null; // Zpráva nebyla pro nás
    }
  }
  
  // --- MODERNÍ STANDARD NIP-59 (Gift Wraps) ---
  if (ev.kind === 1059) {
    try {
      let sealJson;
      // 1. Odemčení vnějšího obalu
      if (isNip07) {
        sealJson = await window.nostr.nip44.decrypt(ev.pubkey, ev.content);
      } else {
        const outerKey = nip44.getConversationKey(privateKeyBytes, ev.pubkey);
        sealJson = nip44.decrypt(ev.content, outerKey);
      }
      
      const sealEvent = JSON.parse(sealJson);

      if (sealEvent.kind === 13) {
        const realSenderPubkey = sealEvent.pubkey; 
        let gossipJson;
        
        // 2. Odemčení vnitřní pečeti
        if (isNip07) {
          gossipJson = await window.nostr.nip44.decrypt(realSenderPubkey, sealEvent.content);
        } else {
          const innerKey = nip44.getConversationKey(privateKeyBytes, realSenderPubkey);
          gossipJson = nip44.decrypt(sealEvent.content, innerKey); 
        }
        
        const gossipEvent = JSON.parse(gossipJson); 

        // 3. Zpracování odhaleného jádra (Gossip)
        if (gossipEvent.kind === 14) {
          const isMe = realSenderPubkey === publicKeyHex;
          const pTag = gossipEvent.tags.find(t => t[0] === 'p');
          const receiverPubKey = pTag ? pTag[1] : null;
          
          // Partnerem je ten druhý člověk (ať už příjemce, nebo odesílatel)
          const partner = isMe ? receiverPubKey : realSenderPubkey;
          
          if (!partner) return null;

          return { 
            id: gossipEvent.id, // ❗️ Vracíme ID vnitřní zprávy, zásadní pro zabránění duplikacím!
            text: gossipEvent.content, 
            isMe: isMe, 
            timestamp: gossipEvent.created_at, 
            partnerPubkey: partner, 
            ownerPubkey: publicKeyHex 
          };
        }
      }
    } catch (e) {
      return null; // Tichý fail, pokud balíček nešel odemknout (není pro nás)
    }
  }
  return null;
}

// ==========================================
// 5. ODESÍLÁNÍ ZPRÁV A NIP-17 SMĚROVÁNÍ
// ==========================================
export async function sendNip59Message(text, partnerHex) {
  const now = Math.floor(Date.now() / 1000);
  
  // ❗️ Vnitřní jádro zprávy. Stejné pro oba balíčky (pro nás i pro partnera)
  const gossipTemplate = { 
    kind: 14, 
    pubkey: publicKeyHex, 
    created_at: now, 
    tags: [
      ["p", partnerHex], 
      ["nonce", Math.random().toString()] // Znemožní odhalení zprávy podle hashe
    ], 
    content: text 
  };
  
  const gossipEvent = { 
    ...gossipTemplate, 
    id: getEventHash(gossipTemplate), 
    sig: "" 
  };
  
  // NIP-40: Pokyn serveru k promazání staré zátěže (14 dní)
  const expirationTime = (now + (14 * 24 * 60 * 60)).toString(); 
  
  // --------------------------------------------------
  // A) BALÍČEK 1: Určený pro partnera
  // --------------------------------------------------
  let sealContent, sealEvent;
  if (isNip07) {
    sealContent = await window.nostr.nip44.encrypt(partnerHex, JSON.stringify(gossipEvent));
    sealEvent = await window.nostr.signEvent({ 
      kind: 13, 
      created_at: now - Math.floor(Math.random() * 3600), // Obfuskace času pro vyšší soukromí
      tags: [], 
      content: sealContent, 
      pubkey: publicKeyHex 
    });
  } else {
    const innerKey = nip44.getConversationKey(privateKeyBytes, partnerHex);
    sealContent = nip44.encrypt(JSON.stringify(gossipEvent), innerKey);
    sealEvent = finalizeEvent({ 
      kind: 13, 
      created_at: now - Math.floor(Math.random() * 3600), 
      tags: [], 
      content: sealContent 
    }, privateKeyBytes);
  }

  const ephemeralPriv = generateSecretKey(); 
  const outerKey = nip44.getConversationKey(ephemeralPriv, partnerHex);
  const wrapContent = nip44.encrypt(JSON.stringify(sealEvent), outerKey);
  
  const wrapEvent = finalizeEvent({ 
    kind: 1059, 
    created_at: now, 
    tags: [
      ["p", partnerHex], 
      ["expiration", expirationTime]
    ], 
    content: wrapContent 
  }, ephemeralPriv);
  
  const eventMsgString = JSON.stringify(["EVENT", wrapEvent]);

  // --------------------------------------------------
  // B) BALÍČEK 2: Určený pro mě (Záloha pro ostatní má zařízení)
  // --------------------------------------------------
  let sealContentMe, sealEventMe;
  if (isNip07) {
    sealContentMe = await window.nostr.nip44.encrypt(publicKeyHex, JSON.stringify(gossipEvent));
    sealEventMe = await window.nostr.signEvent({ 
      kind: 13, 
      created_at: now - Math.floor(Math.random() * 3600), 
      tags: [], 
      content: sealContentMe, 
      pubkey: publicKeyHex 
    });
  } else {
    const innerKeyMe = nip44.getConversationKey(privateKeyBytes, publicKeyHex);
    sealContentMe = nip44.encrypt(JSON.stringify(gossipEvent), innerKeyMe);
    sealEventMe = finalizeEvent({ 
      kind: 13, 
      created_at: now - Math.floor(Math.random() * 3600), 
      tags: [], 
      content: sealContentMe 
    }, privateKeyBytes);
  }
  
  const ephemeralPrivMe = generateSecretKey();
  const outerKeyMe = nip44.getConversationKey(ephemeralPrivMe, publicKeyHex);
  const wrapContentMe = nip44.encrypt(JSON.stringify(sealEventMe), outerKeyMe);
  
  const wrapEventMe = finalizeEvent({ 
    kind: 1059, 
    created_at: now, 
    tags: [
      ["p", publicKeyHex], 
      ["expiration", expirationTime]
    ], 
    content: wrapContentMe 
  }, ephemeralPrivMe);
  
  const eventMsgStringMe = JSON.stringify(["EVENT", wrapEventMe]);

  // --------------------------------------------------
  // C) DISTRIBUCE DO SÍTĚ
  // --------------------------------------------------
  // 1. Rozeslání na moje běžné relaye (obě zprávy)
  activeSockets.forEach(ws => { 
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(eventMsgString); 
      ws.send(eventMsgStringMe); 
    }
  });

  // 2. NIP-17: Expresní doručení na osobní relaye partnera (Zajistí rychlé doručení)
  if (partnerRelaysCache.has(partnerHex)) {
    partnerRelaysCache.get(partnerHex).forEach(url => {
      // Pokud už k serveru připojeni jsme, zprávu odeslal kód výše
      if (activeSockets.has(url)) {
        return; 
      }
      try {
        const tempWs = new WebSocket(url);
        tempWs.onopen = () => { 
          tempWs.send(eventMsgString); 
          setTimeout(() => tempWs.close(), 3000); // Slušné odpojení
        };
        tempWs.onerror = () => {};
      } catch (e) {}
    });
  }
  
  debugCallback('SUCCESS', "📤 Odeslána NIP-59 zpráva včetně self-sync zálohy.");
  
  return { 
    id: gossipEvent.id, 
    text: text, 
    isMe: true, 
    timestamp: now, 
    partnerPubkey: partnerHex, 
    ownerPubkey: publicKeyHex 
  };
}

// ==========================================
// 6. PUBLIKOVÁNÍ METADAT A PROFILŮ
// ==========================================
export async function publishProfile(name, about, picture) {
  const now = Math.floor(Date.now() / 1000);
  const content = JSON.stringify({ name, about, picture });
  let ev;
  
  if (isNip07) {
    ev = await window.nostr.signEvent({ 
      kind: 0, 
      created_at: now, 
      tags: [], 
      content, 
      pubkey: publicKeyHex 
    });
  } else {
    ev = finalizeEvent({ 
      kind: 0, 
      created_at: now, 
      tags: [], 
      content 
    }, privateKeyBytes);
  }

  activeSockets.forEach(ws => { 
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(["EVENT", ev])); 
    }
  });
}

export async function publishRelayLists() {
  const now = Math.floor(Date.now() / 1000);
  let ev10002, ev10050;

  if (isNip07) {
    ev10002 = await window.nostr.signEvent({ 
      kind: 10002, 
      created_at: now, 
      tags: RELAYS.map(url => ["r", url]), 
      content: "", 
      pubkey: publicKeyHex 
    });
    
    ev10050 = await window.nostr.signEvent({ 
      kind: 10050, 
      created_at: now, 
      tags: RELAYS.map(url => ["relay", url]), 
      content: "", 
      pubkey: publicKeyHex 
    });
  } else {
    ev10002 = finalizeEvent({ 
      kind: 10002, 
      created_at: now, 
      tags: RELAYS.map(url => ["r", url]), 
      content: "" 
    }, privateKeyBytes);
    
    ev10050 = finalizeEvent({ 
      kind: 10050, 
      created_at: now, 
      tags: RELAYS.map(url => ["relay", url]), 
      content: "" 
    }, privateKeyBytes);
  }

  activeSockets.forEach(ws => { 
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(["EVENT", ev10002])); 
      ws.send(JSON.stringify(["EVENT", ev10050])); 
    }
  });
}

// ==========================================
// 7. BEZPEČNÉ STAHOVÁNÍ DAT KONTAKTŮ
// ==========================================
export function fetchProfiles(pubkeysHex, callback) {
  if (!pubkeysHex || pubkeysHex.length === 0) {
    return;
  }
  
  // Unikátní ID, ať nezasahujeme do ostatních dotazů
  const subId = "profiles-sync-" + Math.random().toString(36).substring(7);
  profileCallbacks.set(subId, callback);
  
  // Dotaz na Profil(0), Čtecí servery(10002), Doručovací servery(10050)
  const filter = { kinds: [0, 10002, 10050], authors: pubkeysHex };
  const reqMsg = JSON.stringify(["REQ", subId, filter]);
  
  activeSubscriptions.set(subId, reqMsg); 
  
  const closeMsg = JSON.stringify(["CLOSE", subId]);
  
  ensureConnections();
  
  activeSockets.forEach(ws => { 
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(reqMsg); 
    }
  });
  
  // Automatický úklid spojení po 10 vteřinách (Zabrání memory leaku!)
  setTimeout(() => {
    activeSubscriptions.delete(subId); 
    
    activeSockets.forEach(ws => { 
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(closeMsg); 
      }
    });
    
    profileCallbacks.delete(subId);
  }, 10000);
}