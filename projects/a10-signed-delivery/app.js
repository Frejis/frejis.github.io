// DOM wiring only. All logic lives in signing.js / trust-chain.js / demo-data.js.
import { signMessage, verifyMessage, tamperMessage, tamperSignatureHex } from './signing.js';
import { validateChain, REASONS } from './trust-chain.js';
import { issueCertificate } from './trust-chain.js';
import { DEFAULT_MESSAGE, buildDefaultSigner, buildDefaultChain } from './demo-data.js';

const state = {
  signer: null,
  message: DEFAULT_MESSAGE,
  signatureHex: null,
  verifyKeyHex: null, // which public key part 1 currently verifies against
  chain: null,
  trustedRootKeyHexes: null,
  chainKeys: null,
  attacksApplied: new Set(),
};

const el = {
  message: document.getElementById('message'),
  signBtn: document.getElementById('sign-btn'),
  signatureOut: document.getElementById('signature-out'),
  publicKeyOut: document.getElementById('public-key-out'),
  verifyResult: document.getElementById('verify-result'),
  verifyExplain: document.getElementById('verify-explain'),
  attackMessage: document.getElementById('attack-message'),
  attackSignature: document.getElementById('attack-signature'),
  attackKey: document.getElementById('attack-key'),
  resetPart1: document.getElementById('reset-part1'),
  chainDiagram: document.getElementById('chain-diagram'),
  chainResult: document.getElementById('chain-result'),
  breakRoot: document.getElementById('break-root'),
  expireCert: document.getElementById('expire-cert'),
  untrustRoot: document.getElementById('untrust-root'),
  resetPart2: document.getElementById('reset-part2'),
};

function reasonSentence(reason, link, chain) {
  switch (reason) {
    case REASONS.BAD_SIGNATURE:
      return `${chain[link].subject}'s certificate is signed by ${chain[link].issuer}, but that signature no longer matches. Someone changed a byte after it was issued.`;
    case REASONS.EXPIRED:
      return `${chain[link].subject}'s certificate carries a mathematically valid signature, but its validity window has passed (${chain[link].notBefore.slice(0, 10)} to ${chain[link].notAfter.slice(0, 10)}). A correct signature does not mean "still allowed".`;
    case REASONS.UNTRUSTED_ROOT:
      return `${chain[link].subject} signed itself correctly, but it is not on this browser's list of roots it trusts. Anyone can self-sign a root; trust has to be decided separately.`;
    default:
      return 'This link checks out: the signature matches and the certificate is within its validity window.';
  }
}

async function renderPart1() {
  el.publicKeyOut.textContent = state.signer.publicKeyHex;
  el.signatureOut.textContent = state.signatureHex ?? '(not signed yet)';
  if (!state.signatureHex) {
    el.verifyResult.innerHTML = '';
    el.verifyExplain.textContent = '';
    return;
  }
  const valid = await verifyMessage(state.verifyKeyHex, state.message, state.signatureHex);
  el.verifyResult.innerHTML = valid
    ? '<span class="tag good">valid</span>'
    : '<span class="tag bad">invalid</span>';

  if (valid) {
    el.verifyExplain.textContent = 'The message is exactly what was signed, and the signature matches the sender\'s public key.';
  } else if (state.attacksApplied.has('message')) {
    el.verifyExplain.textContent = 'The message was changed after signing. The signature is a fingerprint of the exact bytes signed; different bytes, different fingerprint, so verification fails.';
  } else if (state.attacksApplied.has('signature')) {
    el.verifyExplain.textContent = 'A byte in the signature itself was flipped. The signature no longer decodes to a value that matches the message under this key.';
  } else if (state.attacksApplied.has('key')) {
    el.verifyExplain.textContent = 'The signature was checked against a different person\'s public key. Only the matching private key could have produced a signature this key accepts.';
  } else {
    el.verifyExplain.textContent = 'Verification failed.';
  }
}

async function signCurrentMessage() {
  state.signatureHex = await signMessage(state.signer.keyPair.privateKey, state.message);
  state.verifyKeyHex = state.signer.publicKeyHex;
  state.attacksApplied.clear();
  await renderPart1();
}

function renderChain() {
  const { chain, trustedRootKeyHexes, lastResult } = state;
  const links = lastResult ? lastResult.links : chain.map((c, i) => ({ index: i, subject: c.subject, valid: true, reason: REASONS.OK }));

  el.chainDiagram.innerHTML = chain
    .map((cert, i) => {
      const link = links[i];
      const trustedTag = i === 0
        ? (trustedRootKeyHexes.includes(cert.publicKeyHex) ? '<span class="tag good">trusted root</span>' : '<span class="tag bad">untrusted</span>')
        : '';
      const statusTag = link.valid ? '<span class="tag good">ok</span>' : '<span class="tag bad">broken</span>';
      const arrow = i > 0 ? '<div class="chain-arrow">&#8595; signs &#8595;</div>' : '';
      return `${arrow}<div class="cert-box${link.valid ? '' : ' cert-broken'}">
        <div class="spread"><strong>${cert.subject}</strong>${statusTag}</div>
        <div class="faint">issued by ${cert.issuer}</div>
        <div class="faint">valid ${cert.notBefore.slice(0, 10)} &#8594; ${cert.notAfter.slice(0, 10)}</div>
        ${trustedTag}
      </div>`;
    })
    .join('');

  if (!lastResult) {
    el.chainResult.innerHTML = '<span class="tag good">chain valid</span> every certificate is correctly signed, in date, and rooted in a trusted CA.';
    return;
  }

  if (lastResult.valid) {
    el.chainResult.innerHTML = '<span class="tag good">chain valid</span> every certificate is correctly signed, in date, and rooted in a trusted CA.';
    return;
  }

  const brokenLink = lastResult.links.find((l) => !l.valid);
  el.chainResult.innerHTML = `<span class="tag bad">chain broken at "${brokenLink.subject}"</span> ${reasonSentence(brokenLink.reason, brokenLink.index, chain)}`;
}

async function revalidateChain() {
  state.lastResult = await validateChain(state.chain, state.trustedRootKeyHexes);
  renderChain();
}

async function applyBreakRoot() {
  const root = state.chain[0];
  const sig = root.signatureHex;
  root.signatureHex = sig.slice(0, -2) + (sig.slice(-2) === '00' ? '01' : '00');
  await revalidateChain();
}

async function applyExpireCert() {
  const intermediate = state.chain[1];
  const reissued = await issueCertificate({
    subject: intermediate.subject,
    issuer: intermediate.issuer,
    notBefore: '2000-01-01T00:00:00.000Z',
    notAfter: '2000-06-01T00:00:00.000Z',
    publicKeyHex: intermediate.publicKeyHex,
    signerPrivateKey: state.chainKeys.rootKeys.privateKey,
  });
  state.chain[1] = reissued;
  await revalidateChain();
}

async function applyUntrustRoot() {
  state.trustedRootKeyHexes = [];
  await revalidateChain();
}

async function resetPart2() {
  const built = await buildDefaultChain();
  state.chain = built.chain;
  state.trustedRootKeyHexes = built.trustedRootKeyHexes;
  state.chainKeys = built.keys;
  state.lastResult = null;
  renderChain();
}

async function resetPart1() {
  state.message = DEFAULT_MESSAGE;
  el.message.value = state.message;
  state.attacksApplied.clear();
  await signCurrentMessage();
}

function wireEvents() {
  el.signBtn.addEventListener('click', async () => {
    state.message = el.message.value;
    await signCurrentMessage();
  });

  el.attackMessage.addEventListener('click', async () => {
    if (!state.signatureHex) return;
    state.message = tamperMessage(state.message);
    el.message.value = state.message;
    state.attacksApplied.clear();
    state.attacksApplied.add('message');
    await renderPart1();
  });

  el.attackSignature.addEventListener('click', async () => {
    if (!state.signatureHex) return;
    state.signatureHex = tamperSignatureHex(state.signatureHex);
    state.attacksApplied.clear();
    state.attacksApplied.add('signature');
    await renderPart1();
  });

  el.attackKey.addEventListener('click', async () => {
    if (!state.signatureHex) return;
    state.verifyKeyHex = state.signer.otherPartyPublicKeyHex;
    state.attacksApplied.clear();
    state.attacksApplied.add('key');
    await renderPart1();
  });

  el.resetPart1.addEventListener('click', resetPart1);

  el.breakRoot.addEventListener('click', applyBreakRoot);
  el.expireCert.addEventListener('click', applyExpireCert);
  el.untrustRoot.addEventListener('click', applyUntrustRoot);
  el.resetPart2.addEventListener('click', resetPart2);
}

async function init() {
  state.signer = await buildDefaultSigner();
  el.message.value = state.message;
  await signCurrentMessage();

  const built = await buildDefaultChain();
  state.chain = built.chain;
  state.trustedRootKeyHexes = built.trustedRootKeyHexes;
  state.chainKeys = built.keys;
  renderChain();

  wireEvents();
}

init();
