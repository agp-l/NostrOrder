// Run against the real page, real IndexedDB and real crypto, with deterministic relay responses.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { generateSecretKey, getPublicKey, nip19, finalizeEvent } from 'nostr-tools';

const require = createRequire(import.meta.url);
const root = process.cwd();
const vendor = new Map();
for (const [path, module] of [['/vendor/nostr.js','nostr-tools'],['/vendor/hashes.js','@noble/hashes/utils']]) {
    const bundle = await build({stdin:{contents:'export * from "'+module+'";',resolveDir:root},
        bundle:true,format:'esm',platform:'browser',write:false});
    vendor.set(path,{body:bundle.outputFiles[0].text,type:'text/javascript'});
}
vendor.set('/vendor/bootstrap.css',{body:await readFile(require.resolve('bootstrap/dist/css/bootstrap.min.css')),type:'text/css'});
vendor.set('/vendor/bootstrap.js',{body:await readFile(require.resolve('bootstrap/dist/js/bootstrap.bundle.min.js')),type:'text/javascript'});
const replacements = [
    ['https://cdn.jsdelivr.net/npm/nostr-tools@2.7.2/+esm','/vendor/nostr.js'],
    ['https://cdn.jsdelivr.net/npm/@noble/hashes@1.3.0/utils/+esm','/vendor/hashes.js'],
    ['https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css','/vendor/bootstrap.css'],
    ['https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/js/bootstrap.bundle.min.js','/vendor/bootstrap.js']
];
const server=createServer(async(req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname;
    if(vendor.has(path)){const v=vendor.get(path);res.writeHead(200,{'Content-Type':v.type});res.end(v.body);return;}
    const file=resolve(root,'.'+(path==='/'?'/index.html':path));
    if(!file.startsWith(root+sep)){res.writeHead(403);res.end();return;}
    try {
        let body=await readFile(file,'utf8');
        for(const [from,to]of replacements)body=body.replaceAll(from,to);
        res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':'text/html'});
        res.end(body);
    }catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const aliceKey=generateSecretKey(),bobKey=generateSecretKey(),eveKey=generateSecretKey();
const alice=getPublicKey(aliceKey),bob=getPublicKey(bobKey),eve=getPublicKey(eveKey);
const inbox=finalizeEvent({kind:10050,created_at:Math.floor(Date.now()/1000),
    tags:[['relay','wss://inbox.test/']],content:''},bobKey);
const browser=await chromium.launch({headless:true});
try {
    for (const viewport of [{width:390,height:844},{width:1024,height:900}]) {
        const context=await browser.newContext({viewport});
        await context.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
        await context.addInitScript(({privHex,alice,bob,bobNpub,eveNpub,inbox})=>{
            sessionStorage.setItem('loginMethod','local');
            sessionStorage.setItem('myPrivHex',privHex);
            if(!localStorage.getItem('contacts_'+alice)) {
                localStorage.setItem('contacts_'+alice,JSON.stringify([
                    {npub:bobNpub,name:'Bob',picture:''},{npub:eveNpub,name:'Eve',picture:''}
                ]));
            }
            localStorage.setItem('my_nostr_relays',JSON.stringify(['wss://own.test/']));
            window.published=[];window.acceptMessages=false;
            class Socket extends EventTarget {
                static OPEN=1;static CONNECTING=0;
                constructor(url){super();this.url=url;this.readyState=0;
                    queueMicrotask(()=>{if(this.readyState===0){this.readyState=1;this.emit('open');}});}
                emit(type,data){const event=new Event(type);event.data=JSON.stringify(data);
                    this['on'+type]?.(event);this.dispatchEvent(event);}
                close(){this.readyState=3;this.emit('close');}
                send(raw){
                    const data=JSON.parse(raw);
                    if(data[0]==='REQ'&&data.slice(2).some(filter=>filter.authors?.includes(bob)&&filter.kinds?.includes(10050))){
                        queueMicrotask(()=>this.emit('message',['EVENT',data[1],inbox]));
                    }
                    if(data[0]==='EVENT'){
                        window.published.push({id:data[1].id,kind:data[1].kind,url:this.url});
                        const accepted=data[1].kind!==1059||window.acceptMessages;
                        queueMicrotask(()=>this.emit('message',['OK',data[1].id,accepted,accepted?'':'blocked: test refusal']));
                    }
                }
            }
            window.WebSocket=Socket;
        },{privHex:Buffer.from(aliceKey).toString('hex'),alice,bob,bobNpub:nip19.npubEncode(bob),eveNpub:nip19.npubEncode(eve),inbox});
        const page=await context.newPage();
        const errors=[];page.on('pageerror',error=>errors.push(error.message));
        page.on('dialog',dialog=>dialog.dismiss());
        await page.goto(origin);
        await page.locator('#contactsScreen.screen-active').waitFor();
        await page.locator('.contact-item').filter({hasText:'Bob'}).click();
        const input=page.locator('#messageInput');
        await input.waitFor({state:'visible'});
        await input.fill('První řádek');
        await input.press('Shift+Enter');
        await input.pressSequentially('Druhý řádek');
        assert.equal(await input.inputValue(),'První řádek\nDruhý řádek');
        await input.press('Enter');
        await page.waitForFunction(()=>document.querySelector('.time-stamp')?.textContent.includes('Nepotvrzeno')&&
            !document.querySelector('.retry-message')?.disabled);
        assert.equal(await page.locator('.msg-bubble').count(),1);
        assert.equal(await page.locator('.message-text').textContent(),'První řádek\nDruhý řádek');
        const stored=await page.evaluate(async({alice,bob})=>{
            const {db}=await import('/js/database.js');return (await db.getMessages(alice,bob))[0];
        },{alice,bob});
        assert.ok(stored.outbox);assert.equal(stored.status,'failed');
        await page.reload();
        await page.locator('#contactsScreen.screen-active').waitFor();
        await page.locator('.contact-item').filter({hasText:'Bob'}).click();
        await page.waitForFunction(()=>document.querySelector('.retry-message'));
        await page.evaluate(()=>{window.acceptMessages=true;});
        await page.locator('.retry-message').click();
        await page.waitForFunction(()=>document.querySelector('.time-stamp')?.textContent.includes('Přijato relayem')&&
            !document.querySelector('.retry-message'));
        assert.equal(await page.locator('.msg-bubble').count(),1);
        const retried=await page.evaluate(()=>window.published.filter(event=>event.kind===1059));
        assert.deepEqual(retried.map(event=>event.id).sort(),[stored.outbox.partnerWrap.id,stored.outbox.selfWrap.id].sort());
        assert.equal(retried.find(event=>event.id===stored.outbox.partnerWrap.id).url,'wss://inbox.test/');
        await input.fill('Rozepsáno pro Boba');
        await page.locator('#backToContactsBtn').click();
        await page.locator('.contact-item').filter({hasText:'Eve'}).click();
        assert.equal(await input.inputValue(),'');
        await page.locator('#backToContactsBtn').click();
        await page.locator('.contact-item').filter({hasText:'Bob'}).click();
        assert.equal(await input.inputValue(),'Rozepsáno pro Boba');
        const box=await page.locator('#sendBtn').boundingBox();
        assert.ok(box&&box.x>=0&&box.y>=0&&box.x+box.width<=viewport.width&&box.y+box.height<=viewport.height);
        assert.deepEqual(errors,[]);
        console.log('PASS browser flow '+viewport.width+'x'+viewport.height+': multiline, reject, reload, same-ID retry, drafts, visible composer');
        await context.close();
    }
} finally {
    await browser.close();
    await new Promise(resolve=>server.close(resolve));
}
