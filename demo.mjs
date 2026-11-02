// The AD4M side of the demo: a small admin shell for this one use case. Read it top to bottom.
//
//   node demo.mjs agent [--as <name>] [--remember]   create or unlock this node's agent (asks for the passphrase)
//   node demo.mjs users add <name>…                  multi-user mode: more people on this node, each with a DID
//   node demo.mjs show [--links]                     the trust task next to the social DNA it becomes
//   node demo.mjs space [--as <name>]                make the space and install the flow
//   node demo.mjs share [--link holochain|server]    publish the space as a neighbourhood
//   node demo.mjs join <neighbourhood-url> [--as <name>]
//   node demo.mjs receive <request.json>             check a trust task, store it, start the flow
//   node demo.mjs vote <accept|reject> --as <name>
//   node demo.mjs respond                            flow receipt → signed trust-task answer
//   node demo.mjs check-receipt [<answer.json>] [--as <name>]
//   node demo.mjs status [--as <name>]
//
// Every AD4M call below is a plain @coasys/ad4m SDK call on an Ad4mClient or a
// PerspectiveProxy (a "space"). The trust-task side (ToIP's libraries) is in common.mjs.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Ad4mClient, Ad4mModel, SHACLFlow, FlowInstance, Perspective } from '@coasys/ad4m';
import { consumeInbound, consequentialChecks, UnauthenticatedTransport, respondWith, rejectWith } from '@openvtc/trust-tasks/runtime';
import { TYPE_URI, SPEC, RESPONSE_TYPE_URI, RESPONSE_PAYLOAD_SCHEMA } from '@openvtc/trust-tasks/acl/grant/0.2/payload';
import { ROOT, STATE, NS, FLOW, uuid, shortId, stateDir, saveJson, readJson, loadOrCreateKey,
  sign, proofAdapter, validator, assertPayload, receiptSha256, documentDigest, TRUST_TASK_ERROR_TYPE_URI,
  args, isMain, emit, cliError, rel, shortDid } from './common.mjs';

// ── 1. The social DNA ────────────────────────────────────────────────────────────
// A class for the stored trust task, a class for the answer, and the flow that decides.
// AD4M stores all three as links in the space, so everyone in the space has the same rules.
function model(name, fields, optional = []) {
  return Ad4mModel.fromJSONSchema({
    title: name, type: 'object',
    properties: Object.fromEntries(fields.map(field => [field, { type: 'string' }])),
    required: fields.filter(field => !optional.includes(field))
  }, { name, namespace: 'iiw://',
    propertyMapping: Object.fromEntries(fields.map(field => [field, 'iiw://' + name + '/' + field])) });
}
export const REQUEST_FIELDS = ['raw','taskId','taskType','issuer','recipient','issuedAt','expiresAt','subject','role','digest'];
export const RequestModel = model('IiwTrustTaskRequest', REQUEST_FIELDS, ['expiresAt']);
export const ResponseModel = model('IiwTrustTaskResponse', ['raw','inResponseTo','kind']);

export function trustTaskFlow() {
  const flow = new SHACLFlow('TrustTaskDecision', 'iiw://');          // → iiw://TrustTaskDecisionFlow
  flow.inputTypes = ['IiwTrustTaskRequest'];                           // a run starts on a stored request
  flow.consensusRule = { n: 1 };
  flow.interpretationHint = 'A received trust task: two voters accept it, or one voter rejects it.';
  flow.addState({ name:'Received', value:0, interpretationHint:'Checked and stored; the group decides.' });
  // n counts distinct voters in the space; it does not check roles. Any two members can accept.
  flow.addState({ name:'Accepted', value:1, interpretationHint:'Two voters agreed.', consensusRule:{ n:2 } });
  flow.addState({ name:'Rejected', value:2, interpretationHint:'A voter declined.', consensusRule:{ n:1 } });
  flow.addTransition({ actionName:'Accept', fromState:'Received', toState:'Accepted', actions:[] });
  flow.addTransition({ actionName:'Reject', fromState:'Received', toState:'Rejected', actions:[] });
  return flow;
}

// ── 2. Connecting ───────────────────────────────────────────────────────────────
// Plumbing, safe to skip: Node reports an error when close() cancels an SDK watch socket that is
// still connecting. This silences only errors after our own close; real connection errors still show.
class DemoWebSocket extends WebSocket {
  close(code, reason) { this.onerror = null; super.close(code, reason); }
}
const connect = (url, token) => new Ad4mClient(url, token, { webSocketImpl:DemoWebSocket });
const nodeUrl = () => process.env.AD4M_URL ?? 'http://127.0.0.1:12100';
function adminClient(url = nodeUrl()) {
  // The node's admin credential (start-node.sh writes it). It controls the node's own agent.
  const credentialPath = resolve(ROOT, process.env.AD4M_ADMIN_CREDENTIAL_FILE
    ?? resolve(process.env.NODE_DIR ?? resolve(ROOT, '.node'), 'admin-credential'));
  return connect(url, readFileSync(credentialPath, 'utf8').trim());
}
// What this folder remembers: the people on this node (.demo/people.json) and the space (.demo/space.json).
const peoplePath = resolve(STATE, 'people.json'), spacePath = resolve(STATE, 'space.json');
const readPeople = () => existsSync(peoplePath) ? readJson(peoplePath) : {};
const readSpace = () => {
  if (!existsSync(spacePath)) throw new Error('No space yet: run `node demo.mjs space` (or `join`) first');
  return readJson(spacePath);
};
// What is safe to print or return: no passwords.
const publicPeople = people => Object.fromEntries(Object.entries(people).map(([name, person]) => [name, { did:person.did, login:person.login }]));
const agentName = people => Object.keys(people).find(name => people[name].login === 'agent');
// The web page (ui.mjs) is an app: after the capability handshake it holds a token for this
// node's agent, and the agent's own steps then go through that token, not the admin credential.
let appToken = null;
export const useAppToken = token => { appToken = token ?? null; };
// The client one person acts through. Close it after use unless it is `admin`.
async function clientOf(admin, person, url) {
  if (person.login === 'agent') return appToken ? connect(url, appToken) : admin;
  return connect(url, await admin.agent.loginUser(person.email, person.password));
}

// Ask for a passphrase without echoing it. Piped input (`… | node demo.mjs agent`) is read as one line.
async function askHidden(question) {
  if (!process.stdin.isTTY) {
    const lines = createInterface({ input:process.stdin });
    for await (const line of lines) { lines.close(); return line; }
    return '';
  }
  process.stdout.write(question);
  process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
  return new Promise(done => {
    let value = '';
    const onData = chunk => {
      for (const c of chunk) {
        if (c === '\u0003') { process.stdin.setRawMode(false); process.exit(130); }
        if (c === '\r' || c === '\n') {
          process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', onData);
          process.stdout.write('\n'); return done(value);
        }
        value = c === '\u007f' || c === '\b' ? value.slice(0, -1) : value + c;
      }
    };
    process.stdin.on('data', onData);
  });
}
// The node's own agent must exist and be unlocked. Other commands only unlock it on their own
// if you chose `agent --remember`; otherwise they ask you to run `agent`.
const passphrasePath = resolve(STATE, 'agent-passphrase');
// Only the final newline is ours; spaces are part of the passphrase.
const readPassphrase = () => readFileSync(passphrasePath, 'utf8').replace(/\r?\n$/, '');
function rememberPassphrase(passphrase) {
  writeFileSync(passphrasePath, passphrase + '\n', { mode:0o600 });
  chmodSync(passphrasePath, 0o600);
}
export async function ensureAgent(admin) {
  const status = await admin.agent.status();
  if (status.isInitialized && status.isUnlocked) return;
  if (!status.isInitialized || !existsSync(passphrasePath)) throw new Error('This node\'s agent is ' + (status.isInitialized ? 'locked' : 'not created yet') + ': run `node demo.mjs agent`');
  await admin.agent.unlock(readPassphrase(), true);
}

// Open the space as one person. A user on this node logs in with their throwaway password;
// the node's agent uses the admin credential. Each person has their own DID and signs their own links.
export async function openAs(name, callback) {
  const space = readSpace(), people = readPeople();
  const person = people[name], uuid = space.uuids[name];
  if (!person || !uuid) throw new Error(name + ' is not in this space on this node (here: ' + Object.keys(space.uuids).join(', ') + ')');
  const admin = adminClient(space.url);
  let client;
  try {
    await ensureAgent(admin);
    client = await clientOf(admin, person, space.url);
    let p = await client.perspective.byUUID(uuid);
    // A space a user owns: an app token for the node's agent does not reach it; the admin credential does.
    if (!p && client !== admin) { client.close(); client = admin; p = await admin.perspective.byUUID(uuid); }
    assert(p, name + ' must see the space');
    return await callback({ space, person, client, p });
  } finally { if (client !== admin) client?.close(); admin.close(); }
}
// ── 3. Commands ─────────────────────────────────────────────────────────────────

// show: the trust task and the social DNA it maps to, side by side.
export function show() {
  const flow = trustTaskFlow();
  const n = state => (flow.states.find(s => s.name === state).consensusRule ?? flow.consensusRule).n;
  const votes = state => n(state) === 1 ? '1 vote' : n(state) + ' votes';
  // [trust task, AD4M, extra]. Indented rows belong to the row above; extra.more marks a row that
  // only wraps the one above in the terminal, extra.note is set off from the AD4M side.
  const rows = [
    ['ToIP trust task  acl/grant/0.2', 'AD4M social DNA in the space'],
    ['request ' + TYPE_URI.replace('https://trusttasks.org/spec/', ''), 'class IiwTrustTaskRequest (flow input)'],
    ['  the signed JSON, as received', '  raw  (byte for byte)'],
    ['  id, type, issuer, recipient', '  taskId, taskType, issuer, recipient'],
    ['  issuedAt, expiresAt', '  issuedAt, expiresAt'],
    ['  payload.entry.subject, .role', '  subject, role'],
    ['  (document digest)', '  digest'],
    ['receiver checks: proof, recipient,', 'state Received'],
    ['  schema, freshness, duplicates', '  (checked and stored; the group decides)', { more:true }],
    ['', ''],
    ['the maintainer decides', 'flow ' + FLOW],
    ['  grant it', '  Accept: Received → Accepted', { note:votes('Accepted') }],
    ['  refuse it', '  Reject: Received → Rejected', { note:votes('Rejected') }],
    ['', ''],
    ['answer ' + RESPONSE_TYPE_URI.replace('https://trusttasks.org/spec/', ''), 'Accepted + flow receipt'],
    ['answer trust-task-error permissionDenied', 'Rejected + flow receipt'],
    ['  payload ext / details', '  "' + NS + '": { flowReceipt }']
  ];
  // → the task becomes this in AD4M; ← AD4M's result goes back into the answer.
  const arrow = ([left, right], i) => {
    if (i === 0 || !left.trim() || !right.trim() || right.trim().startsWith('(')) return '';
    return left.startsWith('answer') || left.startsWith('  payload ext') ? '←' : '→';
  };
  const ad4m = ([, right, extra]) => right + (extra?.note ? '   ' + extra.note : '');
  const width = Math.max(...rows.map(([left]) => left.length)) + 3;
  const lines = rows.map((row, i) => (row[0].padEnd(width) + arrow(row, i).padEnd(3) + ad4m(row)).trimEnd());
  lines.splice(1, 0, '─'.repeat(width) + '   ' + '─'.repeat(rows[0][1].length));
  // The same table as data, for the web page: one entry per section or field, wrapped rows joined.
  const table = [];
  for (const [i, row] of rows.entries()) {
    const [left, right, extra] = row;
    if (i === 0 || !left.trim()) continue;
    const squash = text => text.trim().replace(/\s+/g, ' ');
    if (extra?.more) { const last = table.at(-1); last.task += ' ' + squash(left); last.ad4m += ' ' + squash(right); continue; }
    table.push({ section:!left.startsWith(' '), task:squash(left), arrow:arrow(row, i), ad4m:squash(right), note:extra?.note ?? null });
  }
  return { lines, header:{ task:rows[0][0].replace(/\s+/g, ' '), ad4m:rows[0][1] }, rows:table, flow:flow.toJSON() };
}
// show --links: the same social DNA as the links AD4M stores.
export function showLinks() {
  const short = value => String(value).replace(/^iiw:\/\//, '').replace(/^literal:string:/, '"')
    .replace(/%22/g, '"').replace(/%5B/g, '[').replace(/%5D/g, ']').replace(/%7B/g, '{').replace(/%7D/g, '}').replace(/%3A/g, ':');
  const noise = /(constructor|destructor|setter|writable)$/;
  const out = links => links.filter(link => !noise.test(link.predicate)).map(link => short(link.source) + '  ' + link.predicate.split(/[#/]/).pop() + '  ' + short(link.target));
  return ['# class IiwTrustTaskRequest (SHACL shape), first fields', ...out(RequestModel.generateSHACL().shape.toLinks()).slice(0, 12), '…',
    '', '# flow ' + FLOW, ...out(trustTaskFlow().toLinks())];
}

// agent: create this node's agent, or unlock it after a restart. The passphrase is asked for and
// never printed. It is only written down (.demo/agent-passphrase, mode 600) with --remember.
export async function agent(options = {}) {
  stateDir();
  const people = readPeople(), current = agentName(people);
  const name = options.as ?? current ?? 'me';
  // Never turn a user into the agent, and never rename the agent under a space that uses its name.
  if (people[name]?.login === 'user') throw new Error(name + ' is a user on this node; pick another name for the node\'s agent');
  if (current && name !== current && existsSync(spacePath) && readSpace().uuids[current])
    throw new Error('The space here knows this node\'s agent as ' + current + '; use --as ' + current);
  const admin = adminClient();
  try {
    let status = await admin.agent.status(), created = false;
    const wasReady = status.isInitialized && status.isUnlocked;
    const ask = question => options.noPrompt ? Promise.reject(new Error('This node\'s agent is '
      + (status.isInitialized ? 'locked' : 'not created yet') + ': run `node demo.mjs agent` first')) : askHidden(question);
    if (!status.isInitialized || !status.isUnlocked) {
      const passphrase = options.passphrase ?? (existsSync(passphrasePath) ? readPassphrase()
        : await ask(status.isInitialized ? 'Passphrase to unlock this node\'s agent: ' : 'New passphrase for this node\'s agent: '));
      if (!passphrase) throw new Error('No passphrase given');
      if (!status.isInitialized) {
        if (process.stdin.isTTY && options.passphrase === undefined && await askHidden('Same passphrase again: ') !== passphrase) throw new Error('The passphrases differ');
        status = await admin.agent.generate(passphrase);
        created = true;
      }
      if (!status.isUnlocked) status = await admin.agent.unlock(passphrase, true);
      if (!status.isUnlocked) throw new Error('Unlock failed: ' + (status.error ?? 'wrong passphrase?'));
      if (options.remember) rememberPassphrase(passphrase);
    } else if (options.remember && !existsSync(passphrasePath)) {
      // Already unlocked: check the passphrase with unlock (it refuses a wrong one), then keep it.
      const passphrase = options.passphrase ?? await ask('Passphrase of this node\'s agent, to remember: ');
      await admin.agent.unlock(passphrase, true);
      rememberPassphrase(passphrase);
    }
    const did = (await admin.agent.me()).did;
    if (current && current !== name) delete people[current];
    people[name] = { login:'agent', did };
    saveJson(peoplePath, people);
    return { name, did, created, wasReady, remembered:existsSync(passphrasePath) };
  } finally { admin.close(); }
}
// users add: turn on multi-user mode and add people to this node. Each gets a DID and a random
// throwaway password, kept in .demo/people.json so `--as <name>` can log them in.
export async function addUsers(names) {
  if (!names.length || names.some(name => !/^[a-z][a-z0-9-]*$/.test(name))) throw new Error('users add <name>… (lower-case names)');
  stateDir();
  const admin = adminClient();
  try {
    await ensureAgent(admin);
    await admin.runtime.setMultiUserEnabled(true);
    const people = readPeople(), added = [];
    for (const name of names) {
      if (people[name]?.login === 'user' && people[name].did) {
        await admin.runtime.setUserFreeAccess(people[name].email, true);       // finish an earlier, interrupted add
        continue;
      }
      if (people[name]) throw new Error(name + ' is this node\'s agent');
      const email = name + '@iiw.local', password = randomBytes(24).toString('hex');
      const created = await admin.agent.createUser(email, password).catch(error => ({ success:false, error:error.message }));
      if (!created.success) throw new Error('Could not add ' + name + ': ' + (created.error ?? 'unknown error')
        + ' (a name added from another folder cannot be reused here)');
      // Keep the login before anything else can fail, so a retry can use it.
      people[name] = { login:'user', email, password, did:created.did };
      saveJson(peoplePath, people);
      await admin.runtime.setUserFreeAccess(email, true);
      const user = connect(nodeUrl(), await admin.agent.loginUser(email, password));
      try { people[name] = { login:'user', email, password, did:(await user.agent.me()).did }; } finally { user.close(); }
      added.push(name);
    }
    saveJson(peoplePath, people);
    return { added, people:publicPeople(people) };
  } finally { admin.close(); }
}

export async function installSocialDna(p) {
  await RequestModel.register(p);                                   // SHACL shape links
  await ResponseModel.register(p);
  await p.addFlow('TrustTaskDecision', trustTaskFlow());             // the flow's links
}
// Is the flow in this space yet? (In a joined space it arrives with the space's links.)
export const hasSocialDna = async p => !!await p.getFlow('TrustTaskDecision').catch(() => null);
// space: make the space (a perspective) as one person and install the flow in it.
// Default owner: the first user on this node, else the node's agent. A space owned by a user
// is also open to the node's agent, so on one node "a user + the node's agent" vote without any
// network. (Two users on one node only share a space through a neighbourhood: `share`, `join`.)
export async function makeSpace(options = {}) {
  stateDir();
  if (existsSync(spacePath) && !options.force) return { ...readSpace(), people:publicPeople(readPeople()), existing:true };
  const people = readPeople();
  const owner = options.as ?? Object.keys(people).find(name => people[name].login === 'user') ?? agentName(people);
  if (!people[owner]) throw new Error(owner ? owner + ' is not on this node: `users add ' + owner + '`' : 'Run `node demo.mjs agent` first');
  const admin = adminClient();
  let client;
  try {
    await ensureAgent(admin);
    client = await clientOf(admin, people[owner], nodeUrl());
    const handle = await client.perspective.add('IIW trust tasks');
    // options.bare (the web page): an empty space; the page installs the flow as its own step.
    if (!options.bare) await installSocialDna(await client.perspective.byUUID(handle.uuid));
    const uuids = { [owner]:handle.uuid };
    const nodeAgent = agentName(people);
    if (nodeAgent && nodeAgent !== owner && await admin.perspective.byUUID(handle.uuid)) uuids[nodeAgent] = handle.uuid;
    // The space's trust-task key: held by this client, not by AD4M (see NOTE.md).
    const space = { url:nodeUrl(), owner, uuids, spaceDid:loadOrCreateKey('space').did };
    writeFileSync(resolve(STATE, 'space-did.txt'), space.spaceDid + '\n', { mode:0o600 });
    saveJson(spacePath, space);
    return { ...space, people:publicPeople(people) };
  } finally { if (client !== admin) client?.close(); admin.close(); }
}
// share: publish the space as a neighbourhood, so people on other nodes (or other users on this
// node) can join it. The link language moves the links: Holochain (peer to peer, AD4M's default)
// or a link server (one server relays; --server-url, default https://link.ad4m.dev).
export async function share(options = {}) {
  const space = readSpace();
  if (space.neighbourhood) return { ...space, existing:true };
  const link = options.link ?? 'holochain';
  if (!['holochain','server'].includes(link)) throw new Error('--link holochain|server');
  return openAs(space.owner, async ({ client, p }) => {
    const templates = await client.runtime.knownLinkLanguageTemplates();
    const template = templates.find(t => t.name === (link === 'holochain' ? 'perspectiveDiffSync' : 'Server Link Language'));
    if (!template) throw new Error('This node has not loaded the ' + link + ' link language; sharing needs the network');
    const params = link === 'holochain' ? { uid:randomUUID(), name:'IIW trust tasks' }
      : { SERVER_URL:options['server-url'] ?? 'https://link.ad4m.dev', UID:randomUUID() };
    const linkLanguage = await client.languages.applyTemplateAndPublish(template.address, JSON.stringify(params));
    space.neighbourhood = await client.neighbourhood.publishFromPerspective(p.uuid, linkLanguage.address, new Perspective([]));
    space.link = link;
    saveJson(spacePath, space);
    return space;
  });
}
// join: open a shared space on this node, as this node's agent or as a user on it.
// The flow and the classes arrive with the space's links; wait until the flow is there.
export async function join(url, options = {}) {
  if (!/^neighbourhood:\/\//.test(url ?? '')) throw new Error('join <neighbourhood://…>');
  stateDir();
  const people = readPeople(), name = options.as ?? agentName(people);
  const person = people[name];
  if (!person) throw new Error((name ?? 'nobody') + ' is not on this node: run `agent` or `users add`');
  const old = existsSync(spacePath) ? readSpace() : null;
  if (old && old.neighbourhood !== url) throw new Error('This folder already has another space (.demo/space.json)');
  const admin = adminClient();
  let client;
  try {
    await ensureAgent(admin);
    client = await clientOf(admin, person, nodeUrl());
    // Joined before (say, the wait below timed out): just wait for the flow again.
    const uuid = old?.uuids[name] ?? (await client.neighbourhood.joinFromUrl(url)).uuid;
    const handle = { uuid };
    const p = await client.perspective.byUUID(uuid);
    const space = old ?? { url:nodeUrl(), owner:null, uuids:{}, neighbourhood:url };
    space.uuids[name] = uuid;
    saveJson(spacePath, space);
    const until = Date.now() + Number(options.wait ?? 300) * 1000;
    let flow = null;
    while (!flow && Date.now() < until) {
      flow = await p.getFlow('TrustTaskDecision').catch(() => null);
      if (!flow) await delay(2000);
    }
    return { name, uuid:handle.uuid, did:person.did, synced:!!flow };
  } finally { if (client !== admin) client?.close(); admin.close(); }
}

// receive: the space's owner takes a trust task in. The checks run before anything is stored.
// One file transport per folder: serialize deliveries across processes, holding the lock
// through the store/start operation. The graph, not this lock, is the durable replay record.
// A killed process leaves the lock; refuse rather than guess whether another process is alive.
async function deliveryLock(callback) {
  stateDir();
  const lock = resolve(STATE, 'receive.lock');
  let acquired = false;
  for (let tries = 0; tries < 500; tries++) {
    try { mkdirSync(lock, { mode:0o700 }); acquired = true; break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; await delay(20); }
  }
  if (!acquired) throw new Error('Receive lock busy; inspect before removing .demo/receive.lock');
  try { return await callback(); } finally { rmSync(lock, { recursive:true }); }
}
export function perspectiveReplayGuard(p) {
  return {
    async claim(id, digest) {
      const requests = await RequestModel.findAll(p, { where:{ taskId:id } });
      if (!requests.length) return { kind:'fresh' };
      assert.equal(requests.length, 1, 'Replay record must be unique');
      if (requests[0].digest !== digest) return { kind:'conflict' };
      const prior = await ResponseModel.findOne(p, { where:{ inResponseTo:id } });
      return { kind:'duplicate', inFlight:!prior, ...(prior ? { priorResponse:JSON.parse(prior.raw) } : {}) };
    },
    // Responses are written by respond(), not by this fire-and-forget handler.
    async recordResponse() {},
    // No provisional graph row was written by claim(). Never erase an accepted request.
    async release() {}
  };
}
const owner = () => {
  const space = readSpace();
  if (!space.owner) throw new Error('Only the folder that made the space receives and answers trust tasks');
  return space.owner;
};
const typeUriLike = value => typeof value === 'string' && /^https?:\/\/[^\s#]+\/\d+\.\d+(?:#[a-z]+)?$/i.test(value);
export async function receive(file) {
  const text = readFileSync(resolve(ROOT, file), 'utf8');
  let doc;
  try { doc = JSON.parse(text); }
  catch { throw Object.assign(new Error('malformedRequest: invalid JSON; no flow started'), { exitCode:2 }); }
  // The installed framework modules export types only, not an envelope schema.
  // Parse/dispatch is our responsibility, before consumeInbound or any graph write.
  const nonempty = value => typeof value === 'string' && value.trim().length > 0;
  const object = doc !== null && typeof doc === 'object' && !Array.isArray(doc);
  // File transport authenticates no sender. Without a usable producer and document
  // id we cannot address/correlate a conforming signed error (§8.1 / §8.2).
  if (!object || !nonempty(doc.id) || !nonempty(doc.issuer)
      || !/^[a-z][a-z0-9+.-]*:[^\s]+$/i.test(doc.issuer)) {
    throw Object.assign(new Error('malformedRequest: invalid envelope; no flow started'), { exitCode:2 });
  }
  const envelopeError = doc.type !== TYPE_URI
    ? { code:'unsupportedType', message:'Unsupported trust-task type', retryable:false } : null;
  return deliveryLock(() => openAs(owner(), async ({ space, p }) => {
    let stored, run;
    const outcome = envelopeError ? {
      kind:'rejected',
      error:rejectWith({
        id:doc.id, issuer:doc.issuer, recipient:space.spaceDid,
        ...(nonempty(doc.threadId) ? { threadId:doc.threadId } : {}),
        // Echo the sender's type only if it is a well-formed type URI (§8.2 typeUri).
        ...(typeUriLike(doc.type) ? { type:doc.type } : {})
      }, uuid(), envelopeError)
    } : await consumeInbound({
      transport:new UnauthenticatedTransport(), spec:SPEC,
      proofPolicy:{ kind:'verify', verify:proofAdapter },
      payloadPolicy:{ kind:'validate', validate:validator },
      checks:consequentialChecks(perspectiveReplayGuard(p)), doc, myVid:space.spaceDid,
      now:Date.now(), newErrorId:uuid,
      async handler(accepted) {
        // The raw field is the exact input text, never JSON.stringify(accepted).
        const fields = {
          raw:text, taskId:accepted.id, taskType:accepted.type, issuer:accepted.issuer,
          recipient:accepted.recipient, issuedAt:accepted.issuedAt,
          subject:accepted.payload.entry.subject, role:accepted.payload.entry.role, digest:documentDigest(accepted)
        };
        if (accepted.expiresAt !== undefined) fields.expiresAt = accepted.expiresAt;
        stored = await RequestModel.create(p, fields);
        const loaded = await RequestModel.findOne(p, { where:{ taskId:accepted.id } });
        assert.equal(loaded.raw, text, 'Stored original JSON losslessly');
        run = await FlowInstance.start(p, 'TrustTaskDecision', stored.id);
      }
    });
    if (outcome.kind === 'accepted') {
      writeFileSync(resolve(STATE, 'latest-task.txt'), doc.id, { mode:0o600 });
      return { ...outcome, taskId:doc.id, requestId:stored.id, runUri:run.uri, state:run.currentStateName, lossless:true };
    }
    if (outcome.kind === 'rejected') {
      // §8.2 SHOULD include origin metadata, but an absent/invalid type cannot
      // truthfully populate its required typeUri. Omit rather than invent it.
      if (envelopeError && !typeUriLike(doc.type)) delete outcome.error.payload.inResponseTo;
      // The runtime routes wrongRecipient errors using the supplied (wrong) recipient.
      // This space is the actual error issuer: set it explicitly before signing.
      const error = sign({ ...outcome.error, issuer:space.spaceDid }, loadOrCreateKey('space').signer);
      const path = resolve(ROOT, 'out/error-' + shortId(doc.id ?? error.id) + '.json');
      saveJson(path, error);
      return { kind:'rejected', error, path, code:error.payload.code };
    }
    if (outcome.kind === 'duplicate' && outcome.inFlight) {
      // Stored earlier but its flow never started (a crash between the two writes): start it now.
      const [earlier] = await RequestModel.findAll(p, { where:{ taskId:doc.id } });
      if (!(await FlowInstance.findAll(p, { subject:earlier.id })).length) {
        run = await FlowInstance.start(p, 'TrustTaskDecision', earlier.id);
        writeFileSync(resolve(STATE, 'latest-task.txt'), doc.id, { mode:0o600 });
        return { ...outcome, runUri:run.uri, startedNow:true };
      }
    }
    if (outcome.kind === 'duplicate' && outcome.priorResponse) {
      const path = resolve(ROOT, 'out/response-' + shortId(doc.id) + '.json');
      saveJson(path, outcome.priorResponse);
      return { ...outcome, path };
    }
    return outcome;
  }));
}

// Which task? --task <id>, else the last one this folder received, else the newest open run.
export async function taskOn(p, taskId) {
  const latest = resolve(STATE, 'latest-task.txt');
  const id = taskId ?? (existsSync(latest) ? readFileSync(latest, 'utf8').trim() : null);
  if (!id) {
    const open = [];
    for (const request of await RequestModel.findAll(p)) {
      if ((await statesOf(p, request.id)).includes('Received')) open.push(request);
    }
    if (!open.length) throw new Error('No open trust task in this space yet (it may still be syncing)');
    return open.sort((a, b) => a.issuedAt < b.issuedAt ? 1 : -1)[0];
  }
  const rows = await RequestModel.findAll(p, { where:{ taskId:id } });
  assert.equal(rows.length, 1, 'Exactly one stored request for task');
  return rows[0];
}
// The state this node derived for each run on a request. null = not derived yet = the first state.
async function statesOf(p, requestId) {
  const runs = await FlowInstance.findAll(p, { subject:requestId });
  if (!runs.length) return [];
  return (await p.flowStates(runs.map(run => run.uri)))
    .map(entry => entry.currentState === null ? 'Received' : entry.currentState.split(/[./#]/).pop());
}
export async function runOn(p, requestId) {
  const runs = await FlowInstance.findAll(p, { subject:requestId });
  assert.equal(runs.length, 1, 'Exactly one flow run for request');
  return runs[0];
}
// vote: one person proposes the transition. AD4M signs the vote with that person's key.
export async function vote(action, name, options = {}) {
  if (!['accept','reject'].includes(action) || !name) throw new Error('vote <accept|reject> --as <name>');
  return openAs(name, async ({ p }) => {
    const request = await taskOn(p, options.task);
    const run = await runOn(p, request.id);
    // Every voter names the same output: the stored request. The receipt commits to it.
    const result = await run.proposeTransition(action === 'accept' ? 'Accepted' : 'Rejected', options.why,
      [{ className:'IiwTrustTaskRequest', id:request.id }]);
    return { ...result, taskId:request.taskId };
  });
}
// respond: the flow has ended. Mint its receipt, check it, answer the requester.
export async function respond(options = {}) {
  // Same lock as receive: one answer per request, even if respond runs twice at once.
  return deliveryLock(() => openAs(owner(), async ({ p }) => {
    const stored = await taskOn(p, options.task);
    const request = JSON.parse(stored.raw);
    const path = resolve(ROOT, 'out/response-' + shortId(request.id) + '.json');
    // One request, one signed answer: a second respond returns the stored one unchanged.
    const prior = await ResponseModel.findOne(p, { where:{ inResponseTo:request.id } });
    if (prior) {
      const response = JSON.parse(prior.raw);
      saveJson(path, response);
      return { existing:true, response, path };
    }
    const run = await runOn(p, stored.id);
    // mint re-derives terminality; never authorize from the display-only cache.
    let minted;
    try { minted = await p.mintFlowReceipt(run.uri); }
    catch (error) {
      throw Object.assign(new Error('Flow not finished (state ' + run.currentStateName + '): ' + error.message), { exitCode:4 });
    }
    const verdict = await p.verifyFlowReceipt(minted.receipt);
    if (verdict.outcome !== 'verified') throw Object.assign(new Error('Receipt ' + verdict.outcome + ': ' + verdict.detail), { exitCode:4 });
    const sha256 = minted.receiptUri.split('/').at(-1);
    // STOP on mismatch; never substitute our own hash or rewrite AD4M's receipt URI.
    assert.equal(receiptSha256(minted.receipt), sha256, 'Real minted receipt canonical SHA256 must match URI');
    const flowReceipt = { uri:minted.receiptUri, sha256, flow:FLOW,
      terminalState:verdict.terminalState, voters:verdict.voters, receipt:minted.receipt };
    let unsigned;
    if (verdict.terminalState === 'Accepted') {
      unsigned = respondWith(request, uuid(), { entry:request.payload.entry, ext:{ [NS]:{ flowReceipt } } });
      assertPayload(RESPONSE_PAYLOAD_SCHEMA, unsigned.payload);
    } else if (verdict.terminalState === 'Rejected') {
      unsigned = rejectWith(request, uuid(), { code:'permissionDenied',
        message:"Declined by the space's group (flow TrustTaskDecision → Rejected).",
        retryable:false, details:{ [NS]:{ flowReceipt } } });
    } else throw new Error('Unexpected receipt terminal state');
    const response = sign(unsigned, loadOrCreateKey('space').signer);
    saveJson(path, response);
    // Child creation only: do not mutate the completed request's properties.
    await ResponseModel.create(p, { raw:JSON.stringify(response), inResponseTo:request.id,
      kind:verdict.terminalState === 'Accepted' ? 'response' : 'error' },
      { parent:{ id:stored.id, predicate:'ad4m://has_child' } });
    return { response, path, verdict, receiptUri:minted.receiptUri, receiptHashMatch:true };
  }));
}
// check-receipt: any member's node can re-check a receipt against the links it holds.
export async function checkReceipt(file, name) {
  const answer = readJson(resolve(ROOT, file));
  const flowReceipt = answer.payload?.ext?.[NS]?.flowReceipt ?? answer.payload?.details?.[NS]?.flowReceipt;
  if (!flowReceipt) throw new Error('No flow receipt in ' + file);
  return openAs(name ?? Object.keys(readSpace().uuids)[0], async ({ p }) => p.verifyFlowReceipt(flowReceipt.receipt));
}
export async function status(name) {
  return openAs(name ?? Object.keys(readSpace().uuids)[0], async ({ space, p }) => {
    const requests = await RequestModel.findAll(p);
    return { space, people:publicPeople(readPeople()), requests:await Promise.all(requests.map(async request => {
      return { taskId:request.taskId, requestId:request.id, role:request.role,
        states:await statesOf(p, request.id),
        responded:!!await ResponseModel.findOne(p, { where:{ inResponseTo:request.taskId } }) };
    })) };
  });
}

// ── 4. The command line ─────────────────────────────────────────────────────────
const listPeople = (people, uuids) => Object.entries(people).filter(([name]) => !uuids || uuids[name])
  .map(([name, person]) => '  ' + name + '  ' + person.did + (person.login === 'agent' ? '  (this node\'s agent)' : '  (user on this node)')).join('\n');
if (isMain(import.meta.url)) {
  const { positional, options } = args(process.argv.slice(2));
  try {
    let result, lines;
    switch (positional[0]) {
      case 'agent':
        // The passphrase is only ever typed or piped in, never a flag (flags end up in shell history).
        if ('passphrase' in options) throw new Error('No --passphrase flag: type it at the prompt, or pipe it in');
        result = await agent({ as:options.as, remember:options.remember });
        lines = [(result.created ? 'created this node\'s agent: ' : result.wasReady ? 'this node\'s agent is unlocked: ' : 'unlocked this node\'s agent: ') + result.name + ' ' + result.did,
          result.remembered ? 'passphrase kept in .demo/agent-passphrase (you asked for --remember)' : 'passphrase not stored; after a node restart, run `node demo.mjs agent` again'];
        break;
      case 'users':
        if (positional[1] !== 'add') throw new Error('users add <name>…');
        result = await addUsers(positional.slice(2));
        lines = ['multi-user mode on; people on this node:', listPeople(result.people)];
        break;
      case 'show':
        result = show();
        lines = options.links ? showLinks() : result.lines;
        break;
      case 'space':
        result = await makeSpace(options);
        lines = [(result.existing ? 'This folder already has a space; keeping it.\n' : '') + 'space ' + Object.values(result.uuids)[0] + ', owner ' + result.owner,
          'in it:', listPeople(result.people, result.uuids),
          'flow ' + FLOW + ' installed: Received → Accepted (2 votes) | Rejected (1 vote)',
          'trust-task DID of the space ' + result.spaceDid + '  (requests go to this DID)'];
        break;
      case 'share':
        result = await share(options);
        lines = ['neighbourhood ' + result.neighbourhood + '  (link language: ' + result.link + ')',
          'to join it: node demo.mjs join ' + result.neighbourhood + ' --as <name>'];
        break;
      case 'join':
        result = await join(positional[1], options);
        lines = ['joined as ' + result.name + ' ' + result.did,
          result.synced ? 'flow ' + FLOW + ' synced in' : 'flow not synced yet; wait a little, then vote'];
        break;
      case 'receive':
        result = await receive(positional[1]);
        lines = result.kind === 'accepted' ? [
          'schema ✓ recipient ✓ fresh ✓ proof ✓ not a duplicate ✓',
          'stored losslessly ✓  flow started: ' + result.state + '  (run ' + result.runUri + ')'
        ] : result.kind === 'rejected' ? ['refused before any flow: ' + result.code + ' (nothing stored) → signed error ' + rel(result.path)]
          : [result.kind + (result.inFlight ? ' (in flight)' : '') + (result.startedNow ? '; its flow had not started, started it now' : '')
            + (result.path ? ' → ' + rel(result.path) : '')];
        if (result.kind === 'rejected') process.exitCode = 3;
        break;
      case 'vote':
        result = await vote(positional[1], options.as, options);
        lines = [options.as + ' votes ' + positional[1] + ': ' + (result.outcomes.length
            ? 'decided, ' + result.outcomes.map(o => o.fromState + ' → ' + o.toState + ', voters ' + o.voters.map(shortDid).join(' + ')).join('; ')
            : result.recordedVote ? 'vote recorded, waiting for more votes' : 'already voted, nothing written'),
          'state: ' + result.derivedState + (result.contested ? ' (contested: stalled)' : '')];
        break;
      case 'respond':
        result = await respond(options);
        lines = result.existing ? ['already answered; same signed ' + result.response.type + ' → ' + rel(result.path)] : ['flow receipt ' + result.receiptUri,
          'verifyFlowReceipt: ' + result.verdict.outcome + ' ✓  terminal state ' + result.verdict.terminalState + ', voters ' + result.verdict.voters.map(shortDid).join(' + '),
          'signed ' + result.response.type + ' → ' + rel(result.path)];
        break;
      case 'check-receipt': {
        const file = positional[1] ?? 'out/response-' + shortId(readJson(resolve(ROOT, 'out/request.json')).id) + '.json';
        result = await checkReceipt(file, options.as);
        lines = ['verifyFlowReceipt on this node: ' + result.outcome + (result.outcome === 'verified' ? ' ✓' : ' ✗') + '  ' + (result.detail ?? '')];
        if (result.outcome !== 'verified') process.exitCode = 1;
        break;
      }
      case 'status':
        result = await status(options.as);
        lines = [(result.space.neighbourhood ? 'shared space ' + result.space.neighbourhood : 'local space') + (result.space.owner ? ', owner ' + result.space.owner : ''),
          ...result.requests.map(request => request.taskId + '  ' + request.role + '  ' + request.states.join(',') + (request.responded ? '  answered' : ''))];
        break;
      default: throw new Error('Usage: node demo.mjs agent | users add <name>… | show [--links] | space [--as <name>] | '
        + 'share [--link holochain|server] | join <url> [--as <name>] | receive <file> | vote <accept|reject> --as <name> | '
        + 'respond | check-receipt [<file>] | status   [--json]');
    }
    emit(result, lines, options.json);
  } catch (error) { cliError(error, options.json); }
}
