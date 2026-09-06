import { test } from "node:test";
import assert from "node:assert/strict";
import { generateDataset, DEFAULT_SEED } from "./dataset.js";
import { createSession, applyPivot, undoPivot, hostsSharingArtifact } from "./pivot.js";

const { hosts, clusters, commonArtifacts } = generateDataset(DEFAULT_SEED);
const byName = Object.fromEntries(clusters.map((c) => [c.name, c]));

test("every planted cluster is reachable by pivoting from one of its members", () => {
  for (const cluster of clusters) {
    const startId = cluster.hostIds[0];
    let session = createSession(startId);
    session = applyPivot(session, hosts, cluster.strongArtifact.field, cluster.strongArtifact.value);
    for (const hostId of cluster.hostIds) {
      if (hostId === cluster.bridgeHostId && cluster.bridgeArtifact) {
        // a bridge host needs a second pivot on the bridge artifact - verify that
        // explicitly instead of skipping it
        assert.ok(!session.selected.includes(hostId), `${cluster.name} bridge ${hostId} should not appear from the strong pivot alone`);
        const bridged = applyPivot(session, hosts, cluster.bridgeArtifact.field, cluster.bridgeArtifact.value);
        assert.ok(bridged.selected.includes(hostId), `${cluster.name} bridge ${hostId} not found after pivoting on the bridge artifact`);
        continue;
      }
      assert.ok(session.selected.includes(hostId), `${cluster.name} member ${hostId} not found`);
    }
  }
});

test("a bridge host only appears after pivoting on the connecting artifact", () => {
  const cluster = byName["ring-alpha"];
  let session = createSession(cluster.hostIds[0]);
  session = applyPivot(session, hosts, cluster.strongArtifact.field, cluster.strongArtifact.value);
  assert.ok(!session.selected.includes(cluster.bridgeHostId), "bridge should not appear from the cert pivot alone");

  session = applyPivot(session, hosts, cluster.bridgeArtifact.field, cluster.bridgeArtifact.value);
  assert.ok(session.selected.includes(cluster.bridgeHostId), "bridge should appear after pivoting on the shared SSH key");
});

test("pivoting on a highly selective artifact returns exactly the expected hosts", () => {
  const cluster = byName["ca-gamma"];
  const { field, value } = cluster.strongArtifact;
  const matches = hostsSharingArtifact(hosts, field, value);
  const expected = hosts.filter((h) => h.certIssuer === "CN=umbra-ca.invalid").map((h) => h.id);
  assert.deepEqual([...matches].sort((a, b) => a - b), [...expected].sort((a, b) => a - b));
  assert.equal(matches.length, 4);
});

test("pivoting on a low-selectivity artifact drags in unrelated noise hosts", () => {
  const session0 = createSession(0);
  const session = applyPivot(session0, hosts, "ja3", commonArtifacts.ja3);
  const step = session.steps[0];

  assert.equal(step.selectivity.tier, "weak");

  // Exact, seed-derived expectation, not just "a lot": with DEFAULT_SEED the
  // common JA3 overlay lands on these 53 hosts (host 0 is the start host, so
  // it isn't counted as "added").
  const expectedAdded = [
    1, 2, 3, 9, 11, 13, 15, 16, 17, 19, 24, 25, 26, 27, 29, 31, 33, 35, 39, 40,
    41, 42, 43, 44, 45, 48, 50, 53, 55, 58, 59, 61, 62, 64, 65, 67, 69, 70, 71,
    73, 74, 76, 77, 79, 82, 83, 84, 85, 86, 87, 88, 89,
  ];
  assert.deepEqual([...step.addedIds].sort((a, b) => a - b), expectedAdded);

  // A handful of specific, previously-verified noise hosts (no planted
  // cluster membership) must be dragged in - not just "more than zero".
  const namedNoiseHosts = [19, 24, 40, 55, 89];
  for (const id of namedNoiseHosts) {
    assert.equal(hosts[id].cluster, null, `host ${id} was expected to be unrelated noise`);
    assert.ok(step.addedIds.includes(id), `noise host ${id} should be pulled in by the common JA3 pivot`);
  }
});

test("pivot history can be rolled back to the exact previous selection", () => {
  const cluster = byName["botnet-beta"];
  let session = createSession(cluster.hostIds[0]);
  const afterStart = session.selected.slice().sort((a, b) => a - b);

  session = applyPivot(session, hosts, cluster.strongArtifact.field, cluster.strongArtifact.value);
  const afterFirstPivot = session.selected.slice().sort((a, b) => a - b);

  session = applyPivot(session, hosts, cluster.bridgeArtifact.field, cluster.bridgeArtifact.value);
  assert.notDeepEqual(session.selected.slice().sort((a, b) => a - b), afterFirstPivot);

  session = undoPivot(session, hosts, cluster.hostIds[0]);
  assert.deepEqual(session.selected.slice().sort((a, b) => a - b), afterFirstPivot);

  session = undoPivot(session, hosts, cluster.hostIds[0]);
  assert.deepEqual(session.selected.slice().sort((a, b) => a - b), afterStart);
});
