// js/db.js

const DB_NAME = 'NostrChatDB';
// Zvyšujeme verzi na 3. Tím se stará databáze vymaže a vytvoří se nová
// s extrémně rychlým složeným indexem (Compound Index).
const DB_VERSION = 3; 
const STORE_NAME = 'messages';

let dbInstance = null; // Singleton pro udržení otevřeného spojení

// 1. Zajištění trvalého spojení s databází
async function getDB() {
  if (dbInstance) return dbInstance;
  
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = (e) => reject(e.target.error);
    
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      
      // Smazání staré pomalé tabulky, pokud existuje
      if (db.objectStoreNames.contains(STORE_NAME)) {
        db.deleteObjectStore(STORE_NAME);
      }
      
      // Vytvoření nové tabulky
      const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      
      // MAGIE: Složený index (Compound Index)
      // Tento index umí vyhledávat zprávy patřící konkrétnímu vlastníkovi s konkrétním partnerem
      // a ROVNOU je nativně řadí podle času.
      store.createIndex(
        'chat_index', 
        ['ownerPubkey', 'partnerPubkey', 'timestamp'], 
        { unique: false }
      );
    };
    
    request.onsuccess = (e) => {
      dbInstance = e.target.result;
      resolve(dbInstance);
    };
  });
}

// 2. Bezpečné uložení zprávy
export async function saveMessage(msgObj) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(msgObj);
    
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// 3. Extrémně rychlé načtení zpráv pomocí složeného indexu
export async function getMessages(ownerPubkey, partnerPubkey) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('chat_index');
    
    // Vyhledáme přesně ty zprávy, které odpovídají naší dvojici.
    // Tím, že do range dáváme nulu a nekonečno (Infinity), 
    // databáze nám je automaticky vrátí perfektně seřazené podle času vzniku.
    const range = IDBKeyRange.bound(
      [ownerPubkey, partnerPubkey, 0],
      [ownerPubkey, partnerPubkey, Infinity]
    );
    
    const request = index.getAll(range);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// 4. Paměťově nenáročné zjištění posledního času (Reverzní Kurzor)
export async function getLastMessageTime(ownerPubkey, partnerPubkey) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('chat_index');
    
    const range = IDBKeyRange.bound(
      [ownerPubkey, partnerPubkey, 0],
      [ownerPubkey, partnerPubkey, Infinity]
    );

    // Místo stahování celého pole otevřeme Kurzor (čtečku) v režimu 'prev' (pozpátku).
    // Prohlížeč sáhne rovnou na ÚPLNĚ POSLEDNÍ zprávu v indexu a okamžitě nám ji dá.
    const request = index.openCursor(range, 'prev');

    request.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        resolve(cursor.value.timestamp); // Máme výsledek v čase O(1)
      } else {
        resolve(null); // Žádné zprávy v chatu nejsou
      }
    };
    
    request.onerror = () => reject(request.error);
  });
}

// 5. Tvrdý reset
export async function clearDatabase() {
  dbInstance = null; // Musíme uvolnit staré spojení
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = resolve;
    req.onerror = reject;
  });
}