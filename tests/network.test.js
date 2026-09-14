import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NostrNetwork, normalizeRelay } from '../js/network.js';

class Socket extends EventTarget {
    static instances = [];
    constructor(url) { super(); this.url = url; this.readyState = 0; this.sent = []; Socket.instances.push(this); }
    emit(type, data) {
        const event = new Event(type);
        if (data !== undefined) event.data = typeof data === 'string' ? data : JSON.stringify(data);
        this['on' + type]?.(event);
        this.dispatchEvent(event);
    }
    open() { this.readyState = 1; this.emit('open'); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.emit('close'); }
}
const network = (options = {}) => new NostrNetwork({ WebSocketClass: Socket, timeout: 100, reconnectDelay: 10, ...options });
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));

test('publication waits for matching OK=true, including connecting sockets', async () => {
    const n = network();
    n.ensureConnections(['wss://one.test']);
    const ws = n.sockets.get('wss://one.test/');
    let settled = false;
    const publication = n.publish({ id: 'message' }).then(() => { settled = true; });
    assert.equal(ws.sent.length, 0);
    ws.open();
    assert.equal(ws.sent[0][1].id, 'message');
    ws.emit('message', ['OK', 'unrelated', true, '']);
    ws.emit('message', ['OK', 'message', 'true', '']);
    await tick(0);
    assert.equal(settled, false);
    ws.emit('message', ['OK', 'message', true, 'duplicate: already have this event']);
    await publication;
    n.ensureConnections([]);
});

test('rejected, disconnected, empty and timed-out publications never report success', async () => {
    const n = network();
    await assert.rejects(n.publish({id:'x'}, []));
    for (const frame of [['OK','x',false,'blocked: no'], null, 'timeout']) {
        const result = assert.rejects(n.publish({id:'x'}, ['wss://one.test']));
        const ws = Socket.instances.at(-1);
        ws.open();
        if (frame === null) ws.close();
        else if (frame !== 'timeout') ws.emit('message', frame);
        await result;
        assert.equal(ws.readyState, 3);
    }
});

test('one accepting relay suffices and temporary sockets close', async () => {
    const n = network();
    const result = n.publish({id:'x'}, ['wss://one.test', 'wss://two.test']);
    const [one,two] = Socket.instances.slice(-2);
    one.open(); two.open();
    one.emit('message',['OK','x',false,'blocked: no']);
    two.emit('message',['OK','x',true,'']);
    assert.equal(await result, 'wss://two.test/');
    assert.equal(one.readyState,3); assert.equal(two.readyState,3);
});

test('removing relays cancels reconnects; new relay immediately gets subscriptions', async () => {
    const n = network();
    n.addSubscription('chat', [{kinds:[1059]}]);
    n.ensureConnections(['wss://one.test']);
    const old = Socket.instances.at(-1);
    old.open(); old.close();
    n.ensureConnections(['wss://two.test']);
    const next = Socket.instances.at(-1);
    next.open();
    assert.deepEqual(next.sent[0], ['REQ','chat',{kinds:[1059]}]);
    await tick(15);
    assert.deepEqual([...n.sockets.keys()], ['wss://two.test/']);
    n.ensureConnections([]);
});

test('only secure DM relays from the latest replaceable event are used', () => {
    const n = network();
    n.updatePartnerRelays({pubkey:'p',created_at:2,id:'b',tags:[['relay','wss://new.test'], ['relay','https://bad.test'], ['r','wss://ignored.test']]});
    n.updatePartnerRelays({pubkey:'p',created_at:1,id:'a',tags:[['relay','wss://old.test']]});
    assert.deepEqual([...n.partnerRelays.get('p')],['wss://new.test/']);
    n.updatePartnerRelays({pubkey:'p',created_at:3,id:'c',tags:[]});
    assert.equal(n.partnerRelays.get('p').size,0);
    assert.equal(normalizeRelay('wss://user:password@relay.test'),null);
    assert.equal(normalizeRelay('wss://relay.test/#fragment'),null);
    assert.equal(normalizeRelay({}),null);
});

test('only known subscriptions dispatch events; failed async handlers are contained', async () => {
    globalThis.document = { getElementById: () => null };
    const n = network();
    let calls = 0;
    n.addSubscription('known',[]);
    n.ensureConnections(['wss://one.test'], async () => { calls++; throw new Error('invalid event'); });
    const ws = Socket.instances.at(-1); ws.open();
    ws.emit('message', 'invalid-json');
    ws.emit('message', ['EVENT','unknown',{}]);
    ws.emit('message', ['EVENT','known',{}]);
    await tick(0);
    assert.equal(calls,1);
    n.ensureConnections([]);
});
