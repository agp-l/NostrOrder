// js/database.js
//
// Bezpečnostní/audit poznámka (viz srovnání dvou verzí, které jsi poslal):
// Tahle verze (v4, composite keyPath ['ownerPubkey','id'] + samostatný owner_time_index)
// je jednoznačně lepší a novější než starší v3 (keyPath jen 'id', getLatestGlobalMessageTime
// řešený obchvatem přes '\x00'/'\uffff' hranice v chat_index). Důvody:
//   1) Compound keyPath ['ownerPubkey','id'] zabraňuje kolizi ID zprávy mezi více lokálními
//      účty ve stejné DB (v3 měla keyPath jen 'id' — riziko přepsání záznamu jiného účtu).
//   2) owner_time_index je čistý a rychlý dotaz na "poslední zprávu účtu" bez ošklivého
//      obchvatu přes umělé řetězcové hranice partnera.
//   3) tx.oncomplete (ne jen request.onsuccess) korektně signalizuje úspěch celé transakce.
//   4) _ensureIndex umožňuje bezpečně měnit schéma indexů napříč verzemi bez pádu upgradu.
// Jediná mezera, kterou v4 měla: `deleteChat` mazal jen z nového store, takže data
// zůstávala navždy v legacy store `messages` i po tom, co uživatel řekl "smaž historii".
// To je opraveno níže — deleteChat teď čistí oba store najednou, ve stejné transakci.
export class Database {
    constructor(dbName = 'NostrChatDB', version = 4) {
        this.dbName = dbName;
        this.version = version;
        this.storeName = 'messages_v4';
        this.legacyStoreName = 'messages';
        this.dbInstance = null;
    }

    _ensureIndex(store, name, keyPath) {
        if (store.indexNames.contains(name)) {
            const index = store.index(name);
            if (JSON.stringify(index.keyPath) === JSON.stringify(keyPath) && !index.unique) return;
            store.deleteIndex(name);
        }
        store.createIndex(name, keyPath, { unique: false });
    }

    _configureStore(store) {
        this._ensureIndex(store, 'chat_index', ['ownerPubkey', 'partnerPubkey', 'timestamp']);
        this._ensureIndex(store, 'owner_time_index', ['ownerPubkey', 'timestamp']);
    }

    async getDB() {
        if (this.dbInstance) return this.dbInstance;

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.version);

            request.onerror = (e) => reject(e.target.error);
            request.onblocked = () => reject(new Error('Databázi blokuje jiná otevřená karta aplikace.'));

            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                const tx = e.target.transaction;
                let store;

                if (!db.objectStoreNames.contains(this.storeName)) {
                    // Složený klíč zabraňuje kolizi stejného Nostr eventu mezi více lokálními účty.
                    store = db.createObjectStore(this.storeName, { keyPath: ['ownerPubkey', 'id'] });
                } else {
                    store = tx.objectStore(this.storeName);
                }
                this._configureStore(store);

                // Migrace z původního store `messages` bez jeho smazání.
                // Pokud migrace doběhne, data jsou dostupná v novém store; legacy store zůstane jako bezpečnostní záloha.
                if (db.objectStoreNames.contains(this.legacyStoreName)) {
                    const legacy = tx.objectStore(this.legacyStoreName);
                    const cursorRequest = legacy.openCursor();
                    cursorRequest.onsuccess = (cursorEvent) => {
                        const cursor = cursorEvent.target.result;
                        if (!cursor) return;
                        const value = cursor.value;
                        if (value?.ownerPubkey && value?.id) store.put(value);
                        cursor.continue();
                    };
                }
            };

            request.onsuccess = (e) => {
                this.dbInstance = e.target.result;
                this.dbInstance.onversionchange = () => {
                    this.dbInstance?.close();
                    this.dbInstance = null;
                };
                resolve(this.dbInstance);
            };
        });
    }

    async saveMessage(msgObj) {
        if (!msgObj?.ownerPubkey || !msgObj?.id) throw new Error('Zpráva nemá ownerPubkey nebo id.');
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readwrite');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error('Uložení zprávy selhalo.'));
            tx.onabort = () => reject(tx.error || new Error('Uložení zprávy bylo zrušeno.'));
            tx.objectStore(this.storeName).put(msgObj);
        });
    }

    async getMessages(ownerPubkey, partnerPubkey) {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readonly');
            const store = tx.objectStore(this.storeName);
            const index = store.index('chat_index');
            const range = IDBKeyRange.bound(
                [ownerPubkey, partnerPubkey, 0],
                [ownerPubkey, partnerPubkey, Number.MAX_SAFE_INTEGER]
            );
            const request = index.getAll(range);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async getLastMessageTime(ownerPubkey, partnerPubkey) {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readonly');
            const store = tx.objectStore(this.storeName);
            const index = store.index('chat_index');
            const range = IDBKeyRange.bound(
                [ownerPubkey, partnerPubkey, 0],
                [ownerPubkey, partnerPubkey, Number.MAX_SAFE_INTEGER]
            );
            const request = index.openCursor(range, 'prev');
            request.onsuccess = (e) => {
                const cursor = e.target.result;
                resolve(cursor ? cursor.value.timestamp : null);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async getLatestGlobalMessageTime(ownerPubkey) {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, 'readonly');
            const store = tx.objectStore(this.storeName);
            const index = store.index('owner_time_index');
            const range = IDBKeyRange.bound(
                [ownerPubkey, 0],
                [ownerPubkey, Number.MAX_SAFE_INTEGER]
            );
            const request = index.openCursor(range, 'prev');
            request.onsuccess = (e) => {
                const cursor = e.target.result;
                resolve(cursor ? cursor.value.timestamp : null);
            };
            request.onerror = () => reject(request.error);
        });
    }

    // 🔒 OPRAVA: mazání chatu teď likviduje záznamy jak v aktuálním store, tak (pokud
    // existuje) v legacy store `messages` — ve stejné transakci. Dřív mazání smazalo
    // jen "viditelnou" kopii dat a stejná historie zůstávala navždy dohledatelná
    // v původním store, takže tlačítko "Smazat historii" reálně nemazalo všechno.
    async deleteChat(ownerPubkey, partnerPubkey) {
        const db = await this.getDB();
        const storeNames = [this.storeName];
        if (db.objectStoreNames.contains(this.legacyStoreName)) storeNames.push(this.legacyStoreName);

        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeNames, 'readwrite');

            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error('Mazání chatu selhalo.'));
            tx.onabort = () => reject(tx.error || new Error('Mazání chatu bylo zrušeno.'));

            const purge = (store) => {
                if (!store.indexNames.contains('chat_index')) return;
                const index = store.index('chat_index');
                const range = IDBKeyRange.bound(
                    [ownerPubkey, partnerPubkey, 0],
                    [ownerPubkey, partnerPubkey, Number.MAX_SAFE_INTEGER]
                );
                const request = index.openCursor(range);
                request.onsuccess = (e) => {
                    const cursor = e.target.result;
                    if (!cursor) return;
                    cursor.delete();
                    cursor.continue();
                };
            };

            storeNames.forEach(name => purge(tx.objectStore(name)));
        });
    }

    async clearDatabase() {
        if (this.dbInstance) {
            this.dbInstance.close();
            this.dbInstance = null;
        }

        return new Promise((resolve, reject) => {
            const req = indexedDB.deleteDatabase(this.dbName);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error || new Error('Smazání databáze selhalo.'));
            req.onblocked = () => reject(new Error('Smazání databáze blokuje jiná otevřená karta aplikace.'));
        });
    }
}

export const db = new Database();
