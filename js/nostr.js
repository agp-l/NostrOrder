// js/nostr.js
import { getPublicKey, finalizeEvent, generateSecretKey, getEventHash, verifyEvent, nip04, nip44 } from 'https://cdn.jsdelivr.net/npm/nostr-tools@2.7.2/+esm';
import { hexToBytes, bytesToHex } from 'https://cdn.jsdelivr.net/npm/@noble/hashes@1.3.0/utils/+esm';
import { Utils } from './ui.js';

class NostrCrypto {
    static generateAccount() {
        const sk = generateSecretKey();
        return bytesToHex(sk);
    }

    static async signEvent(template, myPubkeyHex, myPrivBytes, isNip07) {
        if (isNip07) return await window.nostr.signEvent({ ...template, pubkey: myPubkeyHex });
        return finalizeEvent(template, myPrivBytes);
    }

    static async decryptEvent(ev, myPubkeyHex, myPrivBytes, isNip07) {
        if (ev.kind === 4) {
            const isMe = ev.pubkey === myPubkeyHex;
            const partner = isMe ? (ev.tags.find(t => t[0] === 'p')?.[1]) : ev.pubkey;
            if (!partner) return null;
            try {
                const text = isNip07 ? await window.nostr.nip04.decrypt(partner, ev.content) : await nip04.decrypt(myPrivBytes, partner, ev.content);
                return { id: ev.id, text, isMe, timestamp: ev.created_at, partnerPubkey: partner, ownerPubkey: myPubkeyHex };
            } catch (e) { return null; }
        }

        if (ev.kind === 1059) {
            try {
                const sealJson = isNip07 ? await window.nostr.nip44.decrypt(ev.pubkey, ev.content) : nip44.decrypt(ev.content, nip44.getConversationKey(myPrivBytes, ev.pubkey));
                const sealEvent = JSON.parse(sealJson);

                // 🔒 Ověření podpisu "seal" (kind 13). Sealuje ho odesílatel svým skutečným
                // klíčem, takže tady poznáme, jestli obsah opravdu pochází od pubkey,
                // za kterou se vydává, a nebyl cestou pozměněn.
                if (sealEvent.kind !== 13 || !verifyEvent(sealEvent)) return null;

                const gossipJson = isNip07 ? await window.nostr.nip44.decrypt(sealEvent.pubkey, sealEvent.content) : nip44.decrypt(sealEvent.content, nip44.getConversationKey(myPrivBytes, sealEvent.pubkey));
                const gossipEvent = JSON.parse(gossipJson);

                if (gossipEvent.kind === 14) {
                    // 🔒 Gossip (kind 14) je dle NIP-17 záměrně nepodepsaný, ale jeho `id`
                    // je pořád hash obsahu — dopočítáme ho a porovnáme, abychom odhalili
                    // jakoukoliv manipulaci s obsahem/časem zprávy po cestě.
                    const recomputedId = getEventHash({
                        kind: gossipEvent.kind,
                        pubkey: gossipEvent.pubkey,
                        created_at: gossipEvent.created_at,
                        tags: gossipEvent.tags,
                        content: gossipEvent.content
                    });
                    if (recomputedId !== gossipEvent.id) {
                        Utils.log('ERROR', '⚠️ Zahozena poškozená/neplatná zpráva (hash mismatch).');
                        return null;
                    }

                    const isMe = sealEvent.pubkey === myPubkeyHex;
                    const partner = isMe ? (gossipEvent.tags.find(t => t[0] === 'p')?.[1]) : sealEvent.pubkey;
                    if (!partner) return null;

                    // Ukládáme i wrapIds (ID vnějšího obalu, které znají servery).
                    return { id: gossipEvent.id, wrapIds: [ev.id], text: gossipEvent.content, isMe, timestamp: gossipEvent.created_at, partnerPubkey: partner, ownerPubkey: myPubkeyHex };
                }
            } catch (e) { return null; }
        }
        return null;
    }
}

class NostrNetwork {
    constructor() {
        this.sockets = new Map();
        this.subscriptions = new Map();
        this.partnerRelays = new Map();
    }

    cachePartnerRelay(pubkey, url) {
        if (!this.partnerRelays.has(pubkey)) this.partnerRelays.set(pubkey, new Set());
        this.partnerRelays.get(pubkey).add(url);
    }

    addSubscription(subId, filters) {
        const reqMsg = JSON.stringify(["REQ", subId, ...filters]);
        this.subscriptions.set(subId, reqMsg);
        this.sockets.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(reqMsg); });
    }

    removeSubscription(subId) {
        this.subscriptions.delete(subId);
        const closeMsg = JSON.stringify(["CLOSE", subId]);
        this.sockets.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(closeMsg); });
    }

    sendEvent(eventMsgString, targetPubkey = null) {
        this.sockets.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(eventMsgString); });
        
        if (targetPubkey && this.partnerRelays.has(targetPubkey)) {
            this.partnerRelays.get(targetPubkey).forEach(url => {
                if (this.sockets.has(url)) return;
                try {
                    const tempWs = new WebSocket(url);
                    tempWs.onopen = () => { tempWs.send(eventMsgString); setTimeout(() => tempWs.close(), 3000); };
                    tempWs.onerror = () => {};
                } catch(e) {}
            });
        }
    }

    ensureConnections(relaysArray, onEventData) {
        relaysArray.forEach(url => {
            if (this.sockets.has(url) && [WebSocket.OPEN, WebSocket.CONNECTING].includes(this.sockets.get(url).readyState)) return;
            
            const ws = new WebSocket(url);
            this.sockets.set(url, ws);

            ws.onopen = () => {
                Utils.log('INFO', `Připojeno k ${url}`);
                this.subscriptions.forEach(req => ws.send(req));
            };

            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data[0] === "EVENT") onEventData(data[1], data[2]);
                } catch(e) {}
            };

            ws.onclose = () => {
                this.sockets.delete(url);
                setTimeout(() => this.ensureConnections(relaysArray, onEventData), 5000);
            };
            ws.onerror = () => {};
        });
    }
}

export class NostrClient {
    constructor() {
        this.network = new NostrNetwork();
        this.privBytes = null;
        this.pubHex = null;
        this.isNip07 = false;
        this.onMessageCallback = () => {};
        this.profileCallbacks = new Map();
        
        const defaultRelays = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.nostr.band", "wss://relay.primal.net"];
        this.relays = JSON.parse(localStorage.getItem("my_nostr_relays")) || defaultRelays;
    }

    generateNewAccount() {
        return NostrCrypto.generateAccount();
    }

    async init(key, useNip07) {
        this.isNip07 = useNip07;
        if (useNip07) {
            this.pubHex = key;
            Utils.log('INFO', '✅ Nostr inicializován (NIP-07).');
        } else {
            this.privBytes = hexToBytes(key);
            this.pubHex = getPublicKey(this.privBytes);
            Utils.log('INFO', '✅ Nostr inicializován (Lokální klíč).');
        }
    }

    getPublicKeyHex() { return this.pubHex; }

    saveRelays(newRelays) {
        this.relays = newRelays;
        localStorage.setItem("my_nostr_relays", JSON.stringify(this.relays));
    }

    async handleNetworkEvent(subId, ev) {
        // 🔒 Ověření podpisu HNED na vstupu. Relay je nedůvěryhodný prostředník —
        // bez tohoto by se dal podvrhnout kind 0 (profil), kind 4/1059 (zprávy)
        // i kind 10002/10050 (relay listy) s cizí `pubkey`, ale bez platného podpisu.
        if (!verifyEvent(ev)) {
            Utils.log('ERROR', '⚠️ Odmítnuta událost s neplatným podpisem.', { id: ev.id, kind: ev.kind });
            return;
        }

        if (subId.startsWith("profiles-sync-")) {
            if (ev.kind === 0 && this.profileCallbacks.has(subId)) {
                this.profileCallbacks.get(subId)(ev.pubkey, JSON.parse(ev.content));
            } else if (ev.kind === 10050 || ev.kind === 10002) {
                ev.tags.forEach(t => {
                    if ((t[0] === 'relay' || t[0] === 'r') && t[1] && !(ev.kind === 10002 && t[2] === 'write')) {
                        this.network.cachePartnerRelay(ev.pubkey, t[1]);
                    }
                });
            }
            return;
        }

        if (ev.kind === 0 && ev.pubkey === this.pubHex) {
            this.onMessageCallback({ type: 'profile', data: JSON.parse(ev.content) });
            return;
        }

        if (subId === "global-sync") {
            const msgObj = await NostrCrypto.decryptEvent(ev, this.pubHex, this.privBytes, this.isNip07);
            if (msgObj) this.onMessageCallback({ type: 'message', data: msgObj });
        }
    }

    startGlobalSync(lastTimestamp, callback) {
        this.onMessageCallback = callback;
        const filter1 = { kinds: [0, 4, 1059], authors: [this.pubHex], limit: 200 };
        const filter2 = { kinds: [0, 4, 1059], '#p': [this.pubHex], limit: 200 };
        if (lastTimestamp) {
            const since = lastTimestamp - (14 * 24 * 60 * 60);
            filter1.since = since; filter2.since = since;
        }
        this.network.addSubscription("global-sync", [filter1, filter2]);
        this.network.ensureConnections(this.relays, (id, ev) => this.handleNetworkEvent(id, ev));
    }

    async sendNip59Message(text, partnerHex) {
        const now = Math.floor(Date.now() / 1000);
        // 🔒 Math.random() není kryptograficky bezpečný generátor — pro nonce používáme
        // crypto.getRandomValues (Web Crypto API), stejně jako pro IV/salt jinde v appce.
        const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
        const gossipTemplate = { kind: 14, pubkey: this.pubHex, created_at: now, tags: [["p", partnerHex], ["nonce", nonce]], content: text };
        const gossipEvent = { ...gossipTemplate, id: getEventHash(gossipTemplate), sig: "" };
        const expTime = (now + (14 * 24 * 60 * 60)).toString();

        const wrap = async (receiverHex) => {
            let sealContent = this.isNip07 ? await window.nostr.nip44.encrypt(receiverHex, JSON.stringify(gossipEvent)) : nip44.encrypt(JSON.stringify(gossipEvent), nip44.getConversationKey(this.privBytes, receiverHex));
            const sealEvent = await NostrCrypto.signEvent({ kind: 13, created_at: now - Math.floor(Math.random() * 3600), tags: [], content: sealContent }, this.pubHex, this.privBytes, this.isNip07);
            const ephemeralPriv = generateSecretKey();
            const wrapContent = nip44.encrypt(JSON.stringify(sealEvent), nip44.getConversationKey(ephemeralPriv, receiverHex));
            return finalizeEvent({ kind: 1059, created_at: now, tags: [["p", receiverHex], ["expiration", expTime]], content: wrapContent }, ephemeralPriv);
        };

        const partnerWrap = await wrap(partnerHex);
        const selfWrap = await wrap(this.pubHex);

        this.network.sendEvent(JSON.stringify(["EVENT", partnerWrap]), partnerHex);
        this.network.sendEvent(JSON.stringify(["EVENT", selfWrap]));

        Utils.log('SUCCESS', "📤 Odesláno (NIP-59).");
        
        // Vracíme i wrapIds obou obalů do databáze
        return { id: gossipEvent.id, wrapIds: [partnerWrap.id, selfWrap.id], text, isMe: true, timestamp: now, partnerPubkey: partnerHex, ownerPubkey: this.pubHex };
    }

    async publishProfile(name, about, picture) {
        const now = Math.floor(Date.now() / 1000);
        const ev = await NostrCrypto.signEvent({ kind: 0, created_at: now, tags: [], content: JSON.stringify({ name, about, picture }) }, this.pubHex, this.privBytes, this.isNip07);
        this.network.sendEvent(JSON.stringify(["EVENT", ev]));
    }

    async publishRelayLists() {
        const now = Math.floor(Date.now() / 1000);
        const ev10002 = await NostrCrypto.signEvent({ kind: 10002, created_at: now, tags: this.relays.map(url => ["r", url]), content: "" }, this.pubHex, this.privBytes, this.isNip07);
        const ev10050 = await NostrCrypto.signEvent({ kind: 10050, created_at: now, tags: this.relays.map(url => ["relay", url]), content: "" }, this.pubHex, this.privBytes, this.isNip07);
        this.network.sendEvent(JSON.stringify(["EVENT", ev10002]));
        this.network.sendEvent(JSON.stringify(["EVENT", ev10050]));
    }

    fetchProfiles(pubkeysHex, callback) {
        if (!pubkeysHex || pubkeysHex.length === 0) return;
        const subId = "profiles-sync-" + Math.random().toString(36).substring(7);
        this.profileCallbacks.set(subId, callback);
        this.network.addSubscription(subId, [{ kinds: [0, 10002, 10050], authors: pubkeysHex }]);
        this.network.ensureConnections(this.relays, (id, ev) => this.handleNetworkEvent(id, ev));
        setTimeout(() => { this.network.removeSubscription(subId); this.profileCallbacks.delete(subId); }, 10000);
    }

    async deleteEventsFromNetwork(eventIds) {
        if (!eventIds || eventIds.length === 0) return;
        const now = Math.floor(Date.now() / 1000);
        const ev = await NostrCrypto.signEvent({ kind: 5, created_at: now, tags: eventIds.map(id => ["e", id]), content: "Smazáno uživatelem" }, this.pubHex, this.privBytes, this.isNip07);
        this.network.sendEvent(JSON.stringify(["EVENT", ev]));
        Utils.log('INFO', `🗑️ Požadavek na smazání ${eventIds.length} zpráv (NIP-09) odeslán.`);
    }
}
