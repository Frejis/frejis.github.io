import { test } from "node:test";
import assert from "node:assert/strict";
import { generateDataset, DEFAULT_SEED, TOTAL_HOSTS } from "./dataset.js";

test("generator is deterministic for a fixed seed", () => {
  const a = generateDataset(DEFAULT_SEED);
  const b = generateDataset(DEFAULT_SEED);
  assert.deepEqual(a.hosts, b.hosts);
  assert.deepEqual(a.clusters, b.clusters);
  assert.equal(a.defaultHostId, b.defaultHostId);
});

test("different seeds produce different datasets", () => {
  const a = generateDataset(1);
  const b = generateDataset(2);
  assert.notDeepEqual(a.hosts, b.hosts);
});

test("dataset has the expected host count", () => {
  const { hosts } = generateDataset(DEFAULT_SEED);
  assert.equal(hosts.length, TOTAL_HOSTS);
});

test("plants at least three clusters", () => {
  const { clusters } = generateDataset(DEFAULT_SEED);
  assert.ok(clusters.length >= 3);
  for (const c of clusters) {
    assert.ok(c.hostIds.length >= 3, `${c.name} should have at least 3 hosts`);
  }
});

test("every cluster has a bridge host reachable only by a second pivot", () => {
  const { hosts, clusters } = generateDataset(DEFAULT_SEED);
  for (const c of clusters) {
    assert.ok(c.bridgeArtifact, `${c.name} should have a bridge artifact`);
    assert.ok(typeof c.bridgeHostId === "number", `${c.name} should have a bridge host`);
    assert.ok(c.hostIds.includes(c.bridgeHostId), `${c.name}'s bridge host should be one of its members`);

    const bridgeHost = hosts[c.bridgeHostId];
    assert.notEqual(
      bridgeHost[c.strongArtifact.field],
      c.strongArtifact.value,
      `${c.name}'s bridge host should not carry the strong artifact - that's what makes it a bridge`,
    );
    assert.equal(
      bridgeHost[c.bridgeArtifact.field],
      c.bridgeArtifact.value,
      `${c.name}'s bridge host should carry the bridge artifact`,
    );
  }
});

test("every host has the required fields", () => {
  const { hosts } = generateDataset(DEFAULT_SEED);
  const required = [
    "id", "ip", "asn", "provider", "country", "certFingerprint", "certSubject",
    "certIssuer", "ja3", "sshFingerprint", "serverHeader", "faviconHash",
    "firstSeen", "lastSeen",
  ];
  for (const h of hosts) {
    for (const field of required) {
      assert.notEqual(h[field], undefined, `host ${h.id} missing ${field}`);
    }
  }
});

test("default landing host is a real, non-empty host in a cluster", () => {
  const { hosts, defaultHostId, clusters } = generateDataset(DEFAULT_SEED);
  const host = hosts[defaultHostId];
  assert.ok(host);
  const inACluster = clusters.some((c) => c.hostIds.includes(defaultHostId));
  assert.ok(inACluster, "default host should sit inside a planted cluster");
});
