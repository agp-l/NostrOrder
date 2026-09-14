import { Utils } from './ui.js';

export function normalizeRelay(url) {
    if (typeof url !== 'string') return null;
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'wss:' || parsed.username || parsed.password || parsed.hash) return null;
        return parsed.href;
    } catch { return null; }
}

export class NostrNetwork {
    constructor({ WebSocketClass = globalThis.WebSocket, timeout = 10000, reconnectDelay = 5000 } = {}) {
        this.WebSocket = WebSocketClass;
        this.timeout = timeout;
        this.reconnectDelay = reconnectDelay;
        this.sockets = new Map();
        this.subscriptions = new Map();
        this.partnerRelays = new Map();
        this.relayLists = new Map();
        this.desiredRelays = new Set();
        this.reconnectTimers = new Map();
        this.onEventData = () => {};
        this.onStatus = () => {};
    }

    updatePartnerRelays(event) {
        const previous = this.relayLists.get(event.pubkey);
        if (previous && (previous.created_at > event.created_at ||
            (previous.created_at === event.created_at && previous.id <= event.id))) return;
        this.relayLists.set(event.pubkey, { created_at: event.created_at, id: event.id });
        this.partnerRelays.set(event.pubkey, new Set(event.tags
            .filter(tag => tag[0] === 'relay').map(tag => normalizeRelay(tag[1])).filter(Boolean).slice(0, 10)));
    }

    addSubscription(subId, filters) {
        const req = JSON.stringify(['REQ', subId, ...filters]);
        this.subscriptions.set(subId, req);
        this.sockets.forEach(ws => { if (ws.readyState === 1) ws.send(req); });
    }

    removeSubscription(subId) {
        this.subscriptions.delete(subId);
        this.sockets.forEach(ws => { if (ws.readyState === 1) ws.send(JSON.stringify(['CLOSE', subId])); });
    }

    reportStatus() {
        this.onStatus([...this.sockets.values()].filter(ws => ws.readyState === 1).length, this.desiredRelays.size);
    }

    ensureConnections(relays, onEventData = this.onEventData) {
        this.onEventData = onEventData;
        this.desiredRelays = new Set(relays.map(normalizeRelay).filter(Boolean));
        for (const [url, timer] of this.reconnectTimers) {
            if (!this.desiredRelays.has(url)) { clearTimeout(timer); this.reconnectTimers.delete(url); }
        }
        for (const [url, ws] of this.sockets) {
            if (!this.desiredRelays.has(url)) { this.sockets.delete(url); ws.close(); }
        }
        this.desiredRelays.forEach(url => this.connect(url));
        this.reportStatus();
    }

    connect(url) {
        if (!this.desiredRelays.has(url) || this.reconnectTimers.has(url)) return;
        const current = this.sockets.get(url);
        if (current && [0, 1].includes(current.readyState)) return;
        let ws;
        try { ws = new this.WebSocket(url); } catch { this.scheduleReconnect(url); return; }
        this.sockets.set(url, ws);
        const openingTimeout = setTimeout(() => { if (ws.readyState === 0) ws.close(); }, this.timeout);
        ws.onopen = () => {
            clearTimeout(openingTimeout);
            this.subscriptions.forEach(req => ws.send(req));
            this.reportStatus();
        };
        ws.onmessage = event => {
            try {
                const data = JSON.parse(event.data);
                if (Array.isArray(data) && data[0] === 'EVENT' && this.subscriptions.has(data[1])) {
                    Promise.resolve(this.onEventData(data[1], data[2])).catch(() => Utils.log('ERROR', 'Příchozí událost se nepodařilo zpracovat.'));
                }
            } catch { /* Malformed relay frames are ignored. */ }
        };
        ws.onclose = () => {
            clearTimeout(openingTimeout);
            if (this.sockets.get(url) !== ws) return;
            this.sockets.delete(url);
            this.reportStatus();
            this.scheduleReconnect(url);
        };
        ws.onerror = () => {};
    }

    scheduleReconnect(url) {
        if (!this.desiredRelays.has(url) || this.reconnectTimers.has(url)) return;
        this.reconnectTimers.set(url, setTimeout(() => {
            this.reconnectTimers.delete(url);
            this.connect(url);
        }, this.reconnectDelay));
    }

    // A successful WebSocket.send() is not evidence of relay acceptance.
    async publish(event, relays = [...this.desiredRelays]) {
        const urls = [...new Set(relays.map(normalizeRelay).filter(Boolean))];
        if (!urls.length) throw new Error('Není dostupný žádný relay pro odeslání.');
        const attempts = urls.map(url => this.publishToRelay(event, url));
        try { return await Promise.any(attempts); }
        catch { throw new Error('Žádný relay nepotvrdil přijetí. Zprávu lze zkusit odeslat znovu.'); }
    }

    publishToRelay(event, url) {
        return new Promise((resolve, reject) => {
            let ws = this.sockets.get(url);
            const temporary = !ws || ![0, 1].includes(ws.readyState);
            try { if (temporary) ws = new this.WebSocket(url); } catch (error) { reject(error); return; }
            let finished = false;
            const finish = error => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                ws.removeEventListener('open', send);
                ws.removeEventListener('message', receive);
                ws.removeEventListener('error', failed);
                ws.removeEventListener('close', failed);
                if (temporary) ws.close();
                if (error) reject(error); else resolve(url);
            };
            const send = () => { try { ws.send(JSON.stringify(['EVENT', event])); } catch (error) { finish(error); } };
            const receive = frame => {
                try {
                    const data = JSON.parse(frame.data);
                    if (Array.isArray(data) && data[0] === 'OK' && data[1] === event.id && typeof data[2] === 'boolean') {
                        finish(data[2] ? null : new Error('Relay zprávu odmítl.'));
                    }
                } catch { /* Ignore unrelated or malformed frames. */ }
            };
            const failed = () => finish(new Error('Spojení s relayem selhalo.'));
            const timer = setTimeout(() => finish(new Error('Relay nepotvrdil přijetí včas.')), this.timeout);
            ws.addEventListener('open', send);
            ws.addEventListener('message', receive);
            ws.addEventListener('error', failed);
            ws.addEventListener('close', failed);
            if (ws.readyState === 1) send();
        });
    }
}
