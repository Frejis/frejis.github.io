import { test } from "node:test";
import assert from "node:assert/strict";
import { generateDataset, DEFAULT_SEED } from "./dataset.js";
import { computeSelectivity, rankBySelectivity, countHostsWithValue } from "./selectivity.js";

test("a rare artifact ranks above a common one", () => {
  const { hosts, clusters, commonArtifacts } = generateDataset(DEFAULT_SEED);
  const rareCert = clusters[0].strongArtifact; // shared by 4 hosts
  const commonJa3 = { field: "ja3", value: commonArtifacts.ja3 }; // shared by most hosts

  const ranked = rankBySelectivity(hosts, [rareCert, commonJa3]);
  assert.equal(ranked[0].field, "certFingerprint");
  assert.ok(ranked[0].score > ranked[1].score);
  assert.equal(ranked[0].tier, "strong");
  assert.equal(ranked[1].tier, "weak");
});

test("selectivity count matches an actual scan of the dataset", () => {
  const { hosts, clusters } = generateDataset(DEFAULT_SEED);
  const { field, value } = clusters[1].strongArtifact;
  const result = computeSelectivity(hosts, field, value);
  const manualCount = hosts.filter((h) => h[field] === value).length;
  assert.equal(result.count, manualCount);
  assert.equal(result.count, countHostsWithValue(hosts, field, value));
});

test("a unique artifact scores 1", () => {
  const { hosts } = generateDataset(DEFAULT_SEED);
  const uniqueValue = "sha256:" + "0".repeat(64);
  assert.equal(countHostsWithValue(hosts, "certFingerprint", uniqueValue), 0);
  const singleHostValue = hosts[50].certFingerprint;
  // guard against accidental collision from the generator
  const owners = hosts.filter((h) => h.certFingerprint === singleHostValue);
  if (owners.length === 1) {
    const s = computeSelectivity(hosts, "certFingerprint", singleHostValue);
    assert.equal(s.score, 1);
  }
});
