// js/app.js
import { nip19 } from 'https://cdn.jsdelivr.net/npm/nostr-tools@2.7.2/+esm';
import { hexToBytes } from 'https://cdn.jsdelivr.net/npm/@noble/hashes@1.3.0/utils/+esm';
import { db } from './database.js';
import { UIManager, Utils } from './ui.js';
import { NostrClient } from './nostr.js';
import { vault } from './vault.js';

class Store {
    constructor() {
        this.myPubkey = null;
        this.activeChatPartnerHex = null;
        this.contacts = [];
        this.messagesCache = [];
        this.seenEvents = new Set();
    }

    loadContacts() {
        try {
            const key = "contacts_" + this.myPubkey;
            this.contacts = (JSON.parse(localStorage.getItem(key)) || []).filter(c => {
                try { return nip19.decode(c.npub).type === "npub"; } catch(e) { return false; }
            });
            localStorage.setItem(key, JSON.stringify(this.contacts));
        } catch (e) { this.contacts = []; }
    }

    saveContacts() {
        if (this.myPubkey) localStorage.setItem("contacts_" + this.myPubkey, JSON.stringify(this.contacts));
    }

    getSavedAccounts() { 
        try {
            // 🛡️ Ochrana proti pádu aplikace, pokud je localStorage poškozena
            return JSON.parse(localStorage.getItem("saved_accounts")) || []; 
        } catch (e) {
            return [];
        }
    }

    async saveAccount(loginMethod, privHex = null) {
        let accounts = this.getSavedAccounts();
        if (accounts.find(a => a.pubkey === this.myPubkey)) return;

        const entry = {
            pubkey: this.myPubkey,
            method: loginMethod,
            label: nip19.npubEncode(this.myPubkey).slice(0, 15) + "..."
        };

        if (loginMethod === 'local' && privHex) {
            if (vault.hasVault() && vault.isUnlocked()) {
                entry.enc = await vault.encrypt(privHex);
            } else {
                entry.privHex = privHex;
            }
        }

        accounts.push(entry);
        localStorage.setItem("saved_accounts", JSON.stringify(accounts));
    }

    removeAccount(pubkey) {
        localStorage.setItem("saved_accounts", JSON.stringify(this.getSavedAccounts().filter(a => a.pubkey !== pubkey)));
    }

    updateAccountLabel(name) {
        let accounts = this.getSavedAccounts();
        let acc = accounts.find(a => a.pubkey === this.myPubkey);
        if (acc && name) {
            acc.label = name;
            localStorage.setItem("saved_accounts", JSON.stringify(accounts));
        }
    }
}

class AppController {
    constructor() {
        // 🛡️ NEINICIALIZOVAT ZDE! Prohlížeč ještě nemusí mít vykreslené HTML
        this.store = null;
        this.ui = null;
        this.nostr = null;
    }

    init() {
        // 🚀 Bezpečně tvoříme třídy až po události DOMContentLoaded
        this.store = new Store();
        this.ui = new UIManager();
        this.nostr = new NostrClient();

        this.bindEvents();
        this.renderAccountsUI();
        if (sessionStorage.getItem("loginMethod")) this.start();
    }

    renderAccountsUI() {
        const accounts = this.store.getSavedAccounts().map(a => ({
            ...a,
            locked: a.method === 'local' && !!a.enc && !vault.isUnlocked()
        }));

        this.ui.renderSavedAccounts(accounts, acc => this.selectAccount(acc), pubkey => {
            if (confirm("Zapomenout tento účet na tomto zařízení?")) {
                this.store.removeAccount(pubkey);
                this.renderAccountsUI();
            }
        });

        this.refreshVaultPanel(accounts);
    }

    refreshVaultPanel(accounts) {
        const section = document.getElementById("vaultSection");
        if (!section) return;
        const setupPane = document.getElementById("vaultSetupPane");
        const unlockPane = document.getElementById("vaultUnlockPane");
        const unlockedPane = document.getElementById("vaultUnlockedPane");
        [setupPane, unlockPane, unlockedPane].forEach(p => { if (p) p.style.display = "none"; });

        const hasPlainLocal = accounts.some(a => a.method === 'local' && a.privHex);

        if (vault.hasVault()) {
            section.style.display = "block";
            if (vault.isUnlocked()) unlockedPane.style.display = "flex";
            else unlockPane.style.display = "block";
        } else if (hasPlainLocal) {
            section.style.display = "block";
            setupPane.style.display = "block";
        } else {
            section.style.display = "none";
        }
    }

    async selectAccount(acc) {
        if (acc.method === 'nip07') return this.login('nip07', null, acc.pubkey);

        if (acc.enc) {
            if (!vault.isUnlocked()) return alert("Nejdřív odemkni trezor heslem (viz nahoře na přihlašovací obrazovce).");
            try {
                const privHex = await vault.decrypt(acc.enc);
                this.login('local', privHex, acc.pubkey);
            } catch (e) {
                alert("Dešifrování klíče selhalo.");
            }
            return;
        }

        this.login('local', acc.privHex, acc.pubkey);
    }

    login(method, privHex = null, pubkey = null) {
        sessionStorage.setItem("loginMethod", method);
        if (method === 'nip07') sessionStorage.setItem("myPubkey", pubkey);
        else sessionStorage.setItem("myPrivHex", privHex);
        this.start();
    }

    // 🔒 Overlay přes celou appku, dokud se nezadá heslo trezoru. Nejde o "znovu-přihlášení" —
    // relace (websockety, dešifrovaný klíč v paměti NostrClient) běží dál na pozadí, jen se
    // vizuálně schová obsah chatů, aby je nikdo nepovolaný neviděl bez hesla.
    showAppLock(verifyPayload) {
        this._appLockVerifyPayload = verifyPayload;
        const overlay = document.getElementById("appLockOverlay");
        if (overlay) overlay.style.display = "flex";
    }

    hideAppLock() {
        const overlay = document.getElementById("appLockOverlay");
        if (overlay) overlay.style.display = "none";
    }

    bindEvents() {
        const bind = (id, event, handler) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener(event, handler);
            else console.warn(`UPOZORNĚNÍ: Tlačítko s ID '${id}' nebylo v HTML nalezeno!`);
        };

        bind("loginBtn", "click", () => {
            const input = document.getElementById("privateKeyInput").value.trim();
            if (!input) return;
            try {
                let hex = input;
                if (input.startsWith("nsec")) hex = Array.from(nip19.decode(input).data).map(b => b.toString(16).padStart(2, '0')).join('');
                this.login("local", hex);
            } catch (e) { alert("Chybný formát klíče."); }
        });

        bind("loginNip07Btn", "click", async () => {
            if (!window.nostr) return alert("Rozšíření pro bezpečné přihlášení nebylo nalezeno.");
            try { this.login("nip07", null, await window.nostr.getPublicKey()); } catch (e) { alert("Přihlášení selhalo."); }
        });

        bind("createAccountBtn", "click", () => {
            try {
                const privHex = this.nostr.generateNewAccount();
                sessionStorage.setItem("loginMethod", "local");
                sessionStorage.setItem("myPrivHex", privHex);
                alert("🎉 Účet úspěšně vytvořen!\n\nIHNED PO PŘIHLÁŠENÍ běžte do Nastavení (ozubené kolo vpravo nahoře) -> Klíče a zkopírujte si svůj Privátní klíč. Pokud jej ztratíte, ztratíte přístup ke svému účtu!");
                this.start();
            } catch (e) {
                alert("Při tvorbě účtu nastala chyba: " + e.message);
                console.error(e);
            }
        });

        bind("logoutBtn", "click", () => { vault.lock(); sessionStorage.clear(); location.reload(); });
        bind("openSettingsBtn", "click", () => this.ui.showScreen("settings"));
        bind("backFromSettingsBtn", "click", () => this.ui.showScreen("contacts"));
        bind("backToContactsBtn", "click", () => { this.store.activeChatPartnerHex = null; this.ui.showScreen("contacts"); });

        // ===== Zámek aplikace (manuální) =====
        bind("lockAppBtn", "click", () => {
            if (!vault.hasVault()) {
                return alert("Trezor ještě není nastavený. Odhlas se, na přihlašovací obrazovce klikni na „Nastavit heslo“ a pak se znovu přihlas.");
            }
            const entry = this.store.getSavedAccounts().find(a => a.pubkey === this.store.myPubkey);
            if (!entry?.enc) {
                return alert("Tenhle účet zatím není v trezoru zašifrovaný, nedá se jím zamknout.");
            }
            vault.lock();
            this.showAppLock(entry.enc);
        });

        bind("appUnlockBtn", "click", async () => {
            const pwd = document.getElementById("appLockPasswordInput").value;
            if (!pwd) return;
            try {
                await vault.unlock(pwd, this._appLockVerifyPayload);
                document.getElementById("appLockPasswordInput").value = "";
                this.hideAppLock();
            } catch (e) {
                alert("Nesprávné heslo trezoru.");
            }
        });
        bind("appLockPasswordInput", "keypress", (e) => { if (e.key === "Enter") document.getElementById("appUnlockBtn").click(); });

        bind("appLockLogoutBtn", "click", () => {
            if (confirm("Opravdu se odhlásit z aplikace? Příště se budeš muset přihlásit klíčem nebo rozšířením znovu.")) {
                vault.lock();
                sessionStorage.clear();
                location.reload();
            }
        });

        bind("createVaultBtn", "click", async () => {
            const p1 = document.getElementById("vaultPasswordCreate").value;
            const p2 = document.getElementById("vaultPasswordConfirm").value;
            if (!p1 || p1.length < 6) return alert("Heslo musí mít alespoň 6 znaků.");
            if (p1 !== p2) return alert("Hesla se neshodují.");
            try {
                await vault.createVault(p1);
                const accounts = this.store.getSavedAccounts();
                for (const acc of accounts) {
                    if (acc.method === 'local' && acc.privHex) {
                        acc.enc = await vault.encrypt(acc.privHex);
                        delete acc.privHex;
                    }
                }
                localStorage.setItem("saved_accounts", JSON.stringify(accounts));
                document.getElementById("vaultPasswordCreate").value = "";
                document.getElementById("vaultPasswordConfirm").value = "";
                this.renderAccountsUI();
                alert("✅ Uložené účty jsou od teď šifrovány heslem trezoru.");
            } catch (e) {
                alert("Zašifrování se nezdařilo: " + e.message);
            }
        });

        bind("unlockVaultBtn", "click", async () => {
            const pwd = document.getElementById("vaultPasswordInput").value;
            if (!pwd) return;
            const accounts = this.store.getSavedAccounts();
            const sample = accounts.find(a => a.method === 'local' && a.enc);
            try {
                await vault.unlock(pwd, sample ? sample.enc : null);
                document.getElementById("vaultPasswordInput").value = "";
                this.renderAccountsUI();
            } catch (e) {
                alert("Nesprávné heslo trezoru.");
            }
        });

        bind("lockVaultBtn", "click", () => {
            vault.lock();
            this.renderAccountsUI();
        });

        // Kompaktní trezor: formuláře jsou defaultně sbalené, tlačítko je jen odkryje.
        bind("vaultSetupToggleBtn", "click", () => {
            const form = document.getElementById("vaultSetupForm");
            const willShow = form.style.display === "none";
            form.style.display = willShow ? "block" : "none";
            if (willShow) document.getElementById("vaultPasswordCreate").focus();
        });
        bind("vaultUnlockToggleBtn", "click", () => {
            const form = document.getElementById("vaultUnlockForm");
            const willShow = form.style.display === "none";
            form.style.display = willShow ? "block" : "none";
            if (willShow) document.getElementById("vaultPasswordInput").focus();
        });
        bind("vaultPasswordConfirm", "keypress", (e) => { if (e.key === "Enter") document.getElementById("createVaultBtn").click(); });
        bind("vaultPasswordInput", "keypress", (e) => { if (e.key === "Enter") document.getElementById("unlockVaultBtn").click(); });

        bind("addContactBtn", "click", () => {
            const npub = document.getElementById("newContactInput").value.trim();
            if (!npub) return;
            try { if (nip19.decode(npub).type !== "npub") throw new Error(); } catch (e) { return alert("Neplatný klíč."); }
            if (this.store.contacts.find(c => c.npub === npub)) return alert("Kontakt již existuje.");
            this.store.contacts.push({ npub, name: "", picture: "" });
            this.store.saveContacts();
            document.getElementById("newContactInput").value = "";
            this.ui.renderContacts(this.store.contacts, (n, d, p) => this.openChat(n, d, p), npub => this.deleteContact(npub));
            this.updateContactProfiles();
        });

        bind("sendBtn", "click", () => this.sendMessage());
        bind("messageInput", "keypress", (e) => { if (e.key === "Enter") this.sendMessage(); });

        bind("clearDbBtn", "click", async () => {
            if (confirm("Opravdu smazat historii s tímto kontaktem?\nPokusíme se trvale smazat vámi odeslané zprávy i ze sítě (NIP-09).")) {
                const history = await db.getMessages(this.store.myPubkey, this.store.activeChatPartnerHex);
                
                let wrapIdsToDelete = [];
                history.filter(m => m.isMe && m.wrapIds).forEach(m => {
                    wrapIdsToDelete.push(...m.wrapIds);
                });

                if (wrapIdsToDelete.length > 0) {
                    await this.nostr.deleteEventsFromNetwork(wrapIdsToDelete);
                }
                
                await db.deleteChat(this.store.myPubkey, this.store.activeChatPartnerHex);
                location.reload();
            }
        });

        bind("saveProfileBtn", "click", async () => {
            const name = document.getElementById("profileName").value.trim();
            await this.nostr.publishProfile(name, document.getElementById("profileAbout").value.trim(), document.getElementById("profilePicture").value.trim());
            this.store.updateAccountLabel(name);
            alert("Profil úspěšně uložen do sítě!");
        });

        bind("copyNpubBtn", "click", () => { navigator.clipboard.writeText(document.getElementById("displayNpub").value); alert("Klíč zkopírován!"); });
        bind("copyNsecBtn", "click", () => { navigator.clipboard.writeText(document.getElementById("displayNsec").value); alert("Privátní klíč zkopírován! NIKOMU HO NEDÁVEJTE!"); });
        bind("toggleNsecBtn", "click", (e) => {
            const i = document.getElementById("displayNsec"); const ic = e.currentTarget.querySelector("i");
            if (i.type === "password") { i.type = "text"; ic.className = "bi bi-eye-slash text-purple"; } 
            else { i.type = "password"; ic.className = "bi bi-eye text-purple"; }
        });

        bind("addRelayBtn", "click", () => {
            let url = document.getElementById("newRelayInput").value.trim();
            if (!url) return;
            if (!url.startsWith("wss://")) url = "wss://" + url;

            try {
                const parsed = new URL(url);
                if (parsed.protocol !== "wss:") throw new Error("bad scheme");
            } catch (e) {
                return alert("Neplatná adresa relaye. Použij formát wss://relay.example.com");
            }

            if (!this.nostr.relays.includes(url)) {
                this.nostr.relays.push(url);
                this.nostr.saveRelays(this.nostr.relays);
                document.getElementById("newRelayInput").value = "";
                this.ui.renderRelays(this.nostr.relays, idx => this.removeRelay(idx));
            }
        });
    }

    async start() {
        try {
            const isNip07 = sessionStorage.getItem("loginMethod") === "nip07";

            // 🛡️ Ochrana: Odmítneme nastartovat chybějící relaci
            if (isNip07 && !sessionStorage.getItem("myPubkey")) return;
            if (!isNip07 && !sessionStorage.getItem("myPrivHex")) return;

            await this.nostr.init(isNip07 ? sessionStorage.getItem("myPubkey") : sessionStorage.getItem("myPrivHex"), isNip07);
            
            this.store.myPubkey = this.nostr.getPublicKeyHex();
            await this.store.saveAccount(sessionStorage.getItem("loginMethod"), sessionStorage.getItem("myPrivHex"));
            this.store.loadContacts();

            // 🔒 Pokud je tenhle účet zašifrovaný v trezoru, appka se při KAŽDÉM (znovu)startu
            // zamkne přes overlay, i když relace v sessionStorage běží dál na pozadí. Bez tohohle
            // by po refreshi stránky trezor sice existoval, ale k ničemu by to nebylo — appka by
            // vždycky nastartovala rovnou do chatů na klíči uloženém v sessionStorage.
            const savedEntry = this.store.getSavedAccounts().find(a => a.pubkey === this.store.myPubkey);
            if (savedEntry?.enc && vault.hasVault() && !vault.isUnlocked()) {
                this.showAppLock(savedEntry.enc);
            }
            
            document.getElementById("displayNpub").value = nip19.npubEncode(this.store.myPubkey);
            if (!isNip07) document.getElementById("displayNsec").value = nip19.nsecEncode(hexToBytes(sessionStorage.getItem("myPrivHex")));
            else { document.getElementById("nsecContainer").style.display = "none"; document.getElementById("nip07Notice").style.display = "block"; }

            this.ui.renderRelays(this.nostr.relays, idx => this.removeRelay(idx));
            this.ui.renderContacts(this.store.contacts, (n, d, p) => this.openChat(n, d, p), npub => this.deleteContact(npub));
            this.ui.showScreen("contacts");

            const lastTimestamp = await db.getLatestGlobalMessageTime(this.store.myPubkey);
            
            this.nostr.startGlobalSync(lastTimestamp, async (payload) => {
                if (payload.type === 'profile') {
                    if (payload.data.name) document.getElementById("profileName").value = payload.data.name;
                    if (payload.data.about) document.getElementById("profileAbout").value = payload.data.about;
                    if (payload.data.picture) document.getElementById("profilePicture").value = payload.data.picture;
                } else if (payload.type === 'message') {
                    const msgObj = payload.data;
                    const partnerNpub = nip19.npubEncode(msgObj.partnerPubkey);
                    if (!this.store.contacts.find(c => c.npub === partnerNpub)) {
                        this.store.contacts.push({ npub: partnerNpub, name: "", picture: "" });
                        this.store.saveContacts();
                        this.ui.renderContacts(this.store.contacts, (n, d, p) => this.openChat(n, d, p), npub => this.deleteContact(npub));
                        this.updateContactProfiles();
                    }
                    if (!this.store.seenEvents.has(msgObj.id)) {
                        this.store.seenEvents.add(msgObj.id);
                        await db.saveMessage(msgObj);
                        if (this.store.activeChatPartnerHex === msgObj.partnerPubkey) {
                            this.ui.chatStatus.style.display = "none";
                            this.store.messagesCache.push(msgObj);
                            this.ui.renderMessages(this.store.messagesCache);
                        }
                    }
                }
            });

            if (!isNip07) setTimeout(() => this.nostr.publishRelayLists(), 2000);
            this.updateContactProfiles();
        } catch (e) { Utils.log("ERROR", "Kritická chyba při startu chatu.", e); }
    }

    updateContactProfiles() {
        const hexKeys = this.store.contacts.map(c => { try { return nip19.decode(c.npub).data; } catch(e) { return null; } }).filter(h => h);
        if (this.store.myPubkey && !hexKeys.includes(this.store.myPubkey)) hexKeys.push(this.store.myPubkey);
        
        this.nostr.fetchProfiles(hexKeys, (pubkeyHex, profileData) => {
            if (pubkeyHex === this.store.myPubkey && profileData.name) {
                document.getElementById("profileName").value = profileData.name;
                this.store.updateAccountLabel(profileData.name);
            }
            let updated = false;
            this.store.contacts.forEach(c => {
                if (nip19.decode(c.npub).data === pubkeyHex) {
                    if (profileData.name && c.name !== profileData.name) { c.name = profileData.name; updated = true; }
                    if (profileData.picture && c.picture !== profileData.picture) { c.picture = profileData.picture; updated = true; }
                }
            });
            if (updated) {
                this.store.saveContacts();
                this.ui.renderContacts(this.store.contacts, (n, d, p) => this.openChat(n, d, p), npub => this.deleteContact(npub));
                if (this.store.activeChatPartnerHex === pubkeyHex) {
                    const c = this.store.contacts.find(co => nip19.decode(co.npub).data === pubkeyHex);
                    this.ui.updateChatHeader(c.name || "Neznámý", c.picture);
                }
            }
        });
    }

    deleteContact(npub) {
        if (confirm("Opravdu smazat kontakt ze seznamu?")) {
            this.store.contacts = this.store.contacts.filter(c => c.npub !== npub);
            this.store.saveContacts();
            this.ui.renderContacts(this.store.contacts, (n, d, p) => this.openChat(n, d, p), npub => this.deleteContact(npub));
        }
    }

    removeRelay(idx) {
        this.nostr.relays.splice(idx, 1);
        this.nostr.saveRelays(this.nostr.relays);
        this.ui.renderRelays(this.nostr.relays, idx => this.removeRelay(idx));
    }

    async openChat(npub, displayName, picture) {
        this.store.activeChatPartnerHex = nip19.decode(npub).data;
        this.ui.updateChatHeader(displayName, picture);
        this.ui.showScreen("chat");
        this.store.messagesCache = [];
        this.ui.chatWindow.innerHTML = '';
        this.ui.chatStatus.style.display = "block";
        
        const history = await db.getMessages(this.store.myPubkey, this.store.activeChatPartnerHex);
        this.ui.chatStatus.style.display = "none";
        if (history.length > 0) {
            history.forEach(msg => { this.store.seenEvents.add(msg.id); this.store.messagesCache.push(msg); });
            this.ui.renderMessages(this.store.messagesCache);
        }
        document.getElementById("messageInput").disabled = false;
        document.getElementById("sendBtn").disabled = false;
    }

    async sendMessage() {
        const input = document.getElementById("messageInput");
        const text = input.value.trim();
        if (!text || !this.store.activeChatPartnerHex) return;
        
        input.disabled = true;
        try {
            const msgObj = await this.nostr.sendNip59Message(text, this.store.activeChatPartnerHex);
            this.store.seenEvents.add(msgObj.id);
            this.store.messagesCache.push(msgObj);
            this.ui.renderMessages(this.store.messagesCache);
            await db.saveMessage(msgObj);
            input.value = "";
        } catch (e) { alert("Odeslání selhalo."); }
        finally { input.disabled = false; input.focus(); }
    }
}

// 🚀 Aplikaci teď spouštíme až když je HTML skutečně připraveno
const app = new AppController();
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => app.init());
} else {
    app.init();
}
