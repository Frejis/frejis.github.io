import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateKey,
  exportKeyRaw,
  importKeyRaw,
  encryptText,
  decryptText,
  buildShareLink,
  parseShareLink,
  bytesToBase64url,
  base64urlToBytes,
  FakeServer,
} from "./sealed.js";

test("encrypt/decrypt round-trips the plaintext", async () => {
  const key = await generateKey();
  const plaintext = "the quick brown fox jumps over the lazy dog";
  const { ciphertext, iv } = await encryptText(key, plaintext);
  const out = await decryptText(key, ciphertext, iv);
  assert.equal(out, plaintext);
});

test("decrypting with the wrong key fails", async () => {
  const key = await generateKey();
  const wrongKey = await generateKey();
  const { ciphertext, iv } = await encryptText(key, "top secret");
  await assert.rejects(() => decryptText(wrongKey, ciphertext, iv));
});

test("tampered ciphertext throws instead of returning garbage", async () => {
  const key = await generateKey();
  const { ciphertext, iv } = await encryptText(key, "do not modify me");
  const bytes = base64urlToBytes(ciphertext);
  bytes[0] ^= 0x01;
  const tampered = bytesToBase64url(bytes);
  await assert.rejects(() => decryptText(key, tampered, iv));
});

test("share link build/parse round-trips id and key", async () => {
  const key = await generateKey();
  const keyB64 = await exportKeyRaw(key);
  const link = buildShareLink("https://example.com/note.html", "abc-123", keyB64);
  const parsed = parseShareLink(link);
  assert.equal(parsed.id, "abc-123");
  assert.equal(parsed.keyB64, keyB64);
});

test("exported key can be re-imported and still decrypts", async () => {
  const key = await generateKey();
  const keyB64 = await exportKeyRaw(key);
  const importedKey = await importKeyRaw(keyB64);
  const { ciphertext, iv } = await encryptText(key, "roundtrip via import");
  const out = await decryptText(importedKey, ciphertext, iv);
  assert.equal(out, "roundtrip via import");
});

test("burn-after-reading deletes the row on first read", async () => {
  const server = new FakeServer();
  const key = await generateKey();
  const { ciphertext, iv } = await encryptText(key, "read me once");
  const id = server.put({ ciphertext, iv, burn: true });

  const first = server.get(id);
  assert.ok(first, "row should exist on first read");
  const second = server.get(id);
  assert.equal(second, null, "row should be gone after burn read");
});

test("a non-burn row survives repeated reads", async () => {
  const server = new FakeServer();
  const key = await generateKey();
  const { ciphertext, iv } = await encryptText(key, "read me many times");
  const id = server.put({ ciphertext, iv, burn: false });

  assert.ok(server.get(id));
  assert.ok(server.get(id));
});

test("tamper() flips the stored ciphertext so decryption fails", async () => {
  const server = new FakeServer();
  const key = await generateKey();
  const { ciphertext, iv } = await encryptText(key, "attack me");
  const id = server.put({ ciphertext, iv, burn: false });

  server.tamper(id);
  const row = server.get(id);
  assert.notEqual(row.ciphertext, ciphertext);
  await assert.rejects(() => decryptText(key, row.ciphertext, row.iv));
});

test("the stored record contains none of the plaintext bytes", async () => {
  const server = new FakeServer();
  const key = await generateKey();
  const plaintext = "sk-live-4f9a2b1c-do-not-leak-this-string";
  const { ciphertext, iv } = await encryptText(key, plaintext);
  const id = server.put({ ciphertext, iv, burn: false });

  const row = server.get(id);
  const serialized = JSON.stringify(row);
  assert.equal(serialized.includes(plaintext), false);
  // and none of its ASCII bytes appear as a contiguous run either
  for (let i = 0; i < plaintext.length - 4; i++) {
    assert.equal(serialized.includes(plaintext.slice(i, i + 5)), false);
  }
});

test("list() returns rows newest first", async () => {
  const server = new FakeServer();
  const key = await generateKey();
  const a = await encryptText(key, "first");
  const idA = server.put({ ...a, burn: false });
  await new Promise((r) => setTimeout(r, 2));
  const b = await encryptText(key, "second");
  const idB = server.put({ ...b, burn: false });

  const rows = server.list();
  assert.equal(rows[0].id, idB);
  assert.equal(rows[1].id, idA);
});
