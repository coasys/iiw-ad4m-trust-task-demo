import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { FlowInstance, PerspectiveProxy, AgentClient } from '@coasys/ad4m';
import { signTrustTask } from '@openvtc/trust-tasks-proof';
import { TYPE_URI, RESPONSE_TYPE_URI } from '@openvtc/trust-tasks/acl/grant/0.2/payload';
import { request, verify } from './requester.mjs';
import { agent, addUsers, makeSpace, openAs, receive, vote, respond, RequestModel, ResponseModel, runOn } from './demo.mjs';
import { ROOT, STATE, NS, uuid, shortId, loadOrCreateKey, sign, verifyProof, receiptSha256,
  checkReceiptHash, saveJson, readJson, TRUST_TASK_ERROR_TYPE_URI, backgroundCache } from './common.mjs';

// npm test runs in its own state folder (DEMO_STATE=.demo-test): your space in .demo/ is left alone.
const tutorialFiles = ['space.json', 'people.json', 'latest-task.txt'].map(name => resolve(ROOT, '.demo', name));
const tutorialBefore = tutorialFiles.map(path => existsSync(path) ? readFileSync(path, 'utf8') : null);
// Local mode: bob is this node's agent, the test's alice a user on it (a fresh name per state
// folder, so it never meets a user made from another folder). The node's agent must exist and be
// unlocked: run `node demo.mjs agent` first. The test never creates or unlocks it.
await agent({ as:'bob', noPrompt:true });
const known = existsSync(resolve(STATE, 'people.json')) ? readJson(resolve(STATE, 'people.json')) : {};
const alice = Object.keys(known).find(name => name.startsWith('alice-')) ?? 'alice-' + randomBytes(3).toString('hex');
await addUsers([alice]);
const space = await makeSpace({ as:alice });
assert.equal(space.owner, alice);
assert.deepEqual(Object.keys(space.uuids).sort(), [alice, 'bob'].sort());
const config = { aliceDid:space.people[alice].did, bobDid:space.people.bob.did, spaceDid:space.spaceDid };
// Both people of the local space at once.
const withContext = callback => openAs(alice, ({ p:pD }) => openAs('bob', ({ p:pS }) => callback({ pD, pS })));
assert.notEqual(config.aliceDid, config.bobDid);
let happy, accepted, declined, rejectedResponse;
const nodeSigner = loadOrCreateKey('space').signer;
const copy = value => structuredClone(value);
const resign = doc => { const unsigned = copy(doc); delete unsigned.proof; return sign(unsigned, nodeSigner); };
const receiptOf = doc => doc.payload.ext?.[NS]?.flowReceipt ?? doc.payload.details?.[NS]?.flowReceipt;
const rejectWithFor = (request, payload) => sign({ id:uuid(), type:TRUST_TASK_ERROR_TYPE_URI, issuer:config.spaceDid,
  recipient:request.issuer, threadId:request.id, issuedAt:new Date().toISOString(), payload }, nodeSigner);
const failed = result => result.checks.filter(check => !check.ok).map(check => check.name);
const snapshot = () => withContext(async ({ pD }) => ({
  requests:(await RequestModel.findAll(pD)).length,
  runs:(await FlowInstance.findAll(pD)).length,
  responses:(await ResponseModel.findAll(pD)).length
}));
async function fresh() {
  const made = await request({ out:'out/test-' + shortId(uuid()) + '.json' });
  return made;
}
async function alteredRequest(changes) {
  const made = await fresh();
  const unsigned = copy(made.doc); delete unsigned.proof;
  changes(unsigned);
  made.doc = sign(unsigned, loadOrCreateKey('requester').signer);
  saveJson(made.path, made.doc);
  return made;
}
function assertVerified(result, count) {
  assert.equal(result.ok, true, JSON.stringify(result.checks));
  assert.equal(result.checks.length, count);
  assert(result.checks.every(check => check.ok));
}
await test('happy path: lossless request, two distinct voters, minted receipt and requester verification', async () => {
  const before = await snapshot();
  happy = await fresh();
  // Exercise byte-for-byte storage with indentation and extra trailing whitespace.
  const raw = JSON.stringify(happy.doc, null, 4) + '\n \n';
  writeFileSync(happy.path, raw);
  const received = await receive(happy.path);
  assert.equal(received.kind, 'accepted');
  assert.equal(received.state, 'Received');
  assert.equal(received.lossless, true);
  const after = await snapshot();
  assert.equal(after.requests, before.requests + 1);
  assert.equal(after.runs, before.runs + 1);
  await withContext(async ({ pD }) => {
    const rows = await RequestModel.findAll(pD, { where:{ taskId:happy.doc.id } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].raw, raw);
    assert.deepEqual(JSON.parse(rows[0].raw), happy.doc);
    assert.equal((await runOn(pD, rows[0].id)).currentStateName, 'Received');
  });
  const first = await vote('accept', alice, { task:happy.doc.id, why:'Carol should join' });
  assert.equal(first.recordedVote, true);
  assert.equal(first.minted, true);
  assert.deepEqual(first.outcomes, []);
  assert.equal(first.derivedState, 'Received');
  assert.equal(first.contested, false);
  const second = await vote('accept', 'bob', { task:happy.doc.id, why:'Agreed' });
  assert.equal(second.recordedVote, true);
  assert.equal(second.minted, false);
  assert.equal(second.outcomes.length, 1);
  assert.equal(second.outcomes[0].fromState, 'Received');
  assert.equal(second.outcomes[0].toState, 'Accepted');
  assert.deepEqual(new Set(second.outcomes[0].voters), new Set([config.bobDid, config.aliceDid]));
  assert.equal(second.derivedState, 'Accepted');
  accepted = await respond({ task:happy.doc.id });
  assert.equal(accepted.verdict.outcome, 'verified');
  assert.equal(accepted.receiptHashMatch, true);
  assert.equal(accepted.response.type, RESPONSE_TYPE_URI);
  assert.equal(receiptSha256(receiptOf(accepted.response).receipt), accepted.receiptUri.split('/').at(-1));
  assertVerified(await verify(accepted.response, { request:happy.doc }), 8);
  // Appending a response child must leave the decided request a valid output.
  await withContext(async ({ pD }) => {
    const outputs = await pD.flowValidOutputs('iiw://TrustTaskDecisionFlow', 'Accepted');
    assert(outputs.some(output => output.output.id === received.requestId));
  });
});
await test('tampered request: proofInvalid, signed error, no stored request or flow', async () => {
  const made = await fresh();
  made.doc.payload.entry.role = 'admin';
  saveJson(made.path, made.doc);
  const before = await snapshot();
  const result = await receive(made.path);
  assert.equal(result.kind, 'rejected');
  assert.equal(result.code, 'proofInvalid');
  assert.deepEqual(await snapshot(), before);
  assert.equal((await verifyProof(result.error)).ok, true);
  assert.equal(result.error.issuer, config.spaceDid);
  const checked = await verify(result.error, { request:made.doc });
  assert.equal(checked.ok, true);
  assert.equal(checked.refusedBeforeFlow, true);
  assert.equal(checked.checks.length, 5);
});
await test('wrong recipient: wrongRecipient and no graph changes', async () => {
  const made = await alteredRequest(doc => { doc.recipient = loadOrCreateKey('carol').did; });
  const before = await snapshot();
  const result = await receive(made.path);
  assert.equal(result.kind, 'rejected');
  assert.equal(result.code, 'wrongRecipient');
  assert.equal((await verifyProof(result.error)).ok, true);
  assert.equal(result.error.issuer, config.spaceDid);
  assert.deepEqual(await snapshot(), before);
});
await test('expired request: expired and no graph changes', async () => {
  const made = await alteredRequest(doc => {
    doc.issuedAt = new Date(Date.now() - 7200000).toISOString();
    doc.expiresAt = new Date(Date.now() - 3600000).toISOString();
  });
  const before = await snapshot();
  const result = await receive(made.path);
  assert.equal(result.kind, 'rejected');
  assert.equal(result.code, 'expired');
  assert.equal((await verifyProof(result.error)).ok, true);
  assert.deepEqual(await snapshot(), before);
});
await test('reject path: one decider, Rejected receipt, permissionDenied and requester verification', async () => {
  declined = await fresh();
  assert.equal((await receive(declined.path)).kind, 'accepted');
  const rejected = await vote('reject', alice, { task:declined.doc.id, why:'Not for this space' });
  assert.equal(rejected.recordedVote, true);
  assert.equal(rejected.outcomes.length, 1);
  assert.equal(rejected.outcomes[0].fromState, 'Received');
  assert.equal(rejected.outcomes[0].toState, 'Rejected');
  assert.deepEqual(rejected.outcomes[0].voters, [config.aliceDid]);
  assert.equal(rejected.derivedState, 'Rejected');
  const result = rejectedResponse = await respond({ task:declined.doc.id });
  assert.equal(result.verdict.outcome, 'verified');
  assert.equal(result.response.type, TRUST_TASK_ERROR_TYPE_URI);
  assert.equal(result.response.payload.code, 'permissionDenied');
  assert.equal(receiptOf(result.response).terminalState, 'Rejected');
  assertVerified(await verify(result.response, { request:declined.doc }), 7);
});
await test('persistent duplicate: prior response, no new request or flow', async () => {
  const before = await snapshot();
  const duplicate = await receive(happy.path);
  assert.equal(duplicate.kind, 'duplicate');
  assert.equal(duplicate.inFlight, false);
  assert.deepEqual(duplicate.priorResponse, accepted.response);
  assert.deepEqual(await snapshot(), before);
});
await test('in-flight duplicate and idConflict are distinguished across fresh connections', async () => {
  const made = await fresh();
  assert.equal((await receive(made.path)).kind, 'accepted');
  const before = await snapshot();
  const duplicate = await receive(made.path);
  assert.equal(duplicate.kind, 'duplicate');
  assert.equal(duplicate.inFlight, true);
  assert.equal(duplicate.priorResponse, undefined);
  const unsigned = copy(made.doc); delete unsigned.proof;
  unsigned.payload.entry.role = 'admin';
  saveJson(made.path, sign(unsigned, loadOrCreateKey('requester').signer));
  const conflict = await receive(made.path);
  assert.equal(conflict.kind, 'rejected');
  assert.equal(conflict.code, 'idConflict');
  assert.deepEqual(await snapshot(), before);
});
await test('response role tampering fails the proof check (and the entry check)', async () => {
  const tampered = copy(accepted.response);
  tampered.payload.entry.role = 'admin';
  const result = await verify(tampered, { request:happy.doc });
  assert.equal(result.ok, false);
  assert.deepEqual(failed(result), ['proof', 'entry as asked']);
});
await test('space re-signs an answer granting a different role on a real receipt: entry check alone catches it', async () => {
  const changed = copy(accepted.response);
  changed.payload.entry.role = 'admin';
  const result = await verify(resign(changed), { request:happy.doc });
  assert.equal(result.ok, false);
  assert.deepEqual(failed(result), ['entry as asked']);
});
await test('space re-signs a receipt-less refusal with a code no pre-flow check emits: error code check catches it', async () => {
  const made = await fresh();
  const refusal = rejectWithFor(made.doc, { code:'teapot', message:'no', retryable:false });
  const result = await verify(refusal, { request:made.doc });
  assert.equal(result.ok, false);
  assert.deepEqual(failed(result), ['error code']);
  const missing = rejectWithFor(made.doc, { message:'no', retryable:false });
  assert.deepEqual(failed(await verify(missing, { request:made.doc })), ['error code']);
  const nullRetry = rejectWithFor(made.doc, { code:'proofInvalid', message:'no', retryable:null });
  assert.deepEqual(failed(await verify(nullRetry, { request:made.doc })), ['error code']);
});
await test('node re-signs altered receipt: receipt hash check alone catches it', async () => {
  const changed = copy(accepted.response);
  const receipt = receiptOf(changed).receipt;
  receipt.flow_dna_hash = (receipt.flow_dna_hash[0] === 'a' ? 'b' : 'a') + receipt.flow_dna_hash.slice(1);
  const result = await verify(resign(changed), { request:happy.doc });
  assert.equal(result.ok, false);
  assert.deepEqual(failed(result), ['receipt hash']);
});
await test('node re-signs swapped request content and fixes hash: binding check alone catches it', async () => {
  const changed = copy(accepted.response);
  const flowReceipt = receiptOf(changed);
  const output = flowReceipt.receipt.outputs.find(item => item.class_name === 'IiwTrustTaskRequest');
  const content = JSON.parse(output.content);
  content.raw = JSON.stringify(declined.doc);
  output.content = JSON.stringify(content);
  flowReceipt.sha256 = receiptSha256(flowReceipt.receipt);
  flowReceipt.uri = 'ad4m://flow/receipt/' + flowReceipt.sha256;
  assert.equal(checkReceiptHash(flowReceipt), true);
  const result = await verify(resign(changed), { request:happy.doc });
  assert.equal(result.ok, false);
  assert.deepEqual(failed(result), ['decided on my exact document']);
});
await test('AD4M independently rejects output-id tampering in a real receipt', async () => {
  const changed = copy(receiptOf(accepted.response).receipt);
  changed.outputs[0].id = 'ad4m://obj/not-the-decided-request';
  const result = await withContext(({ pS }) => pS.verifyFlowReceipt(changed));
  assert.equal(result.outcome, 'rejected');
});
await test('success response cannot omit its receipt', async () => {
  const changed = copy(accepted.response);
  delete changed.payload.ext;
  const result = await verify(resign(changed), { request:happy.doc });
  assert.equal(result.ok, false);
  assert.deepEqual(failed(result), ['receipt present']);
});


await test('node re-signs a response carrying a real Rejected receipt: outcome check alone catches it', async () => {
  const changed = copy(accepted.response);
  // Keep all receipt bytes and the declined request binding intact; only the response kind lies.
  changed.threadId = declined.doc.threadId ?? declined.doc.id;
  changed.payload = {
    entry:copy(declined.doc.payload.entry),
    ext:{ [NS]:{ flowReceipt:copy(receiptOf(rejectedResponse.response)) } }
  };
  assert.equal(checkReceiptHash(receiptOf(changed)), true);
  const result = await verify(resign(changed), { request:declined.doc });
  assert.equal(result.ok, false);
  assert.deepEqual(failed(result), ['outcome']);
});
await test('respond refuses an undecidable receipt with exitCode 4 and writes no response', async () => {
  const made = await fresh();
  assert.equal((await receive(made.path)).kind, 'accepted');
  await vote('reject', alice, { task:made.doc.id, why:'Exercise fail-closed receipt verification' });
  const responsePath = resolve(ROOT, 'out/response-' + shortId(made.doc.id) + '.json');
  assert.equal(existsSync(responsePath), false);
  const before = await snapshot();
  const filesBefore = readdirSync(resolve(ROOT, 'out')).sort();
  const original = PerspectiveProxy.prototype.verifyFlowReceipt;
  let calls = 0, thrown;
  PerspectiveProxy.prototype.verifyFlowReceipt = async function (...args) {
    if (++calls === 1) return { outcome:'undecidable', detail:'test' };
    return original.apply(this, args);
  };
  try {
    try { await respond({ task:made.doc.id }); } catch (error) { thrown = error; }
  } finally {
    PerspectiveProxy.prototype.verifyFlowReceipt = original;
  }
  assert.equal(calls, 1);
  // Inspect side effects even if respond returns or throws the wrong error.
  assert.equal(existsSync(responsePath), false);
  assert.deepEqual(readdirSync(resolve(ROOT, 'out')).sort(), filesBefore);
  assert.deepEqual(await snapshot(), before);
  assert(thrown, 'respond must throw for an undecidable verdict');
  assert.equal(thrown.exitCode, 4);
  assert.equal(thrown.message, 'Receipt undecidable: test');
});
await test('proofPurpose other than assertionMethod: refused on both sides', async () => {
  const made = await fresh();
  const unsigned = copy(made.doc); delete unsigned.proof;
  made.doc = signTrustTask(unsigned, loadOrCreateKey('requester').signer, { proofPurpose:'authentication' });
  saveJson(made.path, made.doc);
  const before = await snapshot();
  const result = await receive(made.path);
  assert.equal(result.kind, 'rejected');
  assert.equal(result.code, 'proofInvalid');
  assert.deepEqual(await snapshot(), before);
  const response = copy(accepted.response); delete response.proof;
  const checked = await verify(signTrustTask(response, nodeSigner, { proofPurpose:'authentication' }), { request:happy.doc });
  assert.equal(checked.ok, false);
  assert.deepEqual(failed(checked), ['proof']);
});
await test('respond twice: the same signed answer, nothing new minted or stored', async () => {
  const before = await snapshot();
  const again = await respond({ task:declined.doc.id });
  assert.equal(again.existing, true);
  assert.deepEqual(again.response, rejectedResponse.response);
  assert.deepEqual(readJson(again.path), rejectedResponse.response);
  assert.deepEqual(await snapshot(), before);
});
await test('respond before the group decided: exitCode 4, nothing written', async () => {
  const made = await fresh();
  assert.equal((await receive(made.path)).kind, 'accepted');
  const before = await snapshot();
  const filesBefore = readdirSync(resolve(ROOT, 'out')).sort();
  let thrown;
  try { await respond({ task:made.doc.id }); } catch (error) { thrown = error; }
  assert(thrown, 'respond must refuse a run that is still Received');
  assert.equal(thrown.exitCode, 4);
  assert.match(thrown.message, /^Flow not finished \(state Received\)/);
  assert.deepEqual(readdirSync(resolve(ROOT, 'out')).sort(), filesBefore);
  assert.deepEqual(await snapshot(), before);
});
await test('validly signed schema-invalid request: malformedRequest and no graph changes', async () => {
  const made = await alteredRequest(doc => { delete doc.payload.entry.act; });
  assert.equal((await verifyProof(made.doc)).ok, true);
  const before = await snapshot();
  const result = await receive(made.path);
  assert.equal(result.kind, 'rejected');
  assert.equal(result.code, 'malformedRequest');
  assert.equal((await verifyProof(result.error)).ok, true);
  assert.deepEqual(await snapshot(), before);
});

// Envelope failures must not reach the payload consumer, replay guard or graph.
for (const [name, change] of [
  ['unsupported type', doc => { doc.type = 'https://example.org/not-acl/0.1'; }],
  ['missing type', doc => { delete doc.type; }],
  ['numeric type', doc => { doc.type = 42; }],
  ['empty type', doc => { doc.type = ''; }],
  ['garbage type', doc => { doc.type = 'not a type <x>'; }]
]) {
  await test(name + ': signed unsupportedType and no graph changes', async () => {
    const made = await alteredRequest(change);
    assert.equal((await verifyProof(made.doc)).ok, true);
    const before = await snapshot();
    const result = await receive(made.path);
    assert.equal(result.kind, 'rejected');
    assert.equal(result.code, 'unsupportedType');
    assert.equal(result.error.type, TRUST_TASK_ERROR_TYPE_URI);
    assert.equal(result.error.payload.retryable, false);
    assert.equal(result.error.issuer, config.spaceDid);
    assert.equal(result.error.recipient, made.doc.issuer);
    assert.equal(result.error.threadId, made.doc.id);
    if (typeof made.doc.type === 'string' && made.doc.type.startsWith('https://')) {
      assert.deepEqual(result.error.payload.inResponseTo, { typeUri:made.doc.type, id:made.doc.id });
    } else {
      assert.equal('inResponseTo' in result.error.payload, false);
    }
    assert.equal((await verifyProof(result.error)).ok, true);
    assert.deepEqual(await snapshot(), before);
  });
}
for (const [name, change] of [
  ['missing id', doc => { delete doc.id; }],
  ['numeric id', doc => { doc.id = 42; }],
  ['empty id', doc => { doc.id = ''; }],
  ['whitespace id', doc => { doc.id = '  '; }],
  ['missing issuer', doc => { delete doc.issuer; }],
  ['numeric issuer', doc => { doc.issuer = 42; }],
  ['malformed issuer', doc => { doc.issuer = 'not a VID'; }]
]) {
  await test(name + ': unsigned malformedRequest exit 2 and no graph changes', async () => {
    const made = await fresh();
    const unsigned = copy(made.doc); delete unsigned.proof;
    change(unsigned);
    const requesterKey = loadOrCreateKey('requester');
    const malformed = unsigned.issuer === requesterKey.did ? sign(unsigned, requesterKey.signer) : unsigned;
    if (malformed.proof) assert.equal((await verifyProof(malformed)).ok, true);
    saveJson(made.path, malformed);
    const before = await snapshot();
    const filesBefore = readdirSync(resolve(ROOT, 'out')).sort();
    await assert.rejects(receive(made.path), error =>
      error.exitCode === 2 && error.message.startsWith('malformedRequest:'));
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(readdirSync(resolve(ROOT, 'out')).sort(), filesBefore);
  });
}
for (const [name, doc] of [['null', null], ['array', []]]) {
  await test('top-level ' + name + ': unsigned malformedRequest exit 2 and no graph changes', async () => {
    const path = resolve(ROOT, 'out/test-' + shortId(uuid()) + '.json');
    saveJson(path, doc);
    const before = await snapshot();
    const filesBefore = readdirSync(resolve(ROOT, 'out')).sort();
    await assert.rejects(receive(path), error =>
      error.exitCode === 2 && error.message.startsWith('malformedRequest:'));
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(readdirSync(resolve(ROOT, 'out')).sort(), filesBefore);
  });
}

await test('npm test keeps to its own state folder: the tutorial space in .demo/ is unchanged', async () => {
  assert.equal(STATE, resolve(ROOT, '.demo-test'));
  assert.deepEqual(tutorialFiles.map(path => existsSync(path) ? readFileSync(path, 'utf8') : null), tutorialBefore);
});
await test('users add interrupted after createUser: the login is kept and a retry finishes it', async () => {
  const name = 'carol-' + randomBytes(3).toString('hex');
  const original = AgentClient.prototype.loginUser;
  AgentClient.prototype.loginUser = async function () { throw new Error('simulated failure'); };
  try { await assert.rejects(addUsers([name]), /simulated failure/); }
  finally { AgentClient.prototype.loginUser = original; }
  assert.equal(readJson(resolve(STATE, 'people.json'))[name].login, 'user');
  const retried = await addUsers([name]);
  assert.match(retried.people[name].did, /^did:key:/);
  const token = await openAs('bob', ({ client }) => client.agent.loginUser(name + '@iiw.local', readJson(resolve(STATE, 'people.json'))[name].password));
  assert.equal(typeof token, 'string');
});

await test('agent --as refuses a user\'s name and a rename under an existing space', async () => {
  const people = readJson(resolve(STATE, 'people.json'));
  await assert.rejects(agent({ as:alice, noPrompt:true }), /is a user on this node/);
  await assert.rejects(agent({ as:'someone-else', noPrompt:true }), /knows this node's agent as bob/);
  assert.deepEqual(readJson(resolve(STATE, 'people.json')), people);
});

await test('the page\'s member list: /api/runs never waits for the link language, and asks it at most once a minute', async () => {
  let clock = 0, calls = 0, answer = ['did:key:a'];
  const never = new Promise(() => {});
  let hang = true;
  const cache = backgroundCache(async () => { calls++; if (hang) return never; return answer; }, { ttl:60000, timeout:50, now:() => clock });
  // A dead link server: the first ask never answers. get() still returns at once, with the fallback.
  const started = Date.now();
  assert.deepEqual(cache.get('nh-1', []), []);
  assert(Date.now() - started < 20);
  // The page polls every 4 s: no second ask while one is out or within the minute.
  for (let i = 0; i < 10; i++) { clock += 4000; assert.deepEqual(cache.get('nh-1', []), []); await delay(1); }
  assert.equal(calls, 1);
  await delay(80);                  // the hung ask times out
  hang = false;
  clock += 60000;                   // a minute after it gave up
  cache.get('nh-1', []); await cache.refresh();
  assert.equal(calls, 2);
  assert.deepEqual(cache.get('nh-1', []), ['did:key:a']);
  clock += 4000; cache.get('nh-1', []);
  assert.equal(calls, 2);
  // A join marks it stale: the next poll asks again.
  cache.stale(); answer = ['did:key:a', 'did:key:b'];
  cache.get('nh-1', []); await cache.refresh();
  assert.equal(calls, 3);
  assert.deepEqual(cache.get('nh-1', []), ['did:key:a', 'did:key:b']);
  // Another space starts empty, not with the old space's members.
  assert.deepEqual(cache.get('nh-2', []), []);
  await cache.refresh();
  assert.equal(calls, 4);
});
