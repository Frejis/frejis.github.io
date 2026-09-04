// sealed.js — pure logic, no DOM. Importable by both the browser and Node.
// Node 24 exposes WebCrypto as the global `crypto`, same object the browser gives us.

const ALGO = "AES-GCM";
const KEY_LEN_BITS = 256;
const IV_LEN_BYTES = 12; // recommended IV length for AES-GCM

// ---------- base64url helpers ----------
// URL fragments and query strings dislike '+', '/', '=' — base64url avoids all three.

export function bytesToBase64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlToBytes(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ---------- key handling ----------

export async function generateKey() {
  return crypto.subtle.generateKey({ name: ALGO, length: KEY_LEN_BITS }, true, [
    "encrypt",
    "decrypt",
  ]);
}

export async function exportKeyRaw(key) {
  const raw = await crypto.subtle.exportKey("raw", key);
  return bytesToBase64url(new Uint8Array(raw));
}

export async function importKeyRaw(base64url) {
  const raw = base64urlToBytes(base64url);
  return crypto.subtle.importKey("raw", raw, ALGO, true, ["encrypt", "decrypt"]);
}

// ---------- encrypt / decrypt ----------
// Returns/accepts base64url text so the result is transport- and storage-safe
// (fine to put in a table cell, a URL, or JSON) without a separate encoding step.

export async function encryptText(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN_BYTES));
  const data = new TextEncoder().encode(plaintext);
  const cipherBuf = await crypto.subtle.encrypt({ name: ALGO, iv }, key, data);
  return {
    ciphertext: bytesToBase64url(new Uint8Array(cipherBuf)),
    iv: bytesToBase64url(iv),
  };
}

/**
 * Throws (DOMException, "OperationError") when the GCM authentication tag
 * does not match — wrong key, wrong IV, or tampered ciphertext. There is no
 * "decrypt to garbage" outcome with AEAD: it fails loudly or not at all.
 */
export async function decryptText(key, ciphertextB64, ivB64) {
  const iv = base64urlToBytes(ivB64);
  const cipherBytes = base64urlToBytes(ciphertextB64);
  const plainBuf = await crypto.subtle.decrypt({ name: ALGO, iv }, key, cipherBytes);
  return new TextDecoder().decode(plainBuf);
}

// ---------- share links ----------
// The key lives in the URL *fragment* (after #), never the query string or path.
// Fragments are stripped by the browser before the request line is built, so
// they never reach the server, any proxy, or an access log. That is the whole
// trick that lets a link carry the decryption key safely.

export function buildShareLink(baseUrl, id, keyB64) {
  const url = new URL(baseUrl);
  url.hash = `k=${keyB64}`;
  url.searchParams.set("id", id);
  return url.toString();
}

export function parseShareLink(href) {
  const url = new URL(href);
  const id = url.searchParams.get("id");
  const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const params = new URLSearchParams(hash);
  const key = params.get("k");
  if (!id || !key) throw new Error("not a valid share link: missing id or key");
  return { id, keyB64: key };
}

// ---------- fake server ----------
// An in-memory store standing in for the C#/Azure backend this was originally
// scoped as. It only ever sees ciphertext, an IV, and metadata — see the
// "record contains none of the plaintext" test in sealed.test.js.

export class FakeServer {
  constructor(storageKey) {
    this.storageKey = storageKey || null;
    this.rows = new Map();
    this._load();
  }

  _load() {
    if (!this.storageKey || typeof localStorage === "undefined") return;
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      for (const row of parsed) this.rows.set(row.id, row);
    } catch {
      // corrupt/unavailable storage — start empty rather than throw
    }
  }

  _save() {
    if (!this.storageKey || typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(this.storageKey, JSON.stringify([...this.rows.values()]));
    } catch {
      // storage full/unavailable — the in-memory copy still works this session
    }
  }

  put({ ciphertext, iv, burn }) {
    const id = crypto.randomUUID();
    const row = { id, ciphertext, iv, createdAt: Date.now(), burn: !!burn };
    this.rows.set(id, row);
    this._save();
    return id;
  }

  /** Returns a copy of the row, or null if absent. Deletes it first if burn is set. */
  get(id) {
    const row = this.rows.get(id);
    if (!row) return null;
    const copy = { ...row };
    if (row.burn) {
      this.rows.delete(id);
      this._save();
    }
    return copy;
  }

  delete(id) {
    const existed = this.rows.delete(id);
    if (existed) this._save();
    return existed;
  }

  list() {
    return [...this.rows.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Flips one bit of the stored ciphertext in place, simulating corruption/attack. */
  tamper(id) {
    const row = this.rows.get(id);
    if (!row) return false;
    const bytes = base64urlToBytes(row.ciphertext);
    bytes[0] ^= 0x01;
    row.ciphertext = bytesToBase64url(bytes);
    this._save();
    return true;
  }

  clear() {
    this.rows.clear();
    this._save();
  }
}
