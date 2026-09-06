// Synthetic host dataset generation. Deterministic given a seed: no Math.random,
// no wall-clock, no network. Every field is manufactured, not observed.
//
// IP addresses are drawn from the RFC 5737 documentation ranges (192.0.2.0/24,
// 198.51.100.0/24, 203.0.113.0/24) and domain names use the RFC 2606 reserved
// TLDs (.test, .invalid, .example) so nothing here can collide with a real host.

import { mulberry32, randInt, pick, pickWeighted, hex } from "./prng.js";

export const DEFAULT_SEED = 0xc0ffee;
export const TOTAL_HOSTS = 90;

export const PIVOT_FIELDS = [
  {
    field: "certFingerprint",
    label: "Same TLS certificate",
    tech: "cert SHA-256 fingerprint",
    explain: "The same certificate file, byte for byte, served by both hosts.",
  },
  {
    field: "sshFingerprint",
    label: "Same SSH host key",
    tech: "SSH host key fingerprint",
    explain: "The key a server proves its identity with. Sharing one means the same disk image or the same admin.",
  },
  {
    field: "ja3",
    label: "Same TLS client fingerprint",
    tech: "JA3 hash",
    explain: "A fingerprint of how a machine opens an encrypted connection. It identifies the software, not the owner.",
  },
  {
    field: "faviconHash",
    label: "Same favicon",
    tech: "favicon hash",
    explain: "The icon in the browser tab, hashed. A match usually means the same admin panel deployed twice.",
  },
  {
    field: "certIssuer",
    label: "Same certificate issuer",
    tech: "cert issuer CN",
    explain: "Who signed the certificate. A private issuer is a real link, a public one is shared by millions.",
  },
  {
    field: "asn",
    label: "Same hosting provider",
    tech: "ASN",
    explain: "The network the server is rented from, identified by its routing number.",
  },
];

const IP_BLOCKS = ["192.0.2", "198.51.100", "203.0.113"];
const COUNTRIES = ["US", "NL", "DE", "RO", "SG", "BR", "SE", "UA", "IN", "CA"];
const PROVIDERS = [
  ["AS64512", "Nebula Cloud"],
  ["AS64513", "Solstice Hosting"],
  ["AS64514", "GreyRoute Networks"],
  ["AS64515", "Ferrous VPS"],
  ["AS64516", "Quokka Systems"],
  ["AS64517", "Palisade Colo"],
  ["AS64518", "Driftwood Data"],
];
const SERVER_HEADERS = [
  "nginx/1.18.0",
  "nginx/1.24.0",
  "Apache/2.4.41",
  "Apache/2.4.57",
  "cloudflare",
  "Microsoft-IIS/10.0",
  "openresty/1.21.4",
  "lighttpd/1.4.55",
];
const WORDS = [
  "orbit", "cinder", "harbor", "quartz", "ember", "relay", "vantage", "husk",
  "gable", "runnel", "thistle", "cobalt", "ferry", "moraine", "kestrel", "birch",
];
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function randIp(rng) {
  const block = pick(rng, IP_BLOCKS);
  return `${block}.${randInt(rng, 1, 254)}`;
}

function randDomain(rng) {
  const tld = pick(rng, ["test", "invalid", "example"]);
  return `${pick(rng, WORDS)}-${pick(rng, WORDS)}.${tld}`;
}

function randB64(rng, length) {
  let s = "";
  for (let i = 0; i < length; i++) s += B64[randInt(rng, 0, B64.length - 1)];
  return s;
}

function randSshFingerprint(rng) {
  return `SHA256:${randB64(rng, 43)}`;
}

function randCertFingerprint(rng) {
  return `sha256:${hex(rng, 64)}`;
}

function randJa3(rng) {
  return hex(rng, 32);
}

function randFaviconHash(rng) {
  return randInt(rng, -2147483648, 2147483647);
}

function randDate(rng, startDay, endDay) {
  // days offset from 2023-01-01, synthetic clock
  const day = randInt(rng, startDay, endDay);
  const d = new Date(Date.UTC(2023, 0, 1 + day));
  return d.toISOString().slice(0, 10);
}

function baseHost(rng, id) {
  const [asn, provider] = pick(rng, PROVIDERS);
  const firstSeen = randDate(rng, 0, 400);
  const lastSeenOffset = randInt(rng, 0, 120);
  return {
    id,
    ip: randIp(rng),
    asn,
    provider,
    country: pick(rng, COUNTRIES),
    certFingerprint: randCertFingerprint(rng),
    certSubject: `CN=${randDomain(rng)}`,
    certIssuer: `CN=${pick(rng, WORDS)}-ca.${pick(rng, ["test", "invalid"])}`,
    ja3: randJa3(rng),
    sshFingerprint: randSshFingerprint(rng),
    serverHeader: pick(rng, SERVER_HEADERS),
    faviconHash: randFaviconHash(rng),
    firstSeen,
    lastSeen: randDate(rng, 400 - lastSeenOffset < 0 ? 0 : 400, 500),
    cluster: null,
  };
}

// Common, low-value artifacts every generation run reuses on purpose: a JA3
// that is really just "whatever TLS library's default handshake looks like",
// and a cloud provider ASN half the internet sits behind. Pivoting on either
// should visibly drag in a pile of unrelated hosts.
function commonArtifacts(rng) {
  return {
    ja3Common: randJa3(rng),
    providerCommon: pick(rng, PROVIDERS),
  };
}

/**
 * Builds the dataset. Structure (which host indices land in which cluster,
 * which artifacts they share) is fixed code, not randomised - only the
 * concrete artifact *values* and the noise-host fields come from the rng.
 * That keeps "does pivoting find cluster X" testable without depending on
 * random placement.
 */
export function generateDataset(seed = DEFAULT_SEED) {
  const rng = mulberry32(seed);
  const { ja3Common, providerCommon } = commonArtifacts(rng);
  const hosts = [];

  for (let i = 0; i < TOTAL_HOSTS; i++) {
    hosts.push(baseHost(rng, i));
  }

  // Roughly 60% of hosts run the "everyone has this" JA3. Assigned after
  // generation so it overlays cleanly on top of already-built noise hosts.
  for (const h of hosts) {
    if (rng() < 0.6) h.ja3 = ja3Common;
  }

  const clusters = [];

  // Cluster A - "Ring Alpha": bulletproof-hosting ring. Four hosts share both
  // a self-signed cert fingerprint and an SSH host key (strong, two-artifact
  // corroboration). A fifth host only shares the SSH key - it drops out if
  // you pivot on the cert alone, and only surfaces on the second pivot.
  {
    const idx = [0, 1, 2, 3, 4];
    const cf = randCertFingerprint(rng);
    const sk = randSshFingerprint(rng);
    for (const i of idx.slice(0, 4)) {
      hosts[i].certFingerprint = cf;
      hosts[i].sshFingerprint = sk;
      hosts[i].certSubject = "CN=internal-relay.invalid";
      hosts[i].cluster = "ring-alpha";
    }
    hosts[idx[4]].sshFingerprint = sk;
    hosts[idx[4]].cluster = "ring-alpha";
    clusters.push({
      name: "ring-alpha",
      hostIds: idx,
      strongArtifact: { field: "certFingerprint", value: cf },
      bridgeArtifact: { field: "sshFingerprint", value: sk },
      bridgeHostId: idx[4],
      note: "shared self-signed cert + SSH host key; one host only shares the key",
    });
  }

  // Cluster B - "Botnet Beta": three hosts share a distinctive favicon
  // (default admin panel) and server header. A fourth host shares nothing
  // with those three except a rare custom JA3 with exactly one of them -
  // a one-artifact bridge that only pivoting reveals.
  {
    const core = [5, 6, 7];
    const bridge = 8;
    const fh = randFaviconHash(rng);
    const sh = "openresty/1.21.4";
    const ja3Rare = randJa3(rng);
    for (const i of core) {
      hosts[i].faviconHash = fh;
      hosts[i].serverHeader = sh;
      hosts[i].cluster = "botnet-beta";
    }
    hosts[core[0]].ja3 = ja3Rare;
    hosts[bridge].ja3 = ja3Rare;
    hosts[bridge].cluster = "botnet-beta";
    clusters.push({
      name: "botnet-beta",
      hostIds: [...core, bridge],
      strongArtifact: { field: "faviconHash", value: fh },
      bridgeArtifact: { field: "ja3", value: ja3Rare },
      bridgeHostId: bridge,
      bridgeViaHostId: core[0],
      note: "shared favicon + server header; the fourth host only shares a rare JA3 with one member",
    });
  }

  // Cluster C - "Shared CA Gamma": four hosts issued by the same private CA
  // (an unusual thing to share). A fifth host shares only an SSH host key
  // with one member of the group.
  {
    const core = [9, 10, 11, 12];
    const bridge = 13;
    const issuer = "CN=umbra-ca.invalid";
    const sk = randSshFingerprint(rng);
    for (const i of core) {
      hosts[i].certIssuer = issuer;
      hosts[i].cluster = "ca-gamma";
    }
    hosts[core[core.length - 1]].sshFingerprint = sk;
    hosts[bridge].sshFingerprint = sk;
    hosts[bridge].cluster = "ca-gamma";
    clusters.push({
      name: "ca-gamma",
      hostIds: [...core, bridge],
      strongArtifact: { field: "certIssuer", value: issuer },
      bridgeArtifact: { field: "sshFingerprint", value: sk },
      bridgeHostId: bridge,
      bridgeViaHostId: core[core.length - 1],
      note: "shared certificate issuer; the fifth host only shares an SSH key with one member",
    });
  }

  // Cluster D - "Delta Quiet": four hosts share only one artifact, an SSH
  // host key. A fifth host shares nothing with the core group except a rare
  // favicon with one member - same bridge shape as the other three clusters.
  {
    const idx = [14, 15, 16, 17];
    const bridge = 18;
    const sk = randSshFingerprint(rng);
    const fh = randFaviconHash(rng);
    for (const i of idx) {
      hosts[i].sshFingerprint = sk;
      hosts[i].cluster = "delta-quiet";
    }
    hosts[idx[idx.length - 1]].faviconHash = fh;
    hosts[bridge].faviconHash = fh;
    hosts[bridge].cluster = "delta-quiet";
    clusters.push({
      name: "delta-quiet",
      hostIds: [...idx, bridge],
      strongArtifact: { field: "sshFingerprint", value: sk },
      bridgeArtifact: { field: "faviconHash", value: fh },
      bridgeHostId: bridge,
      bridgeViaHostId: idx[idx.length - 1],
      note: "shared SSH host key; the fifth host only shares a favicon hash with one member",
    });
  }

  // The default landing host: a member of ring-alpha, so it carries both a
  // strong, selective artifact (the shared cert) and the common JA3 assigned
  // above - a deliberate contrast for the "weak pivot" demo.
  hosts[0].ja3 = ja3Common;
  // A visible slice of noise also sits behind the common provider ASN, on
  // top of the JA3 overlay, purely to give the "pivot on provider" option
  // some bulk to demonstrate against.
  for (const h of hosts) {
    if (h.cluster === null && rng() < 0.35) {
      h.asn = providerCommon[0];
      h.provider = providerCommon[1];
    }
  }

  return { seed, hosts, clusters, defaultHostId: 0, commonArtifacts: { ja3: ja3Common, provider: providerCommon } };
}
