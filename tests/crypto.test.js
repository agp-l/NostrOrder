import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey, getPublicKey, getEventHash, nip44 } from 'nostr-tools';
import { NostrClient, NostrCrypto } from '../js/nostr.js';

globalThis.localStorage = {getItem:()=>null};
globalThis.document = {getElementById:()=>null};
const aliceKey = generateSecretKey(), bobKey = generateSecretKey(), eveKey = generateSecretKey();
const alice = getPublicKey(aliceKey), bob = getPublicKey(bobKey), eve = getPublicKey(eveKey);
function client() { const c=new NostrClient(); c.privBytes=aliceKey;c.pubHex=alice;return c; }

function wrapRumor(rumor, key = aliceKey, receiver = bob) {
    const seal = finalizeEvent({kind:13,created_at:1,tags:[],
        content:nip44.encrypt(JSON.stringify(rumor),nip44.getConversationKey(key,receiver))},key);
    const ephemeral = generateSecretKey();
    return finalizeEvent({kind:1059,created_at:1,tags:[['p',receiver]],
        content:nip44.encrypt(JSON.stringify(seal),nip44.getConversationKey(ephemeral,receiver))},ephemeral);
}
test('real NIP-44/59 roundtrip, sender backup, fresh wrappers and obfuscated timestamps', async () => {
    const c=client(), before=Math.floor(Date.now()/1000);
    const message=await c.prepareNip59Message('Ahoj\nsvěte',bob);
    const incoming=await NostrCrypto.decryptEvent(message.outbox.partnerWrap,bob,bobKey,false);
    const backup=await NostrCrypto.decryptEvent(message.outbox.selfWrap,alice,aliceKey,false);
    assert.equal(incoming.text,'Ahoj\nsvěte');assert.equal(incoming.partnerPubkey,alice);
    assert.equal(backup.partnerPubkey,bob);assert.equal(backup.isMe,true);
    assert.equal(incoming.id,backup.id);
    assert.notEqual(message.outbox.partnerWrap.pubkey,message.outbox.selfWrap.pubkey);
    for(const wrap of Object.values(message.outbox)) {
        assert.ok(wrap.created_at >= before-172800 && wrap.created_at<=Math.floor(Date.now()/1000));
    }
});
test('rejects correctly hashed rumor whose author differs from the valid seal signer', async () => {
    const rumor={kind:14,pubkey:eve,created_at:100,tags:[['p',bob]],content:'forged'};
    rumor.id=getEventHash(rumor);
    assert.equal(await NostrCrypto.decryptEvent(wrapRumor(rumor),bob,bobKey,false),null);
});
test('rejects corrupted hash, group rumor and wrapper addressed to someone else', async () => {
    const base={kind:14,pubkey:alice,created_at:100,tags:[['p',bob]],content:'test'};
    assert.equal(await NostrCrypto.decryptEvent(wrapRumor({...base,id:'0'.repeat(64)}),bob,bobKey,false),null);
    const group={...base,tags:[['p',bob],['p',eve]]};group.id=getEventHash(group);
    assert.equal(await NostrCrypto.decryptEvent(wrapRumor(group),bob,bobKey,false),null);
    const c=client(),message=await c.prepareNip59Message('test',bob);
    assert.equal(await NostrCrypto.decryptEvent(message.outbox.partnerWrap,eve,eveKey,false),null);
    assert.equal(await NostrCrypto.decryptEvent(null,bob,bobKey,false),null);
});
test('retries use the same envelopes, preserve recipient success and retry only missing self-sync', async () => {
    const c=client(), message=await c.prepareNip59Message('retry',bob);
    c.network.partnerRelays.set(bob,new Set(['wss://inbox.test/']));
    const calls=[];
    c.network.publish=async (event,relays)=>{calls.push({id:event.id,relays});if(event.id===message.outbox.selfWrap.id)throw Error('offline');};
    const partial=await c.publishMessage(message);
    assert.equal(partial.status,'sent');assert.equal(partial.selfSynced,false);assert.ok(partial.outbox);
    assert.deepEqual(calls[0].relays,['wss://inbox.test/']);
    c.network.publish=async event=>{calls.push({id:event.id});};
    const complete=await c.publishMessage(partial);
    assert.equal(complete.status,'sent');assert.equal(complete.outbox,null);
    assert.equal(calls.filter(call=>call.id===message.outbox.partnerWrap.id).length,1);
    assert.equal(calls.filter(call=>call.id===message.outbox.selfWrap.id).length,2);
});
test('recipient failure is not hidden by successful sender backup', async () => {
    const c=client(),message=await c.prepareNip59Message('retry',bob);
    c.network.partnerRelays.set(bob,new Set(['wss://inbox.test/']));
    c.network.publish=async event=>{if(event.id===message.outbox.partnerWrap.id)throw Error('offline');};
    const partial=await c.publishMessage(message);
    assert.equal(partial.status,'failed');assert.equal(partial.selfSynced,true);assert.ok(partial.outbox);
});
test('unsupported NIP-07 encryption reports an actionable error', async () => {
    const c=client();c.isNip07=true;globalThis.window={nostr:{}};
    await assert.rejects(c.prepareNip59Message('test',bob),/NIP-44/);
});
