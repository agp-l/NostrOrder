import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { Database } from '../js/database.js';

test('concurrent relay echoes preserve durable outbox and isolate multiple accounts', async () => {
    const db=new Database('test-isolation');
    const outgoing={ownerPubkey:'alice',partnerPubkey:'bob',id:'same',timestamp:10,text:'hello',
        status:'failed',wrapIds:['partner'],outbox:{partnerWrap:{id:'partner'},selfWrap:{id:'self'}}};
    await db.saveMessage(outgoing);
    await Promise.all([
        db.saveMessage({ownerPubkey:'alice',partnerPubkey:'bob',id:'same',timestamp:10,text:'hello',wrapIds:['self']}),
        db.saveMessage({ownerPubkey:'other',partnerPubkey:'bob',id:'same',timestamp:11,text:'other account'})
    ]);
    const [message]=await db.getMessages('alice','bob');
    assert.deepEqual(message.wrapIds,['partner','self']);assert.deepEqual(message.outbox,outgoing.outbox);
    assert.equal((await db.getMessages('other','bob'))[0].text,'other account');
    await db.deleteChat('alice','bob');
    assert.equal((await db.getMessages('alice','bob')).length,0);
    assert.equal((await db.getMessages('other','bob')).length,1);
    await db.clearDatabase();
});
