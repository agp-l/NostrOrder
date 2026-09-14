import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../js/database.js';

const elements = {messageInput:{value:'',disabled:false},sendBtn:{disabled:false}};
globalThis.document = {readyState:'loading',addEventListener:()=>{},getElementById:id=>elements[id]};
globalThis.alert=()=>{};
const { AppController }=await import('../js/app.js');
const { nip19 }=await import('nostr-tools');
const a='a'.repeat(64), b='b'.repeat(64);
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function controller() {
    const c=new AppController();
    c.store={myPubkey:'me',activeChatPartnerHex:null,messagesCache:[]};
    c.ui={updateChatHeader:()=>{},showScreen:()=>{},chatWindow:{replaceChildren:()=>{}},
        setChatStatus:()=>{},renderMessages:()=>{}};
    return c;
}
test('late history from another contact cannot replace the currently open chat', async () => {
    const original=db.getMessages,c=controller(),first=deferred(),second=deferred();
    db.getMessages=async (_,partner)=>partner===a?first.promise:second.promise;
    try {
        const loadA=c.openChat(nip19.npubEncode(a),'A','');
        const loadB=c.openChat(nip19.npubEncode(b),'B','');
        second.resolve([{id:'b',timestamp:2,partnerPubkey:b}]);await loadB;
        first.resolve([{id:'a',timestamp:1,partnerPubkey:a}]);await loadA;
        assert.equal(c.store.activeChatPartnerHex,b);
        assert.deepEqual(c.store.messagesCache.map(m=>m.id),['b']);
    } finally {db.getMessages=original;}
});
test('double send is guarded; failed local persistence never publishes or clears draft', async () => {
    const original=db.saveMessage,c=controller(),prepared=deferred();
    let preparations=0,published=0;
    c.store.activeChatPartnerHex=a;
    c.nostr={prepareNip59Message:()=>{preparations++;return prepared.promise;}};
    c.deliverMessage=async()=>{published++;};
    elements.messageInput={value:'draft',disabled:false};
    db.saveMessage=async()=>{throw Error('quota exceeded');};
    try {
        const sending=c.sendMessage();
        await c.sendMessage();
        prepared.resolve({id:'x',partnerPubkey:a});await sending;
        assert.equal(preparations,1);assert.equal(published,0);
        assert.equal(elements.messageInput.value,'draft');
        assert.equal(elements.sendBtn.disabled,false);
    } finally {db.saveMessage=original;}
});
test('new draft survives while a previous draft is being signed', async () => {
    const original=db.saveMessage,c=controller(),prepared=deferred();
    c.store.activeChatPartnerHex=a;c.nostr={prepareNip59Message:()=>prepared.promise};
    let delivered;
    c.deliverMessage=async message=>{delivered=message;};
    elements.messageInput={value:'original',disabled:false};
    db.saveMessage=async message=>message;
    try {
        const sending=c.sendMessage();
        elements.messageInput.value='new draft';c.saveDraft();
        prepared.resolve({id:'x',timestamp:1,partnerPubkey:a,text:'original'});await sending;
        assert.equal(elements.messageInput.value,'new draft');
        assert.equal(c.drafts.get(a),'new draft');assert.equal(delivered.text,'original');
    } finally {db.saveMessage=original;}
});
