// The guided web page for this demo: `npm start`, then open the address it prints.
//
// A small HTTP server on 127.0.0.1 and one plain page (ui/). Each button calls the same
// functions the command line uses (demo.mjs, requester.mjs). The server also starts and stops
// the local AD4M node, the way start-node.sh does, and records the @coasys/ad4m SDK calls each
// button makes, so the page can show them next to the result.
//
// Never sent to the page or written to its log: passwords, passphrases, tokens (JWTs) and the
// node's admin credential. Every answer and the log tail go through redact() first.
import http from 'node:http';
import { createConnection } from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, statSync, openSync, closeSync, readSync, renameSync,
  rmSync, mkdirSync, chmodSync, createWriteStream, readdirSync } from 'node:fs';
import { resolve, extname, join as joinPath, isAbsolute, delimiter } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { platform, arch } from 'node:os';
import { Ad4mClient, PerspectiveProxy, FlowInstance, SHACLFlow } from '@coasys/ad4m';
import * as demo from './demo.mjs';
import * as requester from './requester.mjs';
import { ROOT, STATE, NS, FLOW, shortId, readJson, saveJson, stateDir, loadOrCreateKey } from './common.mjs';

const UI_PORT = Number(process.env.UI_PORT ?? 8740);
const SETTINGS_PATH = resolve(ROOT, '.ui-settings.json');
const LOG_PATH = resolve(ROOT, '.node.log');
const BIN_DIR = resolve(ROOT, 'bin');
const NODE_DIR = resolve(ROOT, process.env.NODE_DIR ?? '.node');
const credentialPath = () => resolve(NODE_DIR, 'admin-credential');
const peoplePath = resolve(STATE, 'people.json');
const spacePath = resolve(STATE, 'space.json');
const tokenPath = resolve(STATE, 'app-token');
// v0.13.1, or its last staging build while the release is not out. AD4M_RELEASE_TAGS overrides.
const RELEASE_TAGS = (process.env.AD4M_RELEASE_TAGS ?? 'v0.13.1,v0.13.1-staging.6').split(',').map(t => t.trim()).filter(Boolean);

// ── Settings: which executor, which port, multi-user on or off ─────────────────
const defaults = { executor:process.env.AD4M_EXECUTOR ?? '', port:Number(process.env.AD4M_PORT ?? 12100), multiUser:false };
let settings = { ...defaults, ...(existsSync(SETTINGS_PATH) ? readJson(SETTINGS_PATH) : {}) };
const saveSettings = () => saveJson(SETTINGS_PATH, settings);
const nodeUrl = () => 'http://127.0.0.1:' + settings.port;
// demo.mjs reads these on every call.
const applyEnv = () => { process.env.AD4M_URL = nodeUrl(); process.env.NODE_DIR = NODE_DIR; };
applyEnv();

// ── Masking ─────────────────────────────────────────────────────────────────────
let appToken = existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() : null;
demo.useAppToken(appToken);
function knownSecrets() {
  const list = [];
  try { list.push(readFileSync(credentialPath(), 'utf8').trim()); } catch {}
  try { for (const person of Object.values(readJson(peoplePath))) if (person.password) list.push(person.password); } catch {}
  try { list.push(readFileSync(resolve(STATE, 'agent-passphrase'), 'utf8').replace(/\r?\n$/, '')); } catch {}
  if (appToken) list.push(appToken);
  return list;
}
export function redact(text, extra = []) {
  let out = String(text);
  for (const secret of [...knownSecrets(), ...extra]) {
    if (!secret || secret.length < 4) continue;
    for (const form of new Set([secret, JSON.stringify(secret).slice(1, -1)])) out = out.split(form).join('‹hidden›');
  }
  return out
    .replace(/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/g, '‹token hidden›')
    .replace(/(TEST MODE code for \S+ = )\S+/g, '$1‹hidden›');
}
// The node's log is free text: also hide anything written as password=…, token: … and the like.
const redactLog = text => redact(text)
  .replace(/\b((?:password|passphrase|credential|jwt|bearer|token)\b["']?\s*[:=]\s*["']?)[^\s"',}]{4,}/gi, '$1‹hidden›');

// ── Recording the SDK calls a button makes ──────────────────────────────────────
// Each request runs in its own async context with a list of calls. Only the outermost SDK
// call is recorded: what demo.mjs calls, not what the SDK does inside that call.
const trace = new AsyncLocalStorage();
const SECRET_ARGS = { 'agent.generate':[0], 'agent.unlock':[0], 'agent.lock':[0], 'agent.loginUser':[1], 'agent.createUser':[1] };
const SECRET_RESULTS = new Set(['agent.loginUser', 'agent.generateJwt', 'agent.verifyEmailCode']);
function brief(value, depth = 0) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value.length > 90 ? value.slice(0, 87) + '…' : value);
  if (typeof value === 'function') return 'ƒ';
  if (value instanceof PerspectiveProxy) return '‹space ' + value.uuid + '›';
  if (value instanceof SHACLFlow) return '‹SHACLFlow ' + value.name + '›';
  if (value instanceof FlowInstance) return '‹flow run ' + value.uri + ', state ' + (value.currentStateName ?? 'Received') + '›';
  // An instance of a model class: its class and its address in the space.
  if (typeof value === 'object' && typeof value._baseExpression === 'string')
    return '‹' + (value.constructor?.className ?? value.constructor?.name ?? 'instance') + ' ' + value._baseExpression + (value.taskId ? ', taskId ' + JSON.stringify(value.taskId) : '') + '›';
  if (Array.isArray(value)) {
    if (depth > 1) return '[' + value.length + ' items]';
    const shown = value.slice(0, 4).map(v => brief(v, depth + 1));
    return '[' + shown.join(', ') + (value.length > 4 ? ', … ' + (value.length - 4) + ' more' : '') + ']';
  }
  if (typeof value === 'object') {
    const name = value.constructor?.name && value.constructor.name !== 'Object' ? value.constructor.name + ' ' : '';
    if (depth > 1) return name + '{…}';
    const keys = Object.keys(value);
    if (keys.includes('didDocument')) keys.splice(keys.indexOf('didDocument'), 1);
    return name + '{ ' + keys.slice(0, 7).map(k => k + ':' + brief(value[k], depth + 1)).join(', ') + (keys.length > 7 ? ', …' : '') + ' }';
  }
  return String(value);
}
function wrap(owner, key, label, isStatic) {
  const original = owner[key];
  if (typeof original !== 'function' || original.__traced) return;
  const traced = function (...args) {
    const store = trace.getStore();
    // Skip the SDK's own wiring (set…Client, cache clearing): it is not a call to the node.
    if (!store || store.depth > 0 || /^set\w*Client$|Cache$/.test(key)) return original.apply(this, args);
    const name = label + '.' + key;
    const hidden = SECRET_ARGS[name.replace(/^ad4m\./, '')] ?? [];
    const entry = { call:name + '(' + args.map((a, i) => hidden.includes(i) ? '"•••"' : brief(a)).join(', ') + ')' };
    store.calls.push(entry);
    const started = Date.now();
    const done = result => {
      entry.ms = Date.now() - started;
      entry.result = SECRET_RESULTS.has(name.replace(/^ad4m\./, '')) ? '‹token, not shown›' : brief(result);
      return result;
    };
    const fail = error => { entry.ms = Date.now() - started; entry.error = error?.message ?? String(error); throw error; };
    return trace.run({ ...store, depth:1 }, () => {
      try {
        const out = original.apply(this, args);
        return out && typeof out.then === 'function' ? out.then(done, fail) : done(out);
      } catch (error) { fail(error); }
    });
  };
  traced.__traced = true;
  if (isStatic) Object.defineProperty(owner, key, { value:traced, writable:true, configurable:true });
  else owner[key] = traced;
}
function wrapPrototype(proto, label, only) {
  for (const key of only ?? Object.getOwnPropertyNames(proto)) {
    if (key === 'constructor') continue;
    const descriptor = Object.getOwnPropertyDescriptor(proto, key);
    if (descriptor && typeof descriptor.value === 'function') wrap(proto, key, label, false);
  }
}
{
  const probe = new Ad4mClient('http://127.0.0.1:9');
  for (const part of ['agent', 'perspective', 'neighbourhood', 'runtime', 'languages']) wrapPrototype(Object.getPrototypeOf(probe[part]), 'ad4m.' + part);
  probe.close();
  wrapPrototype(PerspectiveProxy.prototype, 'space', ['addFlow', 'getFlow', 'flowStates', 'mintFlowReceipt', 'verifyFlowReceipt', 'sdnaFlows']);
  wrapPrototype(FlowInstance.prototype, 'run', ['proposeTransition', 'proposals']);
  for (const key of ['start', 'findAll']) wrap(FlowInstance, key, 'FlowInstance', true);
  for (const [model, label] of [[demo.RequestModel, 'IiwTrustTaskRequest'], [demo.ResponseModel, 'IiwTrustTaskResponse']])
    for (const key of ['register', 'create', 'findAll', 'findOne']) wrap(model, key, label, true);
}

// ── The executor: find it, or download it ───────────────────────────────────────
const assetPattern = () => platform() === 'linux' && arch() === 'x64' ? /^ad4m-cli-executor-linux-[\w.-]+-x64$/
  : platform() === 'darwin' && arch() === 'arm64' ? /^ad4m-cli-executor-macos-[\w.-]+-aarch64$/ : null;
let releaseCache = null;
async function findRelease() {
  if (releaseCache && Date.now() - releaseCache.at < 300000) return releaseCache.value;
  const tried = [];
  let value = null;
  for (const tag of RELEASE_TAGS) {
    const response = await fetch('https://api.github.com/repos/coasys/ad4m/releases/tags/' + tag,
      { headers:{ 'User-Agent':'iiw-ad4m-trust-task-demo', Accept:'application/vnd.github+json' }, signal:AbortSignal.timeout(10000) });
    if (response.status === 404) { tried.push(tag + ': not published'); continue; }
    if (!response.ok) { tried.push(tag + ': GitHub answered ' + response.status); continue; }
    const release = await response.json();
    const pattern = assetPattern();
    const asset = pattern && release.assets.find(a => pattern.test(a.name));
    value = { tag, page:release.html_url, prerelease:release.prerelease,
      asset:asset ? { name:asset.name, size:asset.size, url:asset.browser_download_url } : null,
      assets:release.assets.filter(a => a.name.startsWith('ad4m-cli-executor')).map(a => ({ name:a.name, url:a.browser_download_url })) };
    break;
  }
  value = { release:value, tried, os:platform() + ' ' + arch(), supported:!!assetPattern() };
  releaseCache = { at:Date.now(), value };
  return value;
}
const download = { active:false, received:0, total:0, error:null, done:false, name:null };
async function startDownload() {
  if (download.active) return download;
  const { release } = await findRelease();
  if (!release?.asset) throw new Error('No executor download for this computer yet (see the list above)');
  Object.assign(download, { active:true, received:0, total:release.asset.size, error:null, done:false, name:release.asset.name });
  mkdirSync(BIN_DIR, { recursive:true });
  const target = resolve(BIN_DIR, release.asset.name), part = target + '.part';
  (async () => {
    const response = await fetch(release.asset.url, { headers:{ 'User-Agent':'iiw-ad4m-trust-task-demo' } });
    if (!response.ok) throw new Error('Download failed: ' + response.status);
    const count = new Transform({ transform(chunk, _enc, next) { download.received += chunk.length; next(null, chunk); } });
    await pipeline(Readable.fromWeb(response.body), count, createWriteStream(part));
    renameSync(part, target);
    chmodSync(target, 0o755);
    // macOS marks downloaded files as quarantined; a file this server wrote is not, but clear it anyway.
    if (platform() === 'darwin') await new Promise(done => execFile('xattr', ['-d', 'com.apple.quarantine', target], () => done()));
    settings.executor = target; saveSettings();
    download.done = true;
  })().catch(error => { download.error = error.message; rmSync(part, { force:true }); })
    .finally(() => { download.active = false; });
  return download;
}
function onPath(name) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = joinPath(dir, name);
    if (dir && existsSync(candidate)) return candidate;
  }
  return null;
}
function executorPath() {
  if (settings.executor) return settings.executor;
  if (existsSync(BIN_DIR)) {
    const found = readdirSync(BIN_DIR).find(name => /^ad4m-(cli-)?executor/.test(name) && !name.endsWith('.part'));
    if (found) return resolve(BIN_DIR, found);
  }
  return onPath('ad4m-executor') ?? '';
}
const versions = new Map();
function executorVersion(path) {
  if (!path) return Promise.resolve({ ok:false, error:'No executor chosen yet' });
  if (!existsSync(path)) return Promise.resolve({ ok:false, error:'No file at ' + path });
  const key = path + ':' + statSync(path).mtimeMs;
  if (versions.has(key)) return Promise.resolve(versions.get(key));
  return new Promise(done => execFile(path, ['--version'], { timeout:15000 }, (error, stdout) => {
    const value = error ? { ok:false, error:'Could not run it: ' + (error.code === 'EACCES' ? 'not executable (chmod +x)' : error.message.split('\n')[0]) }
      : { ok:true, version:stdout.trim() };
    if (!error) versions.set(key, value);
    done(value);
  }));
}

// ── The node: start, stop, status, log ──────────────────────────────────────────
const pidPath = resolve(NODE_DIR, 'executor.pid');
const node = { child:null, pid:null, phase:'stopped', error:null, startedAt:null, command:null };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
// A node this page started before it was restarted: adopt it.
if (existsSync(pidPath)) {
  const pid = Number(readFileSync(pidPath, 'utf8'));
  if (pid && alive(pid)) Object.assign(node, { pid, phase:'running', startedAt:Date.now() });
}
const withTimeout = (promise, ms, what) => Promise.race([promise,
  delay(ms).then(() => { throw new Error(what + ' did not answer in ' + ms / 1000 + ' s'); })]);
class QuietWebSocket extends WebSocket { close(code, reason) { this.onerror = null; super.close(code, reason); } }
const client = token => new Ad4mClient(nodeUrl(), token, { webSocketImpl:QuietWebSocket });
async function asAdmin(callback) {
  const admin = client(readFileSync(credentialPath(), 'utf8').trim());
  try { return await callback(admin); } finally { admin.close(); }
}
function runScript(args, extraEnv) {
  return new Promise((done, fail) => {
    const child = spawn('bash', [resolve(ROOT, 'start-node.sh'), ...args], { cwd:ROOT, env:{ ...process.env, ...extraEnv } });
    let out = '';
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
    child.on('close', code => code === 0 ? done(out) : fail(new Error(out.trim().split('\n').slice(-3).join(' ') || 'exit ' + code)));
  });
}
async function startNode({ multiUser, port }) {
  if (node.phase === 'running' || node.phase === 'starting') throw new Error('The node is already ' + node.phase);
  const executor = executorPath();
  const check = await executorVersion(executor);
  if (!check.ok) throw new Error('Choose the executor first (step 1): ' + check.error);
  if (port) settings.port = Number(port);
  settings.multiUser = !!multiUser; saveSettings(); applyEnv();
  if (await portOpen(settings.port)) throw new Error('Port ' + settings.port + ' is in use (another node?). Stop it, or pick another port');
  const env = { AD4M_EXECUTOR:executor, AD4M_PORT:String(settings.port), NODE_DIR };
  node.error = null;
  writeFileSync(LOG_PATH, '');
  if (!existsSync(credentialPath())) {
    if (existsSync(NODE_DIR)) throw new Error(NODE_DIR + ' exists but has no admin credential: use "Start over" in step 2');
    node.phase = 'creating';
    writeFileSync(LOG_PATH, '$ ./start-node.sh init\n' + await runScript(['init'], env).catch(error => { node.phase = 'stopped'; throw error; }));
  }
  const args = ['run', '--enable-multi-user', String(settings.multiUser)];
  node.command = 'AD4M_EXECUTOR=' + executor + ' AD4M_PORT=' + settings.port + ' AD4M_LOG_SECRETS=1 ./start-node.sh ' + args.join(' ');
  const log = openSync(LOG_PATH, 'a');
  writeFileSync(LOG_PATH, '$ ' + node.command + '\n', { flag:'a' });
  // AD4M_LOG_SECRETS=1 makes the node print the one-time code of a capability request (step 4).
  const child = spawn('bash', [resolve(ROOT, 'start-node.sh'), ...args],
    { cwd:ROOT, env:{ ...process.env, ...env, AD4M_LOG_SECRETS:'1' }, stdio:['ignore', log, log], detached:true });
  closeSync(log);
  Object.assign(node, { child, pid:child.pid, phase:'starting', startedAt:Date.now() });
  writeFileSync(pidPath, String(child.pid));
  child.on('exit', (code, signal) => {
    if (node.child !== child) return;
    if (node.phase !== 'stopping') node.error = 'The node stopped by itself (' + (signal ?? 'exit code ' + code) + '); see its log';
    Object.assign(node, { child:null, pid:null, phase:'stopped' });
    rmSync(pidPath, { force:true });
  });
  // Ready when its port is open and it answers its API. (Outside this request's trace.)
  trace.exit(() => (async () => {
    for (let i = 0; i < 240 && node.child === child; i++) {
      try {
        if (!await portOpen(settings.port)) throw new Error('not yet');
        await withTimeout(asAdmin(admin => admin.agent.status()), 3000, 'node'); node.phase = 'running'; return;
      } catch { await delay(500); }
    }
    if (node.child === child && node.phase === 'starting') node.error = 'The node did not answer after 2 minutes; see its log';
  })());
  return { command:node.command };
}
const portOpen = port => new Promise(done => {
  const socket = createConnection({ host:'127.0.0.1', port }, () => { socket.end(); done(true); });
  socket.on('error', () => done(false));
});
async function stopNode() {
  const pid = node.pid;
  if (!pid) return { stopped:false };
  node.phase = 'stopping';
  try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
  for (let i = 0; i < 60 && alive(pid); i++) await delay(250);
  if (alive(pid)) { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} } }
  Object.assign(node, { child:null, pid:null, phase:'stopped' });
  rmSync(pidPath, { force:true });
  forgetToken('the node stopped');
  return { stopped:true };
}
function logTail(lines = 80) {
  if (!existsSync(LOG_PATH)) return [];
  const size = statSync(LOG_PATH).size, length = Math.min(size, 256 * 1024);
  const buffer = Buffer.alloc(length);
  const fd = openSync(LOG_PATH, 'r');
  try { readSync(fd, buffer, 0, length, size - length); } finally { closeSync(fd); }
  // eslint-disable-next-line no-control-regex
  const text = buffer.toString('utf8').replace(/\x1b\[[0-9;]*m/g, '');
  return redactLog(text).split('\n').filter(Boolean).slice(-lines);
}

// ── The app's token (step 4) ────────────────────────────────────────────────────
const APP = { appName:'IIW trust-task demo page', appDesc:'Guides you through a ToIP trust task decided by an AD4M flow',
  appDomain:'localhost', appUrl:'http://127.0.0.1:' + UI_PORT,
  capabilities:[{ with:{ domain:'*', pointers:['*'] }, can:['*'] }] };
const handshake = { requestId:null, requestedAt:null, connectedDid:null, refused:null };
function forgetToken(reason) {
  appToken = null; demo.useAppToken(null); rmSync(tokenPath, { force:true });
  handshake.connectedDid = null; handshake.refused = reason ?? null;
}

// ── What the page shows at the top: the whole state, cheap to read ──────────────
const readPeople = () => existsSync(peoplePath) ? readJson(peoplePath) : {};
const publicPeople = () => Object.fromEntries(Object.entries(readPeople()).map(([name, p]) => [name, { did:p.did, login:p.login }]));
const loggedIn = new Set();
async function state() {
  const executor = executorPath();
  const out = {
    executor:{ path:executor, ...(await executorVersion(executor)) }, download, settings,
    node:{ phase:node.phase, pid:node.pid, url:nodeUrl(), error:node.error, command:node.command, created:existsSync(credentialPath()) },
    people:publicPeople(), loggedIn:[...loggedIn],
    space:existsSync(spacePath) ? readJson(spacePath) : null,
    app:{ hasToken:!!appToken, requestId:handshake.requestId, did:handshake.connectedDid, refused:handshake.refused },
    agent:null, multiUser:null
  };
  if (node.phase === 'running' && existsSync(credentialPath()) && await portOpen(settings.port)) {
    try {
      await withTimeout(asAdmin(async admin => {
        const status = await admin.agent.status();
        out.agent = { initialized:status.isInitialized, unlocked:status.isUnlocked, did:status.did ?? null };
        out.multiUser = await admin.runtime.multiUserEnabled().catch(() => null);
      }), 5000, 'node');
    } catch (error) { out.agent = { error:error.message }; }
    if (appToken && out.agent?.unlocked) {
      const app = client(appToken);
      try { handshake.connectedDid = (await withTimeout(app.agent.me(), 5000, 'node')).did; handshake.refused = null; out.app.did = handshake.connectedDid; }
      catch (error) { if (/401|auth|token|session/i.test(error.message)) forgetToken('The node refused the token: ' + error.message); out.app.error = error.message; }
      finally { app.close(); }
    }
  }
  return out;
}

// ── The steps ───────────────────────────────────────────────────────────────────
const space = () => { if (!existsSync(spacePath)) throw new Error('No space yet (step 5)'); return readJson(spacePath); };
const viewer = () => { const s = space(); return Object.keys(s.uuids)[0]; };
const nameOf = did => Object.entries(readPeople()).find(([, p]) => p.did === did)?.[0] ?? null;
const sentPath = taskId => resolve(STATE, 'requester-sent', shortId(taskId) + '.json');
const responsePath = taskId => resolve(ROOT, 'out/response-' + shortId(taskId) + '.json');
const receiptOf = doc => doc?.payload?.ext?.[NS]?.flowReceipt ?? doc?.payload?.details?.[NS]?.flowReceipt;

const routes = {
  'GET /api/state': () => state(),
  'GET /api/release': () => findRelease(),
  'POST /api/executor/download': () => startDownload(),
  async 'POST /api/executor/use'({ path }) {
    if (!path || !isAbsolute(path)) throw new Error('Give the full path to the executor file');
    const check = await executorVersion(path);
    if (!check.ok) throw new Error(check.error);
    settings.executor = path; saveSettings();
    return { path, version:check.version };
  },
  'POST /api/node/start': body => startNode(body),
  'POST /api/node/stop': () => stopNode(),
  'GET /api/node/log': (_body, query) => ({ lines:logTail(Number(query.get('lines') ?? 80)) }),
  async 'POST /api/node/reset'() {
    // Start over: the node's data and this folder's demo state belong together.
    await stopNode();
    // .demo-test (npm test) names users of this node too.
    for (const path of [NODE_DIR, STATE, resolve(ROOT, '.demo-test'), LOG_PATH, resolve(ROOT, 'out')]) rmSync(path, { recursive:true, force:true });
    loggedIn.clear(); forgetToken(null); handshake.requestId = null; handshake.refused = null;
    return { removed:['.node', '.demo', '.demo-test', 'out', '.node.log'] };
  },

  // Step 3: the node's agent, and people on the node.
  async 'POST /api/agent'({ name, passphrase, remember }) {
    if (!passphrase) throw new Error('Type the passphrase');
    const result = await demo.agent({ as:name || undefined, passphrase, remember:!!remember, noPrompt:true });
    return result;
  },
  'POST /api/users/add': ({ name }) => demo.addUsers([String(name ?? '').trim()]),
  async 'POST /api/users/login'({ name }) {
    const person = readPeople()[name];
    if (!person || person.login !== 'user') throw new Error(name + ' is not a user on this node');
    const token = await asAdmin(admin => admin.agent.loginUser(person.email, person.password));
    const user = client(token);
    try {
      const me = await user.agent.me();
      loggedIn.add(name);
      return { name, did:me.did, note:'token received; the server keeps it and never shows it' };
    } finally { user.close(); }
  },

  // Step 4: the capability handshake.
  async 'POST /api/handshake/request'() {
    const app = client();            // no token yet: this is what any app starts with
    try {
      handshake.requestId = await app.agent.requestCapability(APP);
      handshake.requestedAt = Date.now();
      handshake.refused = null;
      return { requestId:handshake.requestId, asked:APP };
    } finally { app.close(); }
  },
  'GET /api/handshake/logline'() {
    if (!handshake.requestId) return { line:null };
    const line = logTail(4000).find(l => l.includes('request_id=' + handshake.requestId));
    return { line:line ?? null, code:line?.match(/rand=(\d{6})/)?.[1] ? 'found' : null };
  },
  async 'POST /api/handshake/redeem'({ code }) {
    if (!handshake.requestId) throw new Error('Ask for access first');
    if (!/^\d{6}$/.test(String(code ?? '').trim())) throw new Error('The code has 6 digits');
    const app = client();
    let token;
    try { token = await app.agent.generateJwt(handshake.requestId, String(code).trim()); } finally { app.close(); }
    const connected = client(token);
    try {
      const me = await connected.agent.me();
      appToken = token; demo.useAppToken(token); stateDir();
      writeFileSync(tokenPath, token + '\n', { mode:0o600 }); chmodSync(tokenPath, 0o600);
      handshake.connectedDid = me.did; handshake.requestId = null; handshake.refused = null;
      return { connected:true, did:me.did, note:'token received; the server keeps it and never shows it' };
    } finally { connected.close(); }
  },
  'POST /api/handshake/forget': () => { forgetToken(null); return { forgotten:true }; },

  // Step 5: the space.
  async 'GET /api/templates'() {
    const templates = appToken ? await (async () => { const app = client(appToken); try { return await app.runtime.knownLinkLanguageTemplates(); } finally { app.close(); } })()
      : await asAdmin(admin => admin.runtime.knownLinkLanguageTemplates());
    return templates.map(t => ({ name:t.name, address:t.address,
      demo:t.name === 'Server Link Language' ? 'server' : t.name === 'perspectiveDiffSync' ? 'holochain' : null }));
  },
  'POST /api/space/local': ({ as }) => demo.makeSpace({ as:as || undefined, bare:true }),
  async 'POST /api/space/share'({ as, link, serverUrl }) {
    if (!existsSync(spacePath)) await demo.makeSpace({ as:as || undefined, bare:true });
    return demo.share({ link, 'server-url':serverUrl || undefined });
  },
  'POST /api/space/join': ({ url, as }) => demo.join(String(url ?? '').trim(), { as:as || undefined, wait:30 }),

  // Step 6: the trust task and the flow.
  'GET /api/flow/definition': () => { const { header, rows, flow } = demo.show(); return { header, rows, flow }; },
  async 'GET /api/flow/installed'() {
    return demo.openAs(viewer(), async ({ p }) => ({ installed:await demo.hasSocialDna(p), flows:await p.sdnaFlows() }));
  },
  async 'POST /api/flow/install'() {
    const s = space();
    if (!s.owner) throw new Error('This space was joined here; its maker installs the flow, and it syncs to you');
    return demo.openAs(s.owner, async ({ p }) => {
      if (await demo.hasSocialDna(p)) return { installed:true, already:true };
      await demo.installSocialDna(p);
      return { installed:await demo.hasSocialDna(p) };
    });
  },
  async 'POST /api/request/new'({ tamper }) {
    const made = await requester.request();
    if (!tamper) return { doc:made.doc, file:'out/request.json' };
    // Change the role after the requester signed it: the proof no longer matches.
    const changed = structuredClone(made.doc);
    changed.payload.entry.role = 'admin';
    saveJson(resolve(ROOT, 'out/tampered.json'), changed);
    return { doc:changed, file:'out/tampered.json', changed:'payload.entry.role: "member" → "admin", after signing' };
  },
  async 'POST /api/request/receive'({ file }) {
    const which = file === 'out/tampered.json' ? file : 'out/request.json';
    const result = await demo.receive(which);
    return { ...result, ...(result.path ? { path:'out/' + result.path.split('/out/').pop() } : {}) };
  },
  'GET /api/request/latest'() {
    const path = resolve(ROOT, 'out/request.json');
    return { doc:existsSync(path) ? readJson(path) : null };
  },

  // Step 7: the flow runs and the votes.
  async 'GET /api/runs'() {
    const s = space();
    return demo.openAs(viewer(), async ({ p }) => {
      if (!await demo.hasSocialDna(p)) return { runs:[], installed:false };
      const requests = await demo.RequestModel.findAll(p);
      const runs = await FlowInstance.findAll(p, { flowName:'TrustTaskDecision' });
      const states = runs.length ? await p.flowStates(runs.map(run => run.uri)) : [];
      const out = [];
      for (const run of runs) {
        const request = requests.find(r => r.id === run.subject);
        const entry = states.find(e => e.instance === run.uri);
        const proposals = await run.proposals().catch(() => []);
        const response = request ? await demo.ResponseModel.findOne(p, { where:{ inResponseTo:request.taskId } }) : null;
        out.push({ runUri:run.uri, requestId:run.subject, taskId:request?.taskId ?? null, role:request?.role, subject:request?.subject,
          issuer:request?.issuer, issuedAt:request?.issuedAt,
          state:entry?.currentState ? entry.currentState.split(/[./#]/).pop() : 'Received',
          // A proposal's voters: whoever proposed it, plus everyone who accepted it.
          votes:proposals.flatMap(v => [...new Set([v.proposer, ...(v.acceptedBy ?? [])])]
            .map(did => ({ voter:did, name:nameOf(did), toState:v.toState }))),
          responded:!!response, responseKind:response?.kind ?? null });
      }
      out.sort((a, b) => (a.issuedAt ?? '') < (b.issuedAt ?? '') ? 1 : -1);
      return { runs:out, installed:true, voters:Object.keys(s.uuids), owner:s.owner };
    });
  },
  'POST /api/vote': ({ action, as, taskId, why }) => demo.vote(action, as, { task:taskId, why:why || undefined }),

  // Step 8: the receipt, the answer, the requester's checks.
  async 'POST /api/respond'({ taskId }) {
    const result = await demo.respond({ task:taskId });
    return { ...result, path:'out/' + result.path.split('/out/').pop() };
  },
  async 'POST /api/verify'({ taskId }) {
    if (!existsSync(responsePath(taskId))) throw new Error('No answer yet: make it first (left panel)');
    const result = await requester.verify(responsePath(taskId), { request:sentPath(taskId) });
    return { ...result, request:readJson(sentPath(taskId)), response:readJson(responsePath(taskId)) };
  },
  async 'POST /api/check-receipt'({ taskId, as }) {
    // Any member's node can re-check the receipt. The answer is in the space (IiwTrustTaskResponse).
    return demo.openAs(as || viewer(), async ({ p }) => {
      const stored = await demo.ResponseModel.findOne(p, { where:{ inResponseTo:taskId } });
      if (!stored) throw new Error('The answer has not reached this node yet; try again in a few seconds');
      const answer = JSON.parse(stored.raw);
      return { verdict:await p.verifyFlowReceipt(receiptOf(answer).receipt), answer };
    });
  },
  async 'GET /api/answer'(_body, query) {
    const taskId = query.get('taskId');
    return { request:existsSync(sentPath(taskId)) ? readJson(sentPath(taskId)) : null,
      response:existsSync(responsePath(taskId)) ? readJson(responsePath(taskId)) : null };
  }
};

// ── HTTP ────────────────────────────────────────────────────────────────────────
const TYPES = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png' };
const allowedHosts = new Set(['127.0.0.1:' + UI_PORT, 'localhost:' + UI_PORT]);
function send(res, status, body, extraSecrets) {
  const text = redact(JSON.stringify(body), extraSecrets);
  res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' });
  res.end(text);
}
let queue = Promise.resolve();
const serial = task => { const next = queue.then(task, task); queue = next.catch(() => {}); return next; };
const server = http.createServer(async (req, res) => {
  // Only this computer, and only this page: no other host name (DNS rebinding), no other site (CSRF).
  if (!allowedHosts.has(req.headers.host ?? '')) { res.writeHead(403); return res.end('Forbidden host'); }
  const url = new URL(req.url, 'http://' + req.headers.host);
  if (!url.pathname.startsWith('/api/')) {
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const path = resolve(ROOT, 'ui', file);
    if (!path.startsWith(resolve(ROOT, 'ui') + '/') || !existsSync(path)) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type':TYPES[extname(path)] ?? 'application/octet-stream', 'Cache-Control':'no-store' });
    return res.end(readFileSync(path));
  }
  const route = routes[req.method + ' ' + url.pathname];
  if (!route) return send(res, 404, { ok:false, error:'No such call' });
  if (req.method === 'POST') {
    const origin = req.headers.origin;
    if ((origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ''))) || !/^application\/json/.test(req.headers['content-type'] ?? ''))
      return send(res, 403, { ok:false, error:'Forbidden' });
  }
  let body = {};
  if (req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 1e6) return send(res, 413, { ok:false, error:'Too big' }); }
    try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { ok:false, error:'Bad JSON' }); }
  }
  // What the user typed must never come back: hide it in this answer whatever happens.
  const typed = [body.passphrase, body.password].filter(v => typeof v === 'string');
  const store = { calls:[], depth:0 };
  try {
    // One action at a time: the steps read and write the same state files (.demo/).
    const run = () => trace.run(store, () => route(body, url.searchParams));
    const result = await (req.method === 'POST' && url.pathname !== '/api/node/stop' ? serial(run) : run());
    send(res, 200, { ok:true, result, calls:store.calls }, typed);
  } catch (error) {
    // Only the message: RPC errors can carry request data.
    send(res, 200, { ok:false, error:error instanceof Error ? error.message : String(error), calls:store.calls }, typed);
  }
});
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? 'Port ' + UI_PORT + ' is in use. Start with another one: UI_PORT=8741 npm start' : error.message);
  process.exit(1);
});
server.listen(UI_PORT, '127.0.0.1', () => {
  console.log('IIW AD4M trust-task demo: open http://127.0.0.1:' + UI_PORT + ' in your browser.');
  console.log('Ctrl-C stops this page and the AD4M node it started.');
});
let quitting = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (quitting) process.exit(1);
  quitting = true;
  if (node.pid) { console.log('Stopping the AD4M node…'); await stopNode().catch(() => {}); }
  process.exit(0);
});
