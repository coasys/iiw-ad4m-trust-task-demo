import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { TYPE_URI, RESPONSE_TYPE_URI, PAYLOAD_SCHEMA, RESPONSE_PAYLOAD_SCHEMA } from '@openvtc/trust-tasks/acl/grant/0.2/payload';
import { ROOT, STATE, NS, uuid, shortId, loadOrCreateKey, sign, verifyProof, assertPayload, validator,
  checkReceiptHash, documentDigest, TRUST_TASK_ERROR_TYPE_URI, saveJson, readJson,
  args, isMain, emit, cliError, rel } from './common.mjs';

export async function request(options = {}) {
  const { signer, did } = loadOrCreateKey('requester');
  const recipient = options.recipient ?? readFileSync(resolve(STATE, 'space-did.txt'), 'utf8').trim();
  const doc = {
    id: uuid(), type: TYPE_URI, issuer: did, recipient,
    issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
    payload: { entry: {
      subject: options.subject ?? 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
      role: options.role ?? 'member',
      act: { scope: 'contexts', contexts: ['iiw-demo/notes'] },
      keys: { scope: 'none' }, capabilities: { scope: 'ceiling' }
    }, reason: 'IIW 43 demo: let Carol join the notes space' }
  };
  assertPayload(PAYLOAD_SCHEMA, doc.payload);
  const signed = sign(doc, signer);
  const out = resolve(ROOT, options.out ?? 'out/request.json');
  saveJson(out, signed);
  saveJson(resolve(STATE, 'requester-sent', shortId(doc.id) + '.json'), signed);
  return { doc: signed, path: out };
}
export function checkBinding(flowReceipt, sent) {
  try {
    const outputs = flowReceipt.receipt.outputs;
    const matches = outputs.filter(item => item.class_name === 'IiwTrustTaskRequest');
    if (matches.length !== 1) return false;
    const content = JSON.parse(matches[0].content);
    if (typeof content.raw !== 'string') return false;
    return documentDigest(JSON.parse(content.raw)) === documentDigest(sent);
  } catch { return false; }
}
export async function checkResponseProof(response, sent) {
  return (await verifyProof(response)).ok && response.proof?.cryptosuite === 'eddsa-jcs-2022'
    && response.issuer === sent.recipient;
}
export const checkRecipient = (response, ownDid) => response.recipient === ownDid;
export const checkCorrelation = (response, sent) => response.threadId === (sent.threadId ?? sent.id)
  && (response.payload?.inResponseTo?.id === undefined || response.payload.inResponseTo.id === sent.id);
export const checkKind = (response, sent) => response.type === sent.type.split('#')[0] + '#response'
  || response.type === TRUST_TASK_ERROR_TYPE_URI;
export function checkOutcome(response, flowReceipt) {
  return flowReceipt.terminalState === flowReceipt.receipt.terminal_state
    && flowReceipt.flow === flowReceipt.receipt.flow_uri
    && flowReceipt.flow === 'iiw://TrustTaskDecisionFlow'
    && (response.type === RESPONSE_TYPE_URI
      ? flowReceipt.terminalState === 'Accepted'
      : response.payload?.code === 'permissionDenied' && flowReceipt.terminalState === 'Rejected');
}
// A grant answer must hold exactly the entry that was asked for, in a schema-valid payload.
export const checkEntry = (response, sent) => validator.validate(RESPONSE_PAYLOAD_SCHEMA, response.payload).ok
  && isDeepStrictEqual(response.payload.entry, sent.payload.entry);
// Without a receipt, only the refusals the space makes before any flow are acceptable.
export const PRE_FLOW_CODES = ['malformedRequest', 'unsupportedType', 'proofInvalid', 'proofRequired',
  'wrongRecipient', 'expired', 'idConflict', 'identityMismatch'];
export const checkPreFlowError = response => {
  const payload = response.payload;
  return payload !== null && typeof payload === 'object' && typeof payload.code === 'string'
    && typeof payload.message === 'string' && typeof payload.retryable === 'boolean'
    && PRE_FLOW_CODES.includes(payload.code);
};
export async function verify(responseOrPath, options = {}) {
  const response = typeof responseOrPath === 'string' ? readJson(resolve(ROOT, responseOrPath)) : responseOrPath;
  let sent = options.request;
  if (typeof sent === 'string') sent = readJson(resolve(ROOT, sent));
  if (!sent) {
    // Default to the remembered original, never trust the response as the request.
    const hint = readJson(resolve(ROOT, 'out/request.json'));
    sent = readJson(resolve(STATE, 'requester-sent', shortId(hint.id) + '.json'));
  }
  const ownDid = loadOrCreateKey('requester').did;
  const checks = [
    { name: 'proof', ok: await checkResponseProof(response, sent) },
    { name: 'addressed to me', ok: checkRecipient(response, ownDid) },
    { name: 'thread', ok: checkCorrelation(response, sent) },
    { name: 'kind', ok: checkKind(response, sent) }
  ];
  const flowReceipt = response.payload?.ext?.[NS]?.flowReceipt ?? response.payload?.details?.[NS]?.flowReceipt;
  let refusedBeforeFlow = false;
  if (flowReceipt) {
    checks.push({ name: 'receipt hash', ok: checkReceiptHash(flowReceipt) });
    checks.push({ name: 'decided on my exact document', ok: checkBinding(flowReceipt, sent) });
    checks.push({ name: 'outcome', ok: checkOutcome(response, flowReceipt) });
    if (response.type !== TRUST_TASK_ERROR_TYPE_URI) checks.push({ name: 'entry as asked', ok: checkEntry(response, sent) });
  } else {
    refusedBeforeFlow = response.type === TRUST_TASK_ERROR_TYPE_URI && response.payload?.code !== 'permissionDenied';
    // Success and group-refusal responses must never silently lose their receipts.
    if (!refusedBeforeFlow) checks.push({ name: 'receipt present', ok: false });
    else checks.push({ name: 'error code', ok: checkPreFlowError(response) });
  }
  return { ok: checks.every(c => c.ok), checks, refusedBeforeFlow,
    code: response.payload?.code,
    limitation: "AD4M link signatures inside the receipt are not re-checked here; the space's node ran verifyFlowReceipt" };
}
if (isMain(import.meta.url)) {
  const { positional, options } = args(process.argv.slice(2));
  try {
    if (positional[0] === 'request') {
      const result = await request(options);
      emit(result, ['acl/grant/0.2 ' + result.doc.id + ' signed ' + result.doc.proof.cryptosuite
        + ' by ' + result.doc.issuer + ' → ' + rel(result.path)], options.json);
    } else if (positional[0] === 'verify') {
      // Default: the answer to the request in out/request.json (or --request).
      const responsePath = positional[1] ?? 'out/response-' + shortId(readJson(resolve(ROOT, options.request ?? 'out/request.json')).id) + '.json';
      const result = await verify(responsePath, { request: options.request });
      emit(result, [...result.checks.map(c => (c.ok ? '✓ ' : '✗ ') + c.name),
        ...(result.refusedBeforeFlow ? ['refused before any flow: ' + result.code] : []), result.limitation], options.json);
      if (!result.ok) process.exitCode = 1;
    } else throw new Error('Usage: requester.mjs request | verify [<response.json>] [--request <request.json>] [--json]');
  } catch (error) { cliError(error, options.json); }
}

