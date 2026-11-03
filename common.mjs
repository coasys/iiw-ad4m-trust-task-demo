import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { signerFromPrivateKey, didKeyFromPublicKey, signTrustTask, DataIntegrityProofVerifier } from '@openvtc/trust-tasks-proof';
export { documentDigest, TRUST_TASK_ERROR_TYPE_URI } from '@openvtc/trust-tasks/runtime';
export const ROOT = dirname(fileURLToPath(import.meta.url));
// npm test sets DEMO_STATE=.demo-test, so the tests never touch your own space in .demo/.
export const STATE = resolve(ROOT, process.env.DEMO_STATE ?? '.demo');
export const NS = 'org.coasys.ad4m';
export const FLOW = 'iiw://TrustTaskDecisionFlow';
export const uuid = () => 'urn:uuid:' + randomUUID();
// For printed lines only: paths relative to where the user ran the command; DIDs shortened.
export const rel = path => relative(process.cwd(), path) || path;
export const shortDid = did => did.length > 24 ? did.slice(0, 14) + '…' + did.slice(-4) : did;
export const shortId = id => id.replace(/^urn:uuid:/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
export const pathAt = name => resolve(ROOT, name);
export function stateDir() { mkdirSync(STATE, { recursive: true, mode: 0o700 }); chmodSync(STATE, 0o700); }
export function saveJson(path, value, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode });
  chmodSync(path, mode);
}
export const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
export function loadOrCreateKey(name) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('Invalid key name');
  stateDir();
  const path = resolve(STATE, name + '-key.json');
  let priv;
  try { priv = Buffer.from(readJson(path).privateKeyHex, 'hex'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    priv = ed25519.utils.randomSecretKey();
    saveJson(path, { privateKeyHex: Buffer.from(priv).toString('hex') });
  }
  const signer = signerFromPrivateKey('ed25519', priv);
  return { signer, did: signer.did ?? didKeyFromPublicKey('ed25519', ed25519.getPublicKey(priv)) };
}
export const sign = (doc, signer) => signTrustTask(doc, signer);
// Small, independently stub-able security checks; the live negative tests must fail if bypassed.
export async function verifyProof(doc) {
  try {
    const detail = await new DataIntegrityProofVerifier().verifyDetailed(doc);
    // The library accepts any non-empty proofPurpose; trust tasks are signed as assertions.
    return { ok: detail.valid === true && doc.proof?.proofPurpose === 'assertionMethod', detail };
  } catch { return { ok: false, detail: 'Proof verification threw' }; }
}
export const proofAdapter = { async verify(doc) { return (await verifyProof(doc)).ok; } };
// No format plugin is needed: add the schema's only format explicitly, rather than silently ignoring it.
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true });
ajv.addFormat('date-time', value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value)));
const compiled = new WeakMap();
export const validator = {
  validate(schema, payload) {
    let check = compiled.get(schema);
    if (!check) { check = ajv.compile(schema); compiled.set(schema, check); }
    const ok = check(payload);
    return { ok, errors: ok ? [] : check.errors.map(e => e.instancePath + ' ' + e.message) };
  }
};
export function assertPayload(schema, payload) {
  const verdict = validator.validate(schema, payload);
  if (!verdict.ok) throw new Error('Payload schema: ' + verdict.errors.join('; '));
}
// Rust sorts UTF-8 bytes, unlike JCS's UTF-16 sort. Do not reuse the trust-task canonicalizer.
// Matches AD4M's canonical_json for what receipts carry (strings, integers, arrays, objects);
// non-integer numbers would serialize differently. The live tests compare real receipt hashes.
export function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort((a,b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      .map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}
export const receiptSha256 = receipt => createHash('sha256').update(canonicalJson(receipt)).digest('hex');
export function checkReceiptHash(flowReceipt) {
  try {
    return !!flowReceipt && /^ad4m:\/\/flow\/receipt\/[a-f0-9]{64}$/.test(flowReceipt.uri)
      && receiptSha256(flowReceipt.receipt) === flowReceipt.sha256
      && flowReceipt.sha256 === flowReceipt.uri.split('/').at(-1);
  } catch { return false; }
}

// A slow answer kept in the background: get() never waits. It returns the last answer (or the
// fallback) and asks again at most once every `ttl` ms. A new key (another space) starts empty.
// The page polls the runs every 4 s; the space's members come from the link language, which can
// hang on a slow or dead link server, so the runs must not wait for them.
export function backgroundCache(load, { ttl = 60000, timeout = 30000, now = Date.now } = {}) {
  let key, value, at = -Infinity, pending = null;
  const refresh = () => {
    if (pending) return pending;
    const forKey = key;
    const timer = new Promise((_, fail) => setTimeout(() => fail(new Error('no answer')), timeout).unref?.());
    pending = Promise.race([Promise.resolve().then(() => load(forKey)), timer])
      .then(answer => { if (forKey === key) value = answer; }, () => {})
      .finally(() => { if (forKey === key) at = now(); pending = null; });
    return pending;
  };
  return {
    get(forKey, fallback) {
      if (forKey !== key) { key = forKey; value = undefined; at = -Infinity; }
      if (now() - at >= ttl) refresh();
      return value ?? fallback;
    },
    // Ask again soon: on the next get(), or now with refresh().
    stale() { at = -Infinity; },
    refresh
  };
}

export function args(argv) {
  const positional = [], options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const name = argv[i].slice(2);
      options[name] = ['json', 'force', 'links', 'remember'].includes(name) ? true : argv[++i];
      if (options[name] === undefined) throw new Error('Missing --' + name + ' value');
    } else positional.push(argv[i]);
  }
  return { positional, options };
}
export const isMain = url => process.argv[1] && resolve(process.argv[1]) === fileURLToPath(url);
export function emit(result, lines, json) { console.log(json ? JSON.stringify(result) : lines.join('\n')); }
export function cliError(error, json) {
  // Do not serialize RPC errors, causes or request objects: they can contain authorization data.
  const message = error instanceof Error ? error.message : String(error);
  console.error(json ? JSON.stringify({ ok: false, error: message }) : message);
  process.exitCode = error.exitCode ?? 1;
}

