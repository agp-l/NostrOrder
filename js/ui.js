// js/ui.js
export class Utils {
    static escapeHTML(str) {
        if (!str) return "";
        return str.replace(/[&<>'"]/g, tag => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
        }[tag] || tag));
    }

    // 🔒 Jen http/https URL smí skončit v `src` obrázku (profilovka kontaktu apod.).
    // Bránění nestandardním schématům (data:, javascript: – i když prohlížeče už
    // javascript: v <img src> dnes neprovádí, jde o obranu do hloubky).
    static isSafeImageUrl(url) {
        if (!url || typeof url !== 'string') return false;
        try {
            const u = new URL(url, window.location.href);
            return u.protocol === 'http:' || u.protocol === 'https:';
        } catch (e) {
            return false;
        }
    }

    static log(type, message, obj = null) {
        const debugLog = document.getElementById("debugLog");
        if (!debugLog) return;

        const time = new Date().toLocaleTimeString();
        const colorClass = type === 'ERROR' ? 'debug-error' : (type === 'SUCCESS' ? 'debug-success' : 'debug-info');

        // Používáme textContent (ne innerHTML) — text se tím automaticky escapuje
        // a odpadá riziko, že by nějaká hodnota v logu (např. chybová zpráva ze sítě
        // obsahující "<script>") skončila vyrenderovaná jako HTML.
        const line = document.createElement('span');
        line.className = colorClass;
        line.textContent = `[${time}] ${type}: ${message}`;
        debugLog.appendChild(line);
        debugLog.appendChild(document.createElement('br'));

        if (obj) {
            const dump = document.createElement('span');
            dump.textContent = JSON.stringify(obj, null, 2);
            debugLog.appendChild(dump);
            debugLog.appendChild(document.createElement('br'));
        }
        debugLog.appendChild(document.createElement('br'));

        // 🔒 Ochrana proti neomezenému růstu DOM/paměti při dlouho běžící relaci.
        const MAX_LOG_NODES = 800;
        while (debugLog.childNodes.length > MAX_LOG_NODES) {
            debugLog.removeChild(debugLog.firstChild);
        }

        debugLog.scrollTop = debugLog.scrollHeight;
    }
}

export class UIManager {
    constructor() {
        this.screens = {
            login: document.getElementById("loginScreen"),
            contacts: document.getElementById("contactsScreen"),
            chat: document.getElementById("chatScreen"),
            settings: document.getElementById("settingsScreen")
        };
        this.chatWindow = document.getElementById("chatWindow");
        this.chatStatus = document.getElementById("chatStatus");
    }

    showScreen(screenName) {
        const targetScreen = this.screens[screenName];
        Object.values(this.screens).forEach(s => {
            if (s) {
                s.classList.remove("screen-active");
                if (s !== targetScreen) s.classList.add("screen-hidden-right");
            }
        });
        if (targetScreen) {
            targetScreen.classList.remove("screen-hidden-right", "screen-hidden-left");
            targetScreen.classList.add("screen-active");
        }
    }

    // Pomocná metoda: vloží do `container` buď bezpečný <img> (bez inline onerror
    // atributu — handler se připojuje přes JS vlastnost, takže to funguje i pod
    // přísným Content-Security-Policy bez 'unsafe-inline' pro script-src), nebo fallback ikonu.
    _renderAvatarInto(container, pictureUrl) {
        container.innerHTML = "";
        if (pictureUrl && Utils.isSafeImageUrl(pictureUrl)) {
            const img = document.createElement("img");
            img.src = pictureUrl;
            img.style.cssText = "width:100%; height:100%; border-radius:50%; object-fit:cover;";
            img.onerror = () => {
                img.remove();
                container.innerHTML = `<i class="bi bi-person-fill"></i>`;
            };
            container.appendChild(img);
        } else {
            container.innerHTML = `<i class="bi bi-person-fill"></i>`;
        }
    }

    updateChatHeader(displayName, pictureUrl) {
        document.getElementById("chatHeaderName").textContent = displayName;
        const headerAvatar = document.querySelector("#chatScreen .avatar");
        this._renderAvatarInto(headerAvatar, pictureUrl);
    }

    renderSavedAccounts(accounts, onAccountClick, onDeleteClick) {
        const listEl = document.getElementById("savedAccountsList");
        const sectionEl = document.getElementById("savedAccountsSection");
        
        if (accounts.length === 0) {
            sectionEl.style.display = "none";
            return;
        }
        
        sectionEl.style.display = "block";
        listEl.innerHTML = "";
        
        accounts.forEach(acc => {
            const item = document.createElement("div");
            item.className = `account-item${acc.locked ? ' account-locked' : ''}`;
            const icon = acc.method === 'nip07' ? '<i class="bi bi-puzzle-fill text-warning me-2"></i>' : '<i class="bi bi-key-fill text-purple me-2"></i>';
            const lockState = acc.locked ? '<i class="bi bi-lock-fill text-muted ms-2" title="Trezor je zamčený"></i>' : '';
            item.innerHTML = `
                <div>${icon} <span class="fw-bold text-dark" style="font-size: 0.85rem;">Účet ${Utils.escapeHTML(acc.label)}</span>${lockState}</div>
                <button class="btn btn-sm btn-link text-danger p-0 delete-acc-btn"><i class="bi bi-x-circle"></i></button>
            `;
            
            item.addEventListener("click", (e) => {
                if (e.target.closest('.delete-acc-btn')) return;
                onAccountClick(acc);
            });
            item.querySelector(".delete-acc-btn").addEventListener("click", (e) => {
                e.stopPropagation();
                onDeleteClick(acc.pubkey);
            });
            listEl.appendChild(item);
        });
    }

    renderContacts(contacts, onContactClick, onDeleteClick) {
        const list = document.getElementById("contactsList");
        list.innerHTML = "";
        
        if (contacts.length === 0) { 
            list.innerHTML = `<div class="p-4 text-center text-muted small">Historie je prázdná.</div>`; 
            return; 
        }
        
        contacts.forEach((contact) => {
            const item = document.createElement("div");
            item.className = "contact-item";
            const displayName = contact.name || "Neznámý kontakt";

            item.innerHTML = `
                <div class="avatar"></div>
                <div style="flex:1; min-width: 0;">
                    <div class="contact-name text-truncate">${Utils.escapeHTML(displayName)}</div>
                    <div class="contact-npub text-truncate">${Utils.escapeHTML(contact.npub)}</div>
                </div>
                <button class="btn btn-link text-muted p-0 ms-2 delete-btn"><i class="bi bi-trash"></i></button>
            `;
            this._renderAvatarInto(item.querySelector(".avatar"), contact.picture);

            item.addEventListener("click", () => onContactClick(contact.npub, displayName, contact.picture));
            item.querySelector('.delete-btn').addEventListener("click", (e) => {
                e.stopPropagation();
                onDeleteClick(contact.npub);
            });
            list.appendChild(item);
        });
    }

    renderMessages(messages) {
        this.chatWindow.innerHTML = ''; 
        messages.forEach(msg => {
            const timeStr = new Date(msg.timestamp * 1000).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
            const bubble = document.createElement("div");
            bubble.className = `msg-bubble shadow-sm ${msg.isMe ? 'msg-out' : 'msg-in'}`;
            bubble.innerHTML = `<div>${Utils.escapeHTML(msg.text)}</div><span class="time-stamp">${timeStr}</span>`;
            this.chatWindow.appendChild(bubble);
        });
        this.chatWindow.scrollTop = this.chatWindow.scrollHeight;
    }

    renderRelays(relaysArray, onRemoveRelay) {
        const listUI = document.getElementById("relayListUI"); 
        listUI.innerHTML = "";
        relaysArray.forEach((url, index) => {
            const li = document.createElement("li"); 
            li.className = "list-group-item d-flex justify-content-between align-items-center small py-2 px-2 border-bottom";
            li.innerHTML = `
                <span>${Utils.escapeHTML(url)}</span> 
                <button class="btn btn-link text-secondary p-0 remove-relay-btn" data-index="${index}"><i class="bi bi-x-circle-fill"></i></button>
            `;
            listUI.appendChild(li);
        });
        listUI.querySelectorAll(".remove-relay-btn").forEach(btn => {
            btn.addEventListener("click", (e) => onRemoveRelay(e.currentTarget.getAttribute("data-index")));
        });
    }
}
