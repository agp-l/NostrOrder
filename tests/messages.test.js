import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderedMessages, mergeMessageRecords } from '../js/messages.js';

test('relay echoes preserve local retry envelopes and merge wrapper IDs', () => {
    const outbox = {partnerWrap:{id:'partner'},selfWrap:{id:'self'}};
    const saved = {id:'rumor',status:'failed',wrapIds:['partner'],outbox};
    const merged = mergeMessageRecords(saved, {id:'rumor',wrapIds:['self']});
    assert.equal(merged.status,'failed');
    assert.deepEqual(merged.outbox,outbox);
    assert.deepEqual(merged.wrapIds,['partner','self']);
});
test('successful delivery clears outbox and stale updates cannot downgrade acceptance', () => {
    const saved = {id:'x',status:'sent',selfSynced:true,outbox:null};
    const merged = mergeMessageRecords(saved,{id:'x',status:'failed',selfSynced:false});
    assert.equal(merged.status,'sent'); assert.equal(merged.selfSynced,true);
    assert.equal(merged.outbox,null);
});
test('deduplicates and orders out-of-order relay history with deterministic timestamp ties', () => {
    const messages = orderedMessages([
        {id:'c',timestamp:20}, {id:'b',timestamp:10}, {id:'a',timestamp:10},
        {id:'b',timestamp:10,text:'new'}
    ]);
    assert.deepEqual(messages.map(m=>m.id),['a','b','c']);
    assert.equal(messages[1].text,'new');
});
