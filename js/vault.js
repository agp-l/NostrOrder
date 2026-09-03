// js/vault.js
//
// Šifrovaný "trezor" pro privátní klíče uložené v localStorage (funkce "Uložené účty").
// Frontend v index.html tuto obrazovku už měl navrženou (#vaultSection), ale nic ji
// dosud nepoužívalo — účty se ukládaly jako čistý (nešifrovaný) nsec/hex do localStorage,
// tedy trvale a čitelně pro kohokoliv se přístupem k zařízení nebo přes XSS.
//
// Princip:
// - Heslo se NIKDY nikam neukládá. Slouží jen k odvození AES klíče (PBKDF2-SHA256).
// - Odvozený CryptoKey žije POUZE v paměti (proměnná v tomto modulu) a mizí při
//   zamčení trezoru nebo reloadu/zavření stránky (odhlášení dělá location.reload()).
// - V localStorage je jen sůl (salt) a šifrovaná data (IV + ciphertext), nikdy klíč ani heslo.
// - AES-GCM má vestavěnou autentizaci (auth tag) — dešifrování se špatným klíčem/heslem
//   spolehlivě selže výjimkou, což zároveň slouží jako ověření hesla.

const VAULT_META_KEY = "nostr_vault_meta_v1";
const PBKDF2_ITERATIONS = 210000; // OWASP doporučení (2023+) pro PBKDF2-SHA256

function toB64(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function fromB64(str) {
    return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}

class VaultService {
    constructor() {
        this._cryptoKey = null; // CryptoKey pouze v RAM, nikdy neserializujeme
    }

    /** Existuje už na tomto zařízení založený trezor (sůl uložená v localStorage)? */
    hasVault() {
        return !!localStorage.getItem(VAULT_META_KEY);
    }

    /** Je trezor v této relaci odemčený (máme klíč v paměti)? */
    isUnlocked() {
        return this._cryptoKey !== null;
    }

    /** Zamkne trezor — okamžitě zahodí klíč z paměti. */
    lock() {
        this._cryptoKey = null;
    }

    async _deriveKey(password, saltB64) {
        const enc = new TextEncoder();
        const salt = fromB64(saltB64);
        const baseKey = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
        return crypto.subtle.deriveKey(
            { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
            baseKey,
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"]
        );
    }

    /** Založí nový trezor s daným heslem a rovnou ho odemkne (pro aktuální relaci). */
    async createVault(password) {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const saltB64 = toB64(salt);
        this._cryptoKey = await this._deriveKey(password, saltB64);
        localStorage.setItem(VAULT_META_KEY, JSON.stringify({ salt: saltB64, v: 1 }));
    }

    /**
     * Odemkne existující trezor. Pokud je zadán `verifyPayload` (libovolný dřív
     * zašifrovaný záznam), pokusí se ho dešifrovat — chybný pokus = chybné heslo.
     */
    async unlock(password, verifyPayload) {
        const meta = JSON.parse(localStorage.getItem(VAULT_META_KEY) || "null");
        if (!meta) throw new Error("Trezor na tomto zařízení neexistuje.");
        const key = await this._deriveKey(password, meta.salt);
        if (verifyPayload) {
            await this._decryptWithKey(key, verifyPayload); // vyhodí výjimku při špatném hesle
        }
        this._cryptoKey = key;
        return true;
    }

    async encrypt(plainText) {
        if (!this._cryptoKey) throw new Error("Trezor je zamčený.");
        return this._encryptWithKey(this._cryptoKey, plainText);
    }

    async decrypt(payload) {
        if (!this._cryptoKey) throw new Error("Trezor je zamčený.");
        return this._decryptWithKey(this._cryptoKey, payload);
    }

    async _encryptWithKey(key, plainText) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const enc = new TextEncoder();
        const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plainText));
        return { iv: toB64(iv), data: toB64(cipherBuf) };
    }

    async _decryptWithKey(key, payload) {
        const iv = fromB64(payload.iv);
        const data = fromB64(payload.data);
        const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
        return new TextDecoder().decode(plainBuf);
    }
}

export const vault = new VaultService();
