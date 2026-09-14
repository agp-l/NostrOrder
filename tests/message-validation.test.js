import { test } from 'node:test';
import assert from 'node:assert/strict';
import { directChatPartner } from '../js/message-validation.js';

const alice = 'a'.repeat(64), bob = 'b'.repeat(64), eve = 'e'.repeat(64);
const rumor = (changes = {}) => ({ kind: 14, pubkey: alice, created_at: 100,
    tags: [['p', bob]], content: 'Ahoj\nsvěte', ...changes });

test('incoming DM and sender backup resolve to the same direct conversation', () => {
    assert.equal(directChatPartner(rumor(), alice, bob), alice);
    assert.equal(directChatPartner(rumor(), alice, alice), bob);
});
test('a seal cannot impersonate another rumor author', () => {
    assert.equal(directChatPartner(rumor({pubkey: eve}), alice, bob), null);
});
test('rejects misaddressed and group rumors instead of mixing private histories', () => {
    assert.equal(directChatPartner(rumor({tags: [['p', eve]]}), alice, bob), null);
    assert.equal(directChatPartner(rumor({tags: [['p', bob], ['p', eve]]}), alice, bob), null);
});
test('handles self notes and duplicate recipient tags', () => {
    assert.equal(directChatPartner(rumor({tags: [['p', alice]]}), alice, alice), alice);
    assert.equal(directChatPartner(rumor({tags: [['p', bob], ['p', bob]]}), alice, bob), alice);
});
test('rejects malformed messages, keys and timestamps', () => {
    for (const invalid of [null, {kind: 4}, {content: {}}, {created_at: -1},
        {created_at: 1.5}, {created_at: NaN}, {tags: null}, {tags: [null]},
        {tags: [['p']]}, {tags: [['p', 123]]}, {tags: [['p', 'invalid']]}, {tags: []}]) {
        assert.equal(directChatPartner(invalid === null ? null : rumor(invalid), alice, bob), null);
    }
});
