// js/app.js
import { nip19 } from 'https://cdn.jsdelivr.net/npm/nostr-tools@2.7.2/+esm';
import { hexToBytes } from 'https://cdn.jsdelivr.net/npm/@noble/hashes@1.3.0/utils/+esm';
import { initNostr, startGlobalSync, sendNip59Message, publishRelayLists, getMyPublicKey, RELAYS, saveRelays, publishProfile, fetchProfiles } from './nostr.js';
import { saveMessage, getMessages, clearDatabase, getLastMessageTime } from './db.js';

let messagesCache = []; 
const seenEvents = new Set();

// 🚀 ZMĚNA: Přidání activeChatPartnerHex, abychom věděli, komu právě vykreslujeme zprávy
let activeChatPartnerHex = null;
let myPubkey = null; 
let contacts = [];

function loadContactsForUser(pubkey) {
  try {
    // Každý účet má nyní SVŮJ VLASTNÍ seznam kontaktů oddělený od ostatních!
    const storageKey = "contacts_" + pubkey;
    const rawContacts = JSON.parse(localStorage.getItem(storageKey)) || [];
    
    contacts = rawContacts.filter(c => { 
      try { 
        const decoded = nip19.decode(c.npub);
        return decoded.type === "npub"; 
      } catch(e) { 
        return false; 
      }
    });
    
    localStorage.setItem(storageKey, JSON.stringify(contacts));
  } catch (e) { 
    contacts = []; 
  }
}

function saveContactsForUser() {
  if (!myPubkey) return;
  const storageKey = "contacts_" + myPubkey;
  localStorage.setItem(storageKey, JSON.stringify(contacts));
}

// ==========================================
// OCHRANA PROTI XSS
// ==========================================
function escapeHTML(str) {
  if (!str) {
    return "";
  }
  return str.replace(/[&<>'"]/g, tag => ({ 
    '&': '&amp;', 
    '<': '&lt;', 
    '>': '&gt;', 
    "'": '&#39;', 
    '"': '&quot;' 
  }[tag] || tag));
}

// UI Elementy
const screenLogin = document.getElementById("loginScreen");
const screenContacts = document.getElementById("contactsScreen");
const screenChat = document.getElementById("chatScreen");
const screenSettings = document.getElementById("settingsScreen");

const chatWindow = document.getElementById("chatWindow");
const messageInput = document.getElementById("messageInput");
const sendBtn = document.getElementById("sendBtn");
const debugLog = document.getElementById("debugLog");
const chatStatus = document.getElementById("chatStatus");

function logDebug(type, message, obj = null) {
  const time = new Date().toLocaleTimeString();
  let colorClass = 'debug-info';
  
  if (type === 'ERROR') {
    colorClass = 'debug-error';
  } else if (type === 'SUCCESS') {
    colorClass = 'debug-success';
  }
  
  let text = `<span class="${colorClass}">[${time}] ${type}: ${escapeHTML(message)}</span>\n`;
  if (obj) {
    text += escapeHTML(JSON.stringify(obj, null, 2)) + "\n\n"; 
  } else {
    text += "\n";
  }
  
  debugLog.innerHTML += text; 
  debugLog.scrollTop = debugLog.scrollHeight;
}

function showScreen(screenEl) {
  const screens = [screenLogin, screenContacts, screenChat, screenSettings];
  
  screens.forEach(s => { 
    s.classList.remove("screen-active"); 
    if (s !== screenEl) {
      s.classList.add("screen-hidden-right"); 
    }
  });
  
  screenEl.classList.remove("screen-hidden-right", "screen-hidden-left");
  screenEl.classList.add("screen-active");
}

document.getElementById("openSettingsBtn").addEventListener("click", () => {
  showScreen(screenSettings);
});

document.getElementById("backFromSettingsBtn").addEventListener("click", () => {
  showScreen(screenContacts);
});

document.getElementById("backToContactsBtn").addEventListener("click", () => { 
  activeChatPartnerHex = null; // Opuštění chatu
  showScreen(screenContacts); 
});

// ==========================================
// LOGIN A START
// ==========================================
document.getElementById("loginBtn").addEventListener("click", () => {
  const privKeyInput = document.getElementById("privateKeyInput").value.trim();
  
  if (!privKeyInput) {
    return;
  }
  
  try {
    let myPrivHex = privKeyInput;
    if (privKeyInput.startsWith("nsec")) {
      const decoded = nip19.decode(privKeyInput);
      myPrivHex = Array.from(decoded.data).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    
    sessionStorage.setItem("loginMethod", "local");
    sessionStorage.setItem("myPrivHex", myPrivHex);
    startApp();
  } catch (err) { 
    alert("Chybný formát klíče."); 
  }
});

document.getElementById("loginNip07Btn").addEventListener("click", async () => {
  if (!window.nostr) {
    alert("Nebylo nalezeno žádné Nostr rozšíření (např. Alby).");
    return;
  }
  
  try {
    const pubkey = await window.nostr.getPublicKey();
    sessionStorage.setItem("loginMethod", "nip07");
    sessionStorage.setItem("myPubkey", pubkey);
    startApp();
  } catch (err) {
    alert("Nepodařilo se připojit přes rozšíření. Zkontroluj oprávnění.");
  }
});

if (sessionStorage.getItem("loginMethod")) {
  startApp();
}

document.getElementById("logoutBtn").addEventListener("click", () => { 
  sessionStorage.clear(); 
  location.reload(); 
});

async function startApp() {
  const loginMethod = sessionStorage.getItem("loginMethod");
  
  try {
    if (loginMethod === "nip07") {
      const pk = sessionStorage.getItem("myPubkey");
      await initNostr(pk, true, logDebug);
      document.getElementById("nsecContainer").style.display = "none";
      document.getElementById("nip07Notice").style.display = "block";
    } else {
      const myPrivHex = sessionStorage.getItem("myPrivHex");
      await initNostr(myPrivHex, false, logDebug);
      document.getElementById("displayNsec").value = nip19.nsecEncode(hexToBytes(myPrivHex));
    }

    myPubkey = getMyPublicKey(); 
    document.getElementById("displayNpub").value = nip19.npubEncode(myPubkey);
    
    // Načteme bezpečně oddělené kontakty pouze pro tohoto uživatele!
    loadContactsForUser(myPubkey);
    
    // Získáme čas poslední zprávy pro efektivní stažení
    let lastTimestamp = await getLastMessageTime(myPubkey, myPubkey); 
    
    // 🚀 SPUŠTĚNÍ GLOBÁLNÍ SYNCHRONIZACE SÍTĚ
    startGlobalSync(null, async (payload) => {
      
      // Zpracování profilů
      if (payload.type === 'profile') {
        const profileData = payload.data;
        if (profileData.name) document.getElementById("profileName").value = profileData.name;
        if (profileData.about) document.getElementById("profileAbout").value = profileData.about;
        if (profileData.picture) document.getElementById("profilePicture").value = profileData.picture;
      } 
      
      // Zpracování VŠECH příchozích zpráv
      else if (payload.type === 'message') {
        const msgObj = payload.data;
        
        // 1. Zkontrolujeme, jestli daného partnera už máme v kontaktech.
        const partnerNpub = nip19.npubEncode(msgObj.partnerPubkey);
        const contactExists = contacts.find(c => c.npub === partnerNpub);
        
        // Pokud ho nemáme, AUTO-PŘIDÁME jej a stáhneme jeho jméno!
        if (!contactExists) {
          contacts.push({ npub: partnerNpub, name: "", picture: "" });
          saveContactsForUser();
          renderContactsList();
          updateContactProfiles(); // Do-stáhne novou fotku a jméno
        }

        // 2. Uložíme zprávu (pokud ji ještě nemáme)
        if (!seenEvents.has(msgObj.id)) { 
          seenEvents.add(msgObj.id); 
          await saveMessage(msgObj); 
          
          // 3. Vykreslíme zprávu, JEN POKUD máme zrovna otevřený chat s tímto člověkem
          if (activeChatPartnerHex === msgObj.partnerPubkey) {
            chatStatus.style.display = "none"; 
            displayMessage(msgObj); 
          }
        }
      }
    });

    renderRelayList();
    renderContactsList();
    showScreen(screenContacts);
    
    if (loginMethod !== "nip07") {
      setTimeout(() => { publishRelayLists(); }, 2000);
    }
    
    updateContactProfiles();
    
  } catch (err) { 
    logDebug("ERROR", "Chyba při startu.", err); 
  }
}

// ==========================================
// SPRÁVA KONTAKTŮ A VYKRESLOVÁNÍ
// ==========================================
function renderContactsList() {
  const list = document.getElementById("contactsList");
  list.innerHTML = "";
  
  if (contacts.length === 0) { 
    list.innerHTML = `<div class="p-4 text-center text-muted small">Historie je prázdná.</div>`; 
    return; 
  }
  
  contacts.forEach((contact, index) => {
    const item = document.createElement("div");
    item.className = "contact-item";
    
    const displayName = contact.name || "Neznámý kontakt";
    const safePicture = escapeHTML(contact.picture);
    const safeName = escapeHTML(displayName);
    const safeNpub = escapeHTML(contact.npub);
    
    let avatarHtml;
    if (safePicture) {
      avatarHtml = `<img src="${safePicture}" style="width:100%; height:100%; border-radius:50%; object-fit:cover;" onerror="this.style.display='none'">`;
    } else {
      avatarHtml = `<i class="bi bi-person-fill"></i>`;
    }
      
    item.innerHTML = `
      <div class="avatar">${avatarHtml}</div>
      <div style="flex:1; min-width: 0;">
        <div class="contact-name text-truncate">${safeName}</div>
        <div class="contact-npub text-truncate">${safeNpub}</div>
      </div>
      <button class="btn btn-link text-muted p-0 ms-2" onclick="event.stopPropagation(); deleteContact('${safeNpub}')">
        <i class="bi bi-trash"></i>
      </button>
    `;
    
    item.addEventListener("click", () => openChat(contact.npub, displayName, safePicture));
    list.appendChild(item);
  });
}

function updateContactProfiles() {
  const hexKeys = contacts.map(c => { 
    try { 
      return nip19.decode(c.npub).data; 
    } catch(e) { 
      return null; 
    } 
  }).filter(h => h !== null);
  
  // Zahrneme i sami sebe, abychom měli jistotu, že dostaneme svůj profil
  if (myPubkey && !hexKeys.includes(myPubkey)) {
    hexKeys.push(myPubkey);
  }
  
  if (hexKeys.length > 0) {
    fetchProfiles(hexKeys, (pubkeyHex, profileData) => {
      
      // Vyplnění vlastního profilu do formuláře, pokud přišel náš
      if (pubkeyHex === myPubkey) {
        if (profileData.name) document.getElementById("profileName").value = profileData.name;
        if (profileData.about) document.getElementById("profileAbout").value = profileData.about;
        if (profileData.picture) document.getElementById("profilePicture").value = profileData.picture;
      }
      
      let updated = false;
      contacts.forEach(c => {
        if (nip19.decode(c.npub).data === pubkeyHex) {
          if (profileData.name && c.name !== profileData.name) { 
            c.name = profileData.name; 
            updated = true; 
          } else if (profileData.display_name && c.name !== profileData.display_name) { 
            c.name = profileData.display_name; 
            updated = true; 
          }
          if (profileData.picture && c.picture !== profileData.picture) { 
            c.picture = profileData.picture; 
            updated = true; 
          }
        }
      });
      
      if (updated) {
        saveContactsForUser();
        renderContactsList(); 
        
        // Zaktualizujeme i hlavičku aktivního chatu
        if (activeChatPartnerHex === pubkeyHex) {
          const c = contacts.find(co => nip19.decode(co.npub).data === pubkeyHex);
          document.getElementById("chatHeaderName").textContent = c.name || "Neznámý kontakt"; 
          if (c.picture) {
            const safePic = escapeHTML(c.picture);
            document.querySelector("#chatScreen .avatar").innerHTML = `<img src="${safePic}" style="width:100%; height:100%; border-radius:50%; object-fit:cover;" onerror="this.style.display='none'">`;
          }
        }
      }
    });
  }
}

document.getElementById("addContactBtn").addEventListener("click", () => {
  const npub = document.getElementById("newContactInput").value.trim();
  if (!npub) return;
  try { 
    if (nip19.decode(npub).type !== "npub") throw new Error("Neplatný typ klíče");
  } catch (err) { 
    alert("Zadaný klíč není platný!"); 
    return; 
  }
  
  if (contacts.find(c => c.npub === npub)) { 
    alert("Tento kontakt už v seznamu máte."); 
    return; 
  }
  
  contacts.push({ npub: npub, name: "", picture: "" });
  saveContactsForUser();
  document.getElementById("newContactInput").value = "";
  
  renderContactsList(); 
  updateContactProfiles();
});

window.deleteContact = (npub) => {
  if (confirm("Odstranit kontakt ze seznamu?")) {
    contacts = contacts.filter(c => c.npub !== npub);
    saveContactsForUser();
    renderContactsList();
  }
};

// ==========================================
// CHATOVÁNÍ
// ==========================================
async function openChat(npub, displayName, picture) {
  try {
    activeChatPartnerHex = nip19.decode(npub).data;
    
    document.getElementById("chatHeaderName").textContent = displayName;
    const headerAvatar = document.querySelector("#chatScreen .avatar");
    
    if (picture) {
      headerAvatar.innerHTML = `<img src="${escapeHTML(picture)}" style="width:100%; height:100%; border-radius:50%; object-fit:cover;" onerror="this.style.display='none'">`;
    } else {
      headerAvatar.innerHTML = `<i class="bi bi-person-fill"></i>`;
    }

    showScreen(screenChat);
    
    messagesCache = []; 
    chatWindow.innerHTML = '';
    chatStatus.style.display = "block"; 
    messageInput.disabled = true; 
    sendBtn.disabled = true;

    // Zde už nespouštíme novou relaci se serverem! Server už globálně stahuje VŠE!
    // My si pouze vytáhneme data z naší nesmírně rychlé lokální databáze (z db.js).
    const localHistory = await getMessages(myPubkey, activeChatPartnerHex);
    
    if (localHistory.length > 0) { 
      chatStatus.style.display = "none"; 
      localHistory.forEach(msg => { 
        seenEvents.add(msg.id); 
        displayMessage(msg); 
      }); 
    } else {
      chatStatus.style.display = "none"; 
    }

    messageInput.disabled = false; 
    sendBtn.disabled = false;
    
  } catch(e) { 
    alert("Nastala chyba při otevírání chatu."); 
  }
}

function displayMessage(msgObj) {
  if (messagesCache.some(m => m.id === msgObj.id)) {
    return; 
  }
  
  messagesCache.push(msgObj); 
  messagesCache.sort((a, b) => a.timestamp - b.timestamp); 
  chatWindow.innerHTML = ''; 
  
  messagesCache.forEach(msg => {
    const timeObj = new Date(msg.timestamp * 1000);
    const timeStr = timeObj.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    
    const bubble = document.createElement("div");
    bubble.className = `msg-bubble shadow-sm ${msg.isMe ? 'msg-out' : 'msg-in'}`;
    
    bubble.innerHTML = `<div>${escapeHTML(msg.text)}</div><span class="time-stamp">${timeStr}</span>`;
    
    chatWindow.appendChild(bubble);
  });
  
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

sendBtn.addEventListener("click", async () => {
  const text = messageInput.value.trim();
  
  if (!text || !activeChatPartnerHex) {
    return;
  }
  
  messageInput.disabled = true; 
  
  try {
    const msgObj = await sendNip59Message(text, activeChatPartnerHex);
    
    // Zpráva odešla v pořádku (do Relayů i do Self-Sync)
    seenEvents.add(msgObj.id); 
    displayMessage(msgObj); 
    await saveMessage(msgObj); 
    messageInput.value = "";
    
  } catch (err) { 
    alert("Odesílání se nezdařilo."); 
  } finally { 
    messageInput.disabled = false; 
    messageInput.focus(); 
  }
});

messageInput.addEventListener("keypress", (e) => { 
  if (e.key === "Enter") {
    sendBtn.click(); 
  }
});

document.getElementById("clearDbBtn").addEventListener("click", async () => { 
  if (confirm("Vymazat historii chatu z prohlížeče? (Zprávy v síti zůstanou)")) { 
    await clearDatabase(); 
    location.reload(); 
  } 
});

// ==========================================
// NASTAVENÍ A PROFIL
// ==========================================
document.getElementById("saveProfileBtn").addEventListener("click", async () => {
  try {
    await publishProfile(
      document.getElementById("profileName").value.trim(), 
      document.getElementById("profileAbout").value.trim(), 
      document.getElementById("profilePicture").value.trim()
    );
    alert("Profil uložen do sítě Nostr!");
  } catch (e) { 
    alert("Zrušeno uživatelem nebo došlo k chybě."); 
  }
});

document.getElementById("copyNpubBtn").addEventListener("click", () => { 
  navigator.clipboard.writeText(document.getElementById("displayNpub").value); 
  alert("Klíč zkopírován!"); 
});

document.getElementById("copyNsecBtn").addEventListener("click", () => { 
  navigator.clipboard.writeText(document.getElementById("displayNsec").value); 
  alert("Privátní klíč zkopírován!"); 
});

document.getElementById("toggleNsecBtn").addEventListener("click", (e) => {
  const input = document.getElementById("displayNsec"); 
  const icon = e.currentTarget.querySelector("i");
  
  if (input.type === "password") { 
    input.type = "text"; 
    icon.className = "bi bi-eye-slash text-purple"; 
  } else { 
    input.type = "password"; 
    icon.className = "bi bi-eye text-purple"; 
  }
});

function renderRelayList() {
  const listUI = document.getElementById("relayListUI"); 
  listUI.innerHTML = "";
  
  RELAYS.forEach((url, index) => {
    const li = document.createElement("li"); 
    li.className = "list-group-item d-flex justify-content-between align-items-center small py-2 px-2 border-bottom";
    
    li.innerHTML = `
      <span>${escapeHTML(url)}</span> 
      <button class="btn btn-link text-secondary p-0" data-index="${index}">
        <i class="bi bi-x-circle-fill"></i>
      </button>
    `;
    listUI.appendChild(li);
  });
  
  listUI.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", (e) => { 
      const idx = e.currentTarget.getAttribute("data-index");
      RELAYS.splice(idx, 1); 
      saveRelays(RELAYS); 
      renderRelayList(); 
    });
  });
}

document.getElementById("addRelayBtn").addEventListener("click", () => {
  let url = document.getElementById("newRelayInput").value.trim();
  
  if (!url) return; 
  if (!url.startsWith("wss://")) {
    url = "wss://" + url; 
  }
  if (RELAYS.includes(url)) return;
  
  RELAYS.push(url); 
  saveRelays(RELAYS); 
  
  document.getElementById("newRelayInput").value = ""; 
  renderRelayList();
});