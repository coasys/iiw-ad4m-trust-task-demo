// The page. Plain JavaScript: each button calls the local server (ui.mjs), which calls the
// same functions as demo.mjs and requester.mjs and sends back the result and the SDK calls made.
// Left: this demo app, one step at a time. Middle: the SDK calls of each button. Right: the node.
'use strict';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const short = did => did && did.length > 26 ? did.slice(0, 16) + '…' + did.slice(-4) : (did ?? '');
const shortId = id => String(id ?? '').replace(/^urn:uuid:/, '').slice(0, 8);
let S = null;                 // the last state from the server
const memo = { runs:[], members:null, verified:{}, verdicts:{}, installed:null, released:false, lastClick:0, seen:null };

async function api(method, path, body) {
  try {
    const res = await fetch(path, { method, headers:body ? { 'Content-Type':'application/json' } : {}, body:body ? JSON.stringify(body) : undefined });
    return await res.json();
  } catch (error) { return { ok:false, error:'The page server does not answer. Is `npm start` still running? (' + error.message + ')', calls:[] }; }
}
// Run one button: busy state, call, draw its SDK calls on the wire, keep the result under its step.
async function act(button, step, title, method, path, body) {
  if (button) { button.disabled = true; button.classList.add('busy'); }
  memo.lastClick = Date.now();
  const started = Date.now();
  const res = await api(method, path, body);
  if (button) { button.disabled = false; button.classList.remove('busy'); }
  memo.lastClick = Date.now();
  wire(title, res);
  showTrace(step, title, res, Date.now() - started);
  refresh();
  return res;
}
function showTrace(step, title, res, ms) {
  const box = document.querySelector('.trace[data-for="' + step + '"]');
  if (!box) return;
  const calls = (res.calls ?? []).map(c => '<div class="call">' + (c.ms !== undefined ? '<span class="ms">' + c.ms + ' ms</span>' : '')
    + esc(c.call) + (c.error ? '<span class="err">✗ ' + esc(c.error) + '</span>' : '<span class="ret">→ ' + esc(c.result) + '</span>') + '</div>').join('');
  const older = [...box.querySelectorAll(':scope > .entry, :scope > .entry-old')].slice(0, 3);
  const entry = document.createElement('div'); entry.className = 'entry';
  entry.innerHTML = '<h4>' + esc(title) + ' · @coasys/ad4m calls' + (ms ? ' · ' + (ms / 1000).toFixed(1) + ' s' : '') + '</h4>'
    + (calls || '<div class="call muted">No AD4M call: this step ran only local code.</div>')
    + '<h4 style="margin-top:10px">' + (res.ok ? 'Result' : 'Error') + '</h4>'
    + (res.ok ? '<pre>' + esc(JSON.stringify(res.result, null, 2)) + '</pre>' : '<pre class="no-text">' + esc(res.error) + '</pre>');
  box.innerHTML = '';
  box.append(entry);
  for (const old of older) {
    const fold = document.createElement('details'); fold.className = 'entry-old';
    const head = old.querySelector('h4')?.textContent ?? old.querySelector('summary')?.textContent ?? 'earlier';
    fold.innerHTML = '<summary>Earlier: ' + esc(head) + '</summary>';
    fold.append(...(old.tagName === 'DETAILS' ? [...old.childNodes].filter(n => n.tagName !== 'SUMMARY') : [old]));
    box.append(fold);
  }
  if (!res.ok) box.closest('details').open = true;
}
const say = (id, html, kind) => { $(id).innerHTML = kind ? '<span class="' + kind + '">' + html + '</span>' : html; };

// ── The wire: what crossed between this demo app and the node ───────────────────
function wireGroup(what, rows, remote) {
  const list = $('wire-list');
  list.querySelector('.wire-empty')?.remove();
  const group = document.createElement('div');
  group.className = 'wgroup' + (remote ? ' remote' : '');
  const calls = rows.filter(r => r.kind === 'call').length;
  group.innerHTML = '<p class="what"><span>' + esc(what) + '</span>' + (calls ? '<span class="count">' + calls + ' call' + (calls === 1 ? '' : 's') + '</span>' : '') + '</p>' + rows.map((r, i) => '<div class="wrow ' + r.kind + '" style="animation-delay:' + (i * 0.16) + 's" title="Click to see it all">'
    + (r.ms !== undefined ? '<span class="ms">' + r.ms + ' ms</span>' : '') + '<span class="t">' + esc(r.text) + '</span></div>').join('');
  group.querySelectorAll('.wrow').forEach(row => { row.onclick = () => row.classList.toggle('open'); });
  // An older group folds to its one line; click it to see its calls again.
  group.querySelector('.what').onclick = () => group.classList.toggle('unfold');
  list.prepend(group);
  [...list.children].forEach((g, i) => { g.classList.toggle('old', i > 0); if (i > 6) g.remove(); });
}
function wire(title, res) {
  const rows = [];
  for (const c of res.calls ?? []) {
    rows.push({ kind:'call', text:c.call.replace(/^ad4m\./, ''), ms:c.ms });
    rows.push(c.error ? { kind:'err', text:c.error } : { kind:'ret', text:c.result });
  }
  if (!rows.length && res.ok) rows.push({ kind:'ret', text:'no AD4M call: this ran in the app only' });
  if (!res.ok && !(res.calls ?? []).some(c => c.error)) rows.push({ kind:'err', text:res.error });
  wireGroup(title, rows, false);
}
const remote = (what, text) => wireGroup('From another node', [{ kind:'remote', text:what }, ...(text ? [{ kind:'ret', text }] : [])], true);

// ── Who you are, and which steps that needs ─────────────────────────────────────
const PATHS = { host:[1, 2, 3, 4, 5, 6, 7, 8], 'join-here':[1, 7, 8], 'join-own':[1, 2, 3, 4, 5, 7, 8] };
// Kept in this browser, not on the server: two people on one computer each pick their own part.
const role = () => localStorage.getItem('iiw-role') || null;
const path = () => PATHS[role()] ?? PATHS.host;
const me = () => localStorage.getItem('iiw-me') || null;
let current = Number(localStorage.getItem('iiw-step')) || 1;
function showStep(n) {
  if (!path().includes(n)) n = path().filter(k => k <= n).pop() ?? 1;
  current = n; localStorage.setItem('iiw-step', String(n));
  document.querySelectorAll('.step').forEach(s => s.classList.toggle('active', Number(s.dataset.n) === n));
  if (S) render();
  $('nodelog').open = n === 4 && !!S?.app.requestId && !S.app.did;
  window.scrollTo({ top:0, behavior:'smooth' });
}
function move(delta) { const p = path(), i = p.indexOf(current); showStep(p[Math.min(p.length - 1, Math.max(0, i + delta))]); }
$('btn-back').onclick = () => move(-1);
$('btn-next').onclick = () => move(1);
function setRole(value) {
  if (value) localStorage.setItem('iiw-role', value); else localStorage.removeItem('iiw-role');
  $('fork-join-how').classList.add('hidden'); $('fork-join').classList.remove('on');
  showStep(1);
}
document.querySelectorAll('[data-role]').forEach(b => { b.onclick = () => setRole(b.dataset.role); });
$('fork-join').onclick = () => { $('fork-join-how').classList.toggle('hidden'); $('fork-join').classList.toggle('on'); };

// ── State ───────────────────────────────────────────────────────────────────────
async function refresh() {
  const res = await api('GET', '/api/state');
  if (!res.ok) { $('client-light').className = 'light no'; $('client-light').lastChild.textContent = 'page server stopped'; return; }
  S = res.result;
  render();
}
function light(id, kind, text) { const el = $(id); el.className = 'light ' + kind; el.lastChild.textContent = text; }
function done() {
  const n = S.node, a = S.agent, sp = S.space, who = me();
  const inSpace = who && sp?.uuids?.[who];
  return {
    1:role() === 'join-here' ? !!inSpace : !!role() && S.executor.ok,
    2:n.phase === 'running', 3:!!a?.unlocked, 4:!!S.app.did, 5:!!sp,
    6:memo.installed === true && memo.runs.length > 0,
    7:memo.runs.some(r => r.state !== 'Received'), 8:Object.values(memo.verified).some(Boolean)
  };
}
function render() {
  const n = S.node, a = S.agent, sp = S.space;
  const d = done();
  const blockers = {
    2:!S.executor.ok && 'Choose the executor first (step 1).',
    3:n.phase !== 'running' && 'Start the node first (step 2).',
    4:!a?.unlocked && 'Create or unlock the agent first (step 3).',
    5:!S.app.did && 'Connect the page first (step 4).',
    6:!sp && 'Make or join a space first (step 5).',
    7:!sp && (role() === 'join-here' ? 'Get into the space first (step 1).' : 'Make or join a space first (step 5).'),
    8:!sp && (role() === 'join-here' ? 'Get into the space first (step 1).' : 'Make or join a space first (step 5).')
  };
  if (n.phase !== 'running') for (const k of [4, 5, 6, 7, 8]) blockers[k] = blockers[k] || (role() === 'join-here' ? 'No node runs on this computer.' : 'The node is not running (step 2).');
  // Steps and pills for this path.
  if (!path().includes(current)) return showStep(current);
  const pills = path().map(k => '<button class="pill' + (k === current ? ' on' : '') + (d[k] ? ' done' : '') + '" data-step="' + k + '" title="Step ' + k + '">' + k + '</button>').join('');
  if ($('pills').dataset.html !== pills) { $('pills').innerHTML = pills; $('pills').dataset.html = pills; $('pills').querySelectorAll('.pill').forEach(p => { p.onclick = () => showStep(Number(p.dataset.step)); }); }
  for (const k of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const el = $('s' + k);
    el.classList.toggle('done', !!d[k]);
    el.classList.toggle('blocked', !!blockers[k]);
    let b = el.querySelector('.blocker');
    if (blockers[k]) { if (!b) { b = document.createElement('p'); b.className = 'blocker'; el.querySelector('h2').after(b); } b.textContent = blockers[k]; }
    else b?.remove();
  }
  const p = path(), last = p.indexOf(current) === p.length - 1;
  $('btn-back').disabled = p.indexOf(current) === 0;
  $('btn-next').disabled = last;
  $('btn-next').classList.toggle('ready', !!d[current] && !last);
  // The client light: does this demo app reach a node, and does it hold a token?
  const who = me();
  if (n.phase !== 'running') light('client-light', 'no', 'no node');
  else if (role() === 'join-here') light('client-light', who && S.loggedIn.includes(who) ? 'ok' : 'no', who && S.loggedIn.includes(who) ? 'connected as ' + who : 'not logged in');
  else if (S.app.did) light('client-light', 'ok', 'connected');
  else if (S.app.requestId) light('client-light', 'wait', 'waiting for the code');
  else light('client-light', 'no', 'not connected');
  renderRole(); renderExecutor(); renderHere(); renderNode(); renderAgent(); renderHandshake(); renderSpace(); renderArrive();
  renderPanel();
}

// ── 1. Who you are; the executor; joining on this computer ──────────────────────
function renderRole() {
  const r = role();
  $('fork').classList.toggle('hidden', !!r);
  $('s1-intro').classList.toggle('hidden', !!r);
  if (r) $('fork-join-how').classList.add('hidden');
  $('role-line').classList.toggle('hidden', !r);
  if (r) {
    const text = { host:'You are <b>starting the demo</b>: you run the node, make the space and receive the trust task. Steps 1 to 8.',
      'join-here':'You are <b>joining on this computer</b>: you become a second person on the node that already runs here. Then you vote (step 7) and check the receipt (step 8).',
      'join-own':'You are <b>joining with your own node</b>: steps 1 to 4 as usual, then you join the space by the address the other person sends you (step 5), vote (7) and check the receipt (8). Step 6 happens on their node.' }[r];
    if ($('role-line').dataset.r !== r) { $('role-line').innerHTML = text + ' <a href="#" id="role-change">Change</a>'; $('role-line').dataset.r = r; $('role-change').onclick = e => { e.preventDefault(); setRole(null); }; }
  }
  $('exe-part').classList.toggle('hidden', !r || r === 'join-here');
  $('here-part').classList.toggle('hidden', r !== 'join-here');
  $('s1').querySelector('h2').lastChild.textContent = r === 'join-here' ? ' Join on this computer' : r ? ' Get the executor' : ' Who are you in this demo?';
}
async function loadRelease() {
  const res = await api('GET', '/api/release');
  if (!res.ok) { $('release').innerHTML = 'Could not ask GitHub: ' + esc(res.error) + '. Download by hand from <a href="https://github.com/coasys/ad4m/releases" target="_blank" rel="noopener">github.com/coasys/ad4m/releases</a>.'; return; }
  const { release, tried, os, supported } = res.result;
  let html = 'This computer: <code>' + esc(os) + '</code>. ';
  if (!supported) html += 'There is no executor build for it in the release (Linux x64 and macOS on Apple silicon only). Build it from source (README) and give its path below.';
  else if (!release) html += 'The executor release is not public yet (' + esc(tried.join('; ')) + '). Build it from source (README) or use a file a Coasys person gave you, and give its path below.';
  else {
    html += 'Release <a href="' + esc(release.page) + '" target="_blank" rel="noopener">' + esc(release.tag) + '</a>' + (release.prerelease ? ' (a prerelease)' : '') + '. ';
    if (release.asset) {
      memo.released = true;
      html += 'Your file: <a href="' + esc(release.asset.url) + '">' + esc(release.asset.name) + '</a> (' + Math.round(release.asset.size / 1e6) + ' MB). '
        + 'Download it in your browser and give its path below, or let this page download it.';
    } else html += 'It has no file for this computer.';
    if (tried.length) html += '<br><span class="small">Not found first: ' + esc(tried.join('; ')) + '</span>';
  }
  if (supported && /darwin/.test(os)) html += '<br><span class="small">macOS: a file you download in the browser is quarantined. Clear it with <code>xattr -d com.apple.quarantine &lt;file&gt;</code> and <code>chmod +x &lt;file&gt;</code>. The page\'s own download needs neither.</span>';
  $('release').innerHTML = html;
  $('release').classList.remove('muted');
  $('btn-download').disabled = !release?.asset;
}
function renderExecutor() {
  const e = S.executor, d = S.download;
  if (document.activeElement !== $('exe-path') && !$('exe-path').value && e.path) $('exe-path').value = e.path;
  say('exe-status', e.ok ? '✓ <code>' + esc(e.path) + '</code> · ' + esc(e.version) : esc(e.error), e.ok ? 'ok' : 'wait');
  $('download-progress').textContent = d.active ? 'downloading ' + (d.total ? Math.round(100 * d.received / d.total) + ' %' : Math.round(d.received / 1e6) + ' MB')
    : d.error ? 'download failed: ' + d.error : d.done ? 'downloaded ✓' : '';
}
$('btn-download').onclick = e => act(e.target, 's1', 'I am downloading the executor into this folder', 'POST', '/api/executor/download', {});
$('btn-use').onclick = e => act(e.target, 's1', 'I am checking the executor file', 'POST', '/api/executor/use', { path:$('exe-path').value.trim() });

function renderHere() {
  if (role() !== 'join-here') return;
  const n = S.node, who = me(), sp = S.space;
  const loggedIn = who && S.loggedIn.includes(who);
  say('here-node', n.phase === 'running'
    ? '✓ A node runs on this computer (<code>' + esc(n.url) + '</code>). Multi-user mode, as the node reports it: <b>' + (S.multiUser ? 'on' : 'off') + '</b>.'
      + (S.multiUser ? '' : ' Adding you turns it on.')
    : 'No node runs on this computer yet. The person starting the demo starts it first (their step 2), then you add yourself here.', n.phase === 'running' ? 'ok' : 'wait');
  $('btn-here').disabled = n.phase !== 'running' || !S.agent?.unlocked;
  if (document.activeElement !== $('here-name') && who) $('here-name').value = who;
  say('here-status', loggedIn ? '✓ You are <b>' + esc(who) + '</b> on this node, with your own DID <code>' + esc(short(S.people[who]?.did)) + '</code>. The page holds your token and never shows it.' : '', 'ok');
  let html = '';
  if (!loggedIn) html = '';
  else if (!sp) html = '<span class="wait">No space yet. The person starting the demo makes it in their step 5: a local space with you as the owner, or a shared space you then join here.</span>';
  else if (sp.uuids[who]) html = '<span class="ok">✓ You are in the space. Go to step 7 to vote.</span>';
  else if (sp.neighbourhood) html = 'The space is shared. Join it as yourself: <button id="btn-here-join">Join the space as ' + esc(who) + '</button>';
  else html = '<span class="wait">The space here is local and you are not in it: it holds only the people it was made for. The person starting the demo can share it (their step 5, "Share this space"); then join it here.</span>';
  if ($('here-space').dataset.html !== html) {
    $('here-space').innerHTML = html; $('here-space').dataset.html = html;
    const join = $('btn-here-join');
    if (join) join.onclick = () => act(join, 's1', 'I am joining the shared space as ' + who, 'POST', '/api/space/join', { url:sp.neighbourhood, as:who }).then(afterSpace);
  }
}
$('btn-here').onclick = async e => {
  const name = $('here-name').value.trim().toLowerCase();
  const res = await act(e.target, 's1', 'I am adding ' + name + ' to this node and logging them in', 'POST', '/api/join-here', { name });
  if (res.ok) localStorage.setItem('iiw-me', name);
  refresh();
};

// ── 2. Node ─────────────────────────────────────────────────────────────────────
function renderNode() {
  const n = S.node;
  if (document.activeElement !== $('port')) $('port').value = S.settings.port;
  const running = n.phase !== 'stopped';
  $('btn-start').disabled = running; $('btn-stop').disabled = !n.pid; $('port').disabled = running;
  let html = n.phase === 'running' ? '<span class="ok">● running</span> at <code>' + esc(n.url) + '</code> (process ' + n.pid + ')'
    : n.phase === 'stopped' ? '<span class="muted">● stopped</span>' : '<span class="wait">● ' + esc(n.phase) + '…</span>';
  if (n.error) html += '<br><span class="no">' + esc(n.error) + '</span>';
  if (n.command) html += '<br><span class="small muted">Started with: <code>' + esc(n.command) + '</code></span>';
  $('node-status').innerHTML = html;
}
async function pollLog() {
  const res = await api('GET', '/api/node/log?lines=60');
  if (!res.ok) return;
  const pre = $('log'), atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
  pre.innerHTML = res.result.lines.map(l => /rand=\d{6}/.test(l) ? '<span class="code-line">' + esc(l) + '</span>' : esc(l)).join('\n') || '<span class="muted">(empty: the node has not started yet)</span>';
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}
$('btn-start').onclick = e => act(e.target, 's2', 'I am starting your node with its own data folder', 'POST', '/api/node/start', { port:Number($('port').value) });
$('btn-stop').onclick = e => act(e.target, 's2', 'I am stopping your node', 'POST', '/api/node/stop', {});
$('btn-reset').onclick = e => {
  if (!confirm('Start over? This stops the node and deletes .node/ (the node\'s data and its agent), .demo/ and .demo-test/ (people, the space, keys) and out/.')) return;
  memo.runs = []; memo.verified = {}; memo.installed = null; memo.members = null; memo.seen = null;
  localStorage.removeItem('iiw-me');
  act(e.target, 's2', 'I am stopping the node and deleting its data', 'POST', '/api/node/reset', {});
};

// ── 3. Agent and people ─────────────────────────────────────────────────────────
let agentFormFor = null;
function renderAgent() {
  const a = S.agent, box = $('agent-box');
  const kind = !a || a.error ? 'none' : !a.initialized ? 'create' : !a.unlocked ? 'unlock' : 'ready';
  const agentName = Object.entries(S.people).find(([, p]) => p.login === 'agent')?.[0];
  if (kind !== agentFormFor || kind === 'ready') {
    agentFormFor = kind;
    const suggested = role() === 'join-own' ? 'bob' : 'alice';
    if (kind === 'none') box.innerHTML = '';
    else if (kind === 'create') box.innerHTML = '<p><b>This node has no agent yet.</b> Pick a name for it (only this page uses the name) and a passphrase. The passphrase encrypts the agent\'s keys on disk; it is not stored unless you tick the box.</p>'
      + '<div class="row"><label>Name <input id="ag-name" value="' + suggested + '" size="10"></label>'
      + '<label>Passphrase <input id="ag-pass" type="password" autocomplete="new-password"></label>'
      + '<label>Again <input id="ag-pass2" type="password" autocomplete="new-password"></label></div>'
      + '<div class="row"><label class="small"><input type="checkbox" id="ag-remember"> Remember it in <code>.demo/agent-passphrase</code> (readable only by you), so a restarted node unlocks by itself</label></div>'
      + '<div class="row"><button id="btn-agent">Create the agent</button></div>';
    else if (kind === 'unlock') box.innerHTML = '<p><b>The agent is locked</b> (the node was restarted). Type its passphrase to unlock it.</p>'
      + '<div class="row"><label>Name <input id="ag-name" value="' + esc(agentName ?? suggested) + '" size="10"></label><label>Passphrase <input id="ag-pass" type="password" autocomplete="current-password"></label>'
      + '<label class="small"><input type="checkbox" id="ag-remember"> Remember it</label><button id="btn-agent">Unlock</button></div>';
    else {
      const html = '<p class="ok-text">✓ The node\'s agent' + (agentName ? ' <b>' + esc(agentName) + '</b>' : '') + ' is unlocked: <code>' + esc(a.did) + '</code></p>';
      if (box.innerHTML !== html) box.innerHTML = html;
    }
    const btn = $('btn-agent');
    if (btn && !btn.onclick) btn.onclick = async () => {
      const pass = $('ag-pass').value;
      if (kind === 'create' && pass !== $('ag-pass2').value) return showTrace('s3', 'Create the agent', { ok:false, error:'The two passphrases differ' });
      const res = await act(btn, 's3', kind === 'create' ? 'I am creating the node\'s agent' : 'I am unlocking the node\'s agent', 'POST', '/api/agent',
        { name:$('ag-name').value.trim(), passphrase:pass, remember:$('ag-remember').checked });
      if ($('ag-pass')) $('ag-pass').value = ''; if ($('ag-pass2')) $('ag-pass2').value = '';
      if (res.ok) agentFormFor = null;
    };
  }
  $('users-box').classList.toggle('hidden', role() === 'join-own');
  const users = Object.entries(S.people).filter(([, p]) => p.login === 'user');
  $('users-hint').textContent = 'Two people on one node is the simplest way to get two voters. The second person can also add themselves: on this computer they choose "I\'m joining someone", then "On this computer".';
  const html = users.length ? '<ul class="plist">' + users.map(([name, p]) => '<li><span class="nm">' + esc(name) + '</span> <code>' + esc(short(p.did)) + '</code> '
    + '<span class="tag">' + (S.loggedIn.includes(name) ? '<span class="ok-text">logged in ✓</span>' : '<button class="secondary small" data-login="' + esc(name) + '">Log in</button>') + '</span></li>').join('') + '</ul>'
    : '<p class="muted small">Nobody yet besides the node\'s agent.</p>';
  if ($('users-list').dataset.html !== html) {
    $('users-list').innerHTML = html; $('users-list').dataset.html = html;
    document.querySelectorAll('[data-login]').forEach(b => { b.onclick = () => act(b, 's3', 'I am logging ' + b.dataset.login + ' in', 'POST', '/api/users/login', { name:b.dataset.login }); });
  }
}
$('btn-user-add').onclick = e => { const name = $('user-name').value.trim() || 'dana'; act(e.target, 's3', 'I am adding ' + name + ' to this node', 'POST', '/api/users/add', { name }); };

// ── 4. Handshake ────────────────────────────────────────────────────────────────
let logLineTimer = null;
function renderHandshake() {
  const phase = S.app.did ? 'ok' : S.app.requestId ? 'enter' : 'ask';
  const order = ['ask', 'code', 'enter', 'ok'];
  const codeSeen = !$('hs-logline').classList.contains('hidden');
  const now = phase === 'enter' && !codeSeen ? 'code' : phase;
  document.querySelectorAll('#hs-steps li').forEach(li => {
    const i = order.indexOf(li.dataset.k), j = order.indexOf(now);
    li.classList.toggle('done', i < j || phase === 'ok'); li.classList.toggle('on', i === j && phase !== 'ok');
  });
  $('hs-enter').classList.toggle('hidden', phase !== 'enter' || !codeSeen);
  if (phase === 'ok') { $('hs-logline').classList.add('hidden');
    say('hs-status', '✓ Connected. This page acts as your agent <code>' + esc(S.app.did) + '</code> with its own token (see "Apps with access" on the right). One exception: a space owned by a person added in step 3 is that person\'s, and the node\'s agent reaches it only through the admin credential, as on the command line.', 'ok'); }
  else if (S.app.refused) say('hs-status', esc(S.app.refused) + '. Ask for access again.', 'no');
  else if (phase === 'ask') say('hs-status', 'Not connected yet.', 'muted');
  if (phase === 'enter' && !logLineTimer) watchLogLine();
}
function watchLogLine() {
  let tries = 0;
  logLineTimer = setInterval(async () => {
    const res = await api('GET', '/api/handshake/logline');
    if (res.ok && res.result.line) {
      clearInterval(logLineTimer); logLineTimer = null;
      const line = esc(res.result.line).replace(/rand=(\d{6})/, 'rand=<span class="hl">$1</span>');
      $('hs-logline').innerHTML = '<p class="small">The node wrote this line to its log (also at the bottom of the node panel). The number after <code>rand=</code> is your code:</p><pre>' + line + '</pre>';
      $('hs-logline').classList.remove('hidden');
      $('nodelog').open = true;
      say('hs-status', 'Type the 6 digits below. The code works once; five wrong tries cancel the request.', 'wait');
      render();
    } else if (++tries > 20) {
      clearInterval(logLineTimer); logLineTimer = null;
      say('hs-status', 'No code in the log. A node started outside this page prints it only with AD4M_LOG_SECRETS=1 (and without --config). Stop it and start it from step 2.', 'no');
    }
  }, 1000);
}
$('btn-hs-request').onclick = async e => {
  $('hs-logline').classList.add('hidden');
  const res = await act(e.target, 's4', 'I am asking your node for access', 'POST', '/api/handshake/request', {});
  if (res.ok) say('hs-status', 'Asked. Request id <code>' + esc(res.result.requestId) + '</code>. Waiting for the node to write the code…', 'wait');
};
$('btn-hs-redeem').onclick = async e => {
  const res = await act(e.target, 's4', 'I am sending the code you typed', 'POST', '/api/handshake/redeem', { code:$('hs-code').value.trim() });
  $('hs-code').value = '';
  if (res.ok) loadTemplates();
};

// ── 5. Space ────────────────────────────────────────────────────────────────────
let templatesLoaded = false;
async function loadTemplates() {
  const res = await api('GET', '/api/templates');
  if (!res.ok) return;
  templatesLoaded = true;
  const list = res.result;
  $('templates').classList.remove('muted');
  $('templates').innerHTML = list.map(t => '<label class="tpl"><input type="radio" name="tpl" value="' + esc(t.demo ?? '') + '"' + (t.demo ? '' : ' disabled')
    + (t.demo === 'server' ? ' checked' : '') + '> <b>' + esc(t.name) + '</b>'
    + (t.demo === 'server' ? ' <span class="rec">recommended</span>: one link server relays the links; joining took about 6 s in our tests'
      : t.demo === 'holochain' ? ': peer to peer over Holochain; joining took 16 to 60 s in our tests' : ' (this demo does not use it)')
    + '</label>').join('') || 'This node knows no link language yet. Sharing needs the network.';
}
function renderSpace() {
  const people = Object.entries(S.people), sp = S.space, r = role();
  const users = people.filter(([, p]) => p.login === 'user').map(([n]) => n), agent = people.filter(([, p]) => p.login === 'agent').map(([n]) => n);
  const fill = (sel, names) => { const html = names.map(n => '<option>' + esc(n) + '</option>').join(''); if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; } };
  document.querySelectorAll('.owner-select').forEach(sel => fill(sel, [...users, ...agent]));
  fill($('join-as'), [...agent, ...users]);
  $('s5-title').textContent = r === 'join-own' ? 'Join the shared space' : 'Make a space';
  document.querySelectorAll('#space-choices [data-for]').forEach(c => c.classList.toggle('hidden', c.dataset.for === 'join' ? r !== 'join-own' : r === 'join-own'));
  $('space-choices').classList.toggle('hidden', !!sp);
  if (!sp) { if ($('space-current').innerHTML) $('space-current').innerHTML = ''; return; }
  const names = Object.keys(sp.uuids);
  let html = '<span class="ok">✓ ' + (sp.neighbourhood ? 'Shared space' : 'Local space') + '</span>, AD4M perspective <code>' + esc(Object.values(sp.uuids)[0]) + '</code>. '
    + 'In it on this node: ' + names.map(n => '<b>' + esc(n) + '</b>').join(', ') + '.';
  if (sp.owner) html += ' Owner: <b>' + esc(sp.owner) + '</b>. Trust tasks go to the space\'s DID <code>' + esc(short(sp.spaceDid)) + '</code>.';
  else html += ' Joined here: the node that made it receives the trust tasks.';
  if (sp.neighbourhood && sp.owner) html += '<div class="sendbox"><b>Send this address to the second person.</b> They open this demo on their computer, choose "I\'m joining someone", then "With my own node", and paste it in their step 5.'
    + '<code id="nh-url">' + esc(sp.neighbourhood) + '</code><button class="secondary small" id="btn-copy">Copy</button>'
    + ' <span class="small muted">Someone on this computer chooses "On this computer" instead and joins it there.</span></div>';
  if (sp.owner && !sp.neighbourhood) html += '<p class="small muted">A second node, or a person added after this space was made, cannot get into a local space. Share it to let them in:</p>'
    + '<button class="secondary small" id="btn-share-now">Share this space through the link server</button>';
  if (!sp.neighbourhood && names.length < 2) html += '<br><span class="small wait">Only one person is in this space, so only "reject" can end a run (accept needs 2 voters).</span>';
  if ($('space-current').dataset.html !== html) {
    $('space-current').innerHTML = html; $('space-current').dataset.html = html;
    const copy = $('btn-copy'); if (copy) copy.onclick = () => navigator.clipboard?.writeText(sp.neighbourhood);
    const share = $('btn-share-now');
    if (share) share.onclick = () => act(share, 's5', 'I am sharing your space through Coasys\'s link server', 'POST', '/api/space/share', { link:'server', serverUrl:$('server-url').value.trim() }).then(afterSpace);
  }
}
$('btn-space-local').onclick = e => act(e.target, 's5', 'I am making a local space', 'POST', '/api/space/local', { as:$('local-owner').value }).then(afterSpace);
$('btn-space-share').onclick = e => act(e.target, 's5', 'I am making a space and sharing it', 'POST', '/api/space/share',
  { as:$('share-owner').value, link:document.querySelector('input[name=tpl]:checked')?.value || 'server', serverUrl:$('server-url').value.trim() }).then(afterSpace);
$('btn-space-join').onclick = e => act(e.target, 's5', 'I am joining the shared space', 'POST', '/api/space/join', { url:$('join-url').value.trim(), as:$('join-as').value }).then(afterSpace);
function afterSpace(res) { if (res.ok) { checkFlow(); loadRuns(); } }

// ── 6. Trust task and flow ──────────────────────────────────────────────────────
function diagram(state, end) {
  const node = $('diagram-tpl').content.firstElementChild.cloneNode(true);
  for (const g of node.querySelectorAll('g[data-state]')) g.classList.toggle('current', g.dataset.state === state || g.dataset.state === end);
  return node;
}
async function loadDefinition() {
  const res = await api('GET', '/api/flow/definition');
  if (!res.ok) return;
  const { header, rows } = res.result;
  $('mapping').innerHTML = '<thead><tr><th>' + esc(header.task) + '</th><th>' + esc(header.ad4m) + '</th></tr></thead><tbody>'
    + rows.map(r => '<tr class="' + (r.section ? 'section' : 'field') + '"><td>' + esc(r.task) + '</td><td>'
      + (r.arrow ? '<span class="arrow">' + esc(r.arrow) + '</span>' : '') + esc(r.ad4m)
      + (r.note ? '<span class="note">' + esc(r.note) + '</span>' : '') + '</td></tr>').join('') + '</tbody>';
  document.querySelectorAll('[data-diagram]').forEach(el => { el.innerHTML = ''; el.append(diagram(null)); });
  const latest = await api('GET', '/api/request/latest');
  showTask(latest.ok && latest.result.doc, false);
}
function showTask(doc, fresh) {
  if (!doc) { $('task-json').textContent = '(No trust task yet.)'; return; }
  let text = esc(JSON.stringify(doc, null, 2));
  for (const key of ['issuer', 'recipient', 'subject', 'role']) text = text.replace(new RegExp('(&quot;' + key + '&quot;: )(&quot;[^&]*&quot;)'), '$1<span class="hl">$2</span>');
  $('task-json').innerHTML = (fresh ? '' : '<span class="muted">// the last one signed in this folder\n</span>') + text;
}
async function checkFlow(button) {
  if (!S?.space) return;
  const res = button ? await act(button, 's6', 'I am looking for the flow in your space', 'GET', '/api/flow/installed') : await api('GET', '/api/flow/installed');
  if (!res.ok) { say('flow-status', esc(res.error), 'no'); return; }
  memo.installed = res.result.installed;
  say('flow-status', res.result.installed ? '✓ The flow <code>iiw://TrustTaskDecisionFlow</code> and its classes are in the space.'
    : (S.space.owner ? 'Not installed yet. Install it with the button.' : 'Not here yet. The space\'s maker installs it; it then syncs to this node. Check again in a few seconds.'), res.result.installed ? 'ok' : 'wait');
  $('btn-flow-install').disabled = res.result.installed || !S.space.owner;
  render();
}
function renderArrive() {
  const joined = S.space && !S.space.owner;
  $('arrive-take').classList.toggle('hidden', !!joined); $('arrive-joined').classList.toggle('hidden', !joined);
  document.querySelector('#s6 .reqcard').classList.toggle('hidden', !!joined);
  ['btn-req-new', 'btn-req-receive', 'btn-req-tamper'].forEach(id => { $(id).disabled = memo.installed !== true; });
  if (memo.installed !== true) say('receive-status', 'Install the flow first.', 'muted');
  else if ($('receive-status').textContent === 'Install the flow first.') say('receive-status', '');
}
const CHECK_FOR_CODE = { proofInvalid:'proof', wrongRecipient:'recipient', malformedRequest:'schema', unsupportedType:'schema', expired:'fresh', duplicate:'not a duplicate', idConflict:'not a duplicate' };
function badges(kind, code) {
  document.querySelectorAll('#check-badges span').forEach(b => {
    b.className = kind === 'accepted' ? 'ok' : kind === 'rejected' && CHECK_FOR_CODE[code] === b.textContent ? 'no' : '';
  });
}
$('btn-flow-check').onclick = e => checkFlow(e.target);
$('btn-flow-install').onclick = async e => { const res = await act(e.target, 's6', 'I am installing the flow and its classes in your space', 'POST', '/api/flow/install', {}); if (res.ok) checkFlow(); };
let pending = 'out/request.json';
$('btn-req-new').onclick = async e => {
  const res = await act(e.target, 's6', 'Requester: I sign a request, "give Carol the role member", and send it to this demo app', 'POST', '/api/request/new', {});
  if (res.ok) { pending = res.result.file; showTask(res.result.doc, true); badges(null); say('receive-status', 'The requester signed it and saved it as <code>' + esc(res.result.file) + '</code>. Nothing has reached the node yet. Now let this demo app check it.', 'wait'); }
};
$('btn-req-tamper').onclick = async e => {
  const res = await act(e.target, 's6', 'Requester: I sign a request, then change it', 'POST', '/api/request/new', { tamper:true });
  if (res.ok) { pending = res.result.file; showTask(res.result.doc, true); badges(null); say('receive-status', 'Changed after signing: ' + esc(res.result.changed) + '. Now let this demo app check it.', 'wait'); }
};
$('btn-req-receive').onclick = async e => {
  const res = await act(e.target, 's6', 'I check the task with ToIP\'s code, then store it in your space and start a run of the flow', 'POST', '/api/request/receive', { file:pending });
  if (!res.ok) return say('receive-status', esc(res.error), 'no');
  const r = res.result;
  badges(r.kind, r.code);
  if (r.kind === 'accepted') say('receive-status', 'All five checks passed in this demo app. Stored byte for byte ✓, and AD4M started a run of the flow in state <b>' + esc(r.state) + '</b>. Go to step 7 to vote.', 'ok');
  else if (r.kind === 'rejected') say('receive-status', 'Refused before any flow: <b>' + esc(r.code) + '</b>. Nothing reached the node. This demo app signed an error for the requester: <code>' + esc(r.path) + '</code>.', 'no');
  else say('receive-status', esc(r.kind) + (r.path ? ' → <code>' + esc(r.path) + '</code>' : ''), 'wait');
  pending = 'out/request.json';
  loadRuns();
};

// ── 7. Runs and votes ───────────────────────────────────────────────────────────
async function loadRuns(button) {
  if (!S?.space || S.node.phase !== 'running') return;
  const res = button ? await act(button, 's7', 'I am listing the flow runs in your space', 'GET', '/api/runs') : await api('GET', '/api/runs');
  if (!res.ok) { $('runs-note').textContent = res.error; return; }
  noticeRemote(res.result);
  memo.runs = res.result.runs;
  memo.members = res.result.members ?? null;
  if (res.result.installed !== undefined && memo.installed !== res.result.installed) { memo.installed = res.result.installed; checkFlow(); }
  $('runs-note').textContent = memo.runs.length ? memo.runs.length + ' run(s); refreshes every 4 s' : '';
  renderRuns(res.result.voters ?? []);
  renderAnswerTasks();
  render();
}
// Things this node got from other nodes: nobody clicked here. Drawn as dashed rows on the wire.
function noticeRemote(result) {
  const shared = !!S.space?.neighbourhood;
  const now = { members:new Set((result.members ?? []).filter(m => !m.here).map(m => m.did)), votes:new Set(), states:{}, runs:new Set() };
  for (const run of result.runs) {
    now.runs.add(run.runUri); now.states[run.runUri] = run.state;
    for (const v of run.votes) if (!v.name) now.votes.add(run.runUri + v.voter + v.toState);
  }
  const before = memo.seen; memo.seen = now;
  if (!before || !shared) return;
  for (const did of now.members) if (!before.members.has(did)) remote('a member joined the space: ' + short(did), 'seen with neighbourhood.otherAgents()');
  for (const run of now.runs) if (!before.runs.has(run) && !S.space.owner) remote('a trust task and its flow run arrived', 'seen with FlowInstance.findAll()');
  for (const v of now.votes) if (!before.votes.has(v)) remote('a vote arrived: ' + v.split(/(Accepted|Rejected)$/)[1], 'seen with run.proposals()');
  for (const [run, state] of Object.entries(now.states))
    if (before.states[run] && before.states[run] !== state && Date.now() - memo.lastClick > 4000) remote('flow state ' + before.states[run] + ' → ' + state, 'seen with space.flowStates()');
}
const votedFor = (run, name) => run.votes.find(v => v.name === name);
function renderRuns(voters) {
  const box = $('runs');
  if (box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;   // do not redraw under the cursor
  if (!memo.runs.length) { box.innerHTML = '<p class="muted">No runs yet. A run starts when ' + (S.space?.owner ? 'this demo app takes in a trust task (step 6).' : 'the node that made the space takes in a trust task; it syncs here.') + '</p>'; return; }
  const open = new Set([...box.querySelectorAll('input[data-why]')].filter(i => i.value).map(i => i.dataset.why + '|' + i.value));
  const who = role() === 'join-here' ? me() : null;
  box.innerHTML = '';
  for (const run of memo.runs) {
    const el = document.createElement('div'); el.className = 'run';
    const end = run.responded ? (run.state === 'Accepted' ? 'response' : 'error') : null;
    el.innerHTML = '<div class="head"><div><b>Task ' + esc(shortId(run.taskId)) + '</b>: give <code>' + esc(short(run.subject)) + '</code> (Carol) the role <b>' + esc(run.role) + '</b></div>'
      + '<div>State: <b class="' + (run.state === 'Accepted' ? 'ok-text' : run.state === 'Rejected' ? 'no-text' : '') + '">' + esc(run.state) + '</b>'
      + (run.responded ? ' · answered (' + esc(run.responseKind) + ')' : '') + '</div></div>'
      + '<div class="diagram"></div>'
      + '<div class="votes small">' + (run.votes.length ? 'Votes so far: ' + run.votes.map(v => '<b>' + esc(v.name ?? short(v.voter) + ' (another node)') + '</b> → ' + esc(v.toState)).join(', ') : 'No votes yet.') + '</div>'
      + (run.state === 'Received' ? voters.map(name => {
        const mine = votedFor(run, name);
        return '<div class="vote-row"><span class="name">' + esc(name) + (name === who ? ' (you)' : '') + '</span>' + (mine ? '<span class="muted small">voted ' + esc(mine.toState) + '</span>'
          : '<input data-why="' + esc(run.taskId + name) + '" placeholder="why (optional)" size="18">'
          + '<button data-vote="accept" data-as="' + esc(name) + '" data-task="' + esc(run.taskId) + '">Accept</button>'
          + '<button class="danger" data-vote="reject" data-as="' + esc(name) + '" data-task="' + esc(run.taskId) + '">Reject</button>') + '</div>';
      }).join('') : '<p class="small muted">This run has ended. Step 8 makes its receipt and answer.</p>');
    el.querySelector('.diagram').append(diagram(run.state, end));
    box.append(el);
  }
  for (const key of open) { const [k, v] = key.split('|'); const i = box.querySelector('input[data-why="' + CSS.escape(k) + '"]'); if (i) i.value = v; }
  box.querySelectorAll('[data-vote]').forEach(b => {
    b.onclick = async () => {
      const why = box.querySelector('input[data-why="' + CSS.escape(b.dataset.task + b.dataset.as) + '"]')?.value;
      await act(b, 's7', 'I am voting ' + b.dataset.vote + ' as ' + b.dataset.as, 'POST', '/api/vote', { action:b.dataset.vote, as:b.dataset.as, taskId:b.dataset.task, why });
      loadRuns();
    };
  });
}
$('btn-runs').onclick = e => loadRuns(e.target);

// ── 8. Receipt, answer, check ───────────────────────────────────────────────────
function renderAnswerTasks() {
  const sel = $('answer-task'), current = sel.value;
  const html = memo.runs.map(r => '<option value="' + esc(r.taskId) + '">' + esc(shortId(r.taskId)) + ' · ' + esc(r.state) + (r.responded ? ' · answered' : '') + '</option>').join('');
  if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; if (current) sel.value = current; }
  const joined = S?.space && !S.space.owner;
  $('btn-respond').classList.toggle('hidden', !!joined);
  document.querySelector('#s8 .reqcard').classList.toggle('hidden', !!joined);
}
const taskNow = () => $('answer-task').value;
function receiptOf(doc) { return doc?.payload?.ext?.['org.coasys.ad4m']?.flowReceipt ?? doc?.payload?.details?.['org.coasys.ad4m']?.flowReceipt; }
function nameOrDid(did) { const hit = Object.entries(S.people).find(([, p]) => p.did === did); return hit ? hit[0] + ' (' + short(did) + ')' : short(did); }
function spaceSide(response, verdict, receiptUri) {
  const fr = receiptOf(response);
  const key = response.threadId;
  if (verdict) memo.verdicts[key] = verdict; else verdict = memo.verdicts[key];
  $('space-side').innerHTML = '<p><span class="ok-text">✓ flow receipt</span> <code>' + esc(receiptUri ?? fr?.uri) + '</code></p>'
    + (verdict ? '<p>verifyFlowReceipt: <b>' + esc(verdict.outcome) + '</b>. Final state <b>' + esc(verdict.terminalState) + '</b>, voters: ' + (verdict.voters ?? []).map(d => esc(nameOrDid(d))).join(', ') + '</p>'
      : fr ? '<p>The receipt says: final state <b>' + esc(fr.terminalState) + '</b>, voters: ' + (fr.voters ?? []).map(d => esc(nameOrDid(d))).join(', ') + '</p>' : '')
    + '<p>Signed answer: <code>' + esc(response.type.replace('https://trusttasks.org/spec/', '')) + '</code>' + (response.payload?.code ? ', code <b>' + esc(response.payload.code) + '</b>' : '') + '</p>'
    + '<details><summary>The signed answer (JSON)</summary><pre class="json">' + esc(JSON.stringify(response, null, 2)) + '</pre></details>';
}
function linksBetween(request, response) {
  const fr = receiptOf(response);
  if (!request || !fr) { $('links-between').innerHTML = ''; return; }
  let raw = null;
  try { raw = JSON.parse(JSON.parse(fr.receipt.outputs.find(o => o.class_name === 'IiwTrustTaskRequest').content).raw); } catch {}
  const sha = fr.uri.split('/').pop();
  const rows = [
    ['request <code>id</code>', request.id, response.threadId, 'answer <code>threadId</code>'],
    ['request <code>issuer</code> (the requester)', request.issuer, response.recipient, 'answer <code>recipient</code>', short],
    ['request <code>recipient</code> (the space)', request.recipient, response.issuer, 'answer <code>issuer</code> (who signed it)', short],
    ['the request it sent, as JSON', JSON.stringify(request), raw && JSON.stringify(raw), 'the request inside the receipt (stored byte for byte)', () => request.id],
    ['the state the flow ended in, in the answer', fr.terminalState, fr.receipt.terminal_state, 'the receipt\'s <code>terminal_state</code>'],
    ['the receipt\'s address ends in', sha, fr.sha256, 'the SHA-256 of the receipt', v => String(v).slice(0, 16) + '…']
  ];
  $('links-between').innerHTML = '<details><summary>How the trust task and the flow connect, field by field</summary><div class="match">'
    + rows.map(([l, a, b, r, f = v => v]) => '<div>' + l + '<br><code>' + esc(f(a)) + '</code></div><div class="mid' + (a === b ? '' : ' no-text') + '">' + (a === b ? '=' : '≠') + '</div><div>' + r + '<br><code>' + esc(f(b)) + '</code></div>').join('') + '</div></details>';
}
$('btn-respond').onclick = async e => {
  const res = await act(e.target, 's8', 'I ask your node for the receipt, check it, then sign the answer with the trust-task key', 'POST', '/api/respond', { taskId:taskNow() });
  if (!res.ok) { $('space-side').innerHTML = '<p class="no-text">' + esc(res.error) + '</p>'; return; }
  spaceSide(res.result.response, res.result.verdict, res.result.receiptUri);
  if (res.result.existing) $('space-side').insertAdjacentHTML('afterbegin', '<p class="small muted">Already answered: this is the same signed answer as before.</p>');
  loadRuns();
};
$('btn-verify').onclick = async e => {
  const res = await act(e.target, 's8', 'Requester: I check the answer against the request I sent', 'POST', '/api/verify', { taskId:taskNow() });
  if (!res.ok) { $('req-side').innerHTML = '<p class="no-text">' + esc(res.error) + '</p>'; return; }
  const r = res.result;
  memo.verified[taskNow()] = r.ok;
  $('req-side').innerHTML = '<p>' + (r.ok ? '<span class="ok-text">✓ The answer checks out.</span>' : '<span class="no-text">✗ The answer failed a check.</span>') + '</p>'
    + '<ul class="checks">' + r.checks.map(c => '<li class="' + (c.ok ? '' : 'no') + '">' + esc(c.name) + '</li>').join('') + '</ul>'
    + '<p class="small muted">' + esc(r.limitation) + '.</p>'
    + '<details><summary>The request it sent (JSON)</summary><pre class="json">' + esc(JSON.stringify(r.request, null, 2)) + '</pre></details>';
  spaceSide(r.response, null);
  linksBetween(r.request, r.response);
  render();
};
$('btn-check-receipt').onclick = async e => {
  const who = role() === 'join-here' ? me() : undefined;
  const res = await act(e.target, 's8', 'I ask this node to check the receipt', 'POST', '/api/check-receipt', { taskId:taskNow(), as:who });
  if (!res.ok) { $('space-side').innerHTML = '<p class="no-text">' + esc(res.error) + '</p>'; return; }
  spaceSide(res.result.answer, res.result.verdict);
  if (!S.space.owner || role() === 'join-here') memo.verified[taskNow()] = res.result.verdict.outcome === 'verified';
  render();
};

// ── The node panel: what the executor holds ─────────────────────────────────────
const OPEN = { 1:['node'], 2:['node'], 3:['node', 'people'], 4:['apps'], 5:['space'], 6:['flow', 'space'], 7:['flow', 'space'], 8:['flow'] };
const userOpen = {};
function card(key, colour, sum, body, source) {
  const el = $('card-' + key);
  const lit = OPEN[current].includes(key) || (current === 1 && role() === 'join-here' && key === 'people');
  const open = userOpen[key] ?? lit;
  const cls = 'card ' + colour + (lit ? ' lit' : '') + (open ? '' : ' shut');
  if (el.className.replace(' pulse', '') !== cls) el.className = cls + (el.classList.contains('pulse') ? ' pulse' : '');
  const head = el.querySelector('.sum');
  if (head.dataset.html !== sum) { head.innerHTML = sum; head.dataset.html = sum; }
  const html = open ? body + (source ? '<p class="src">' + esc(source) + '</p>' : '') : '';
  const b = el.querySelector('.body');
  if (b.dataset.html !== html) { b.innerHTML = html; b.dataset.html = html; }
  // The node changed: light the card up for a moment.
  if (b.dataset.sig !== undefined && b.dataset.sig !== sum + body) {
    el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse');
    setTimeout(() => el.classList.remove('pulse'), 1300);
  }
  b.dataset.sig = sum + body;
  if (!el.dataset.wired) { el.dataset.wired = '1'; el.querySelector('.card-head b').style.cursor = 'pointer'; el.querySelector('.card-head b').onclick = () => { userOpen[key] = !(userOpen[key] ?? OPEN[current].includes(key)); renderPanel(); }; }
}
function renderPanel() {
  const n = S.node, a = S.agent, sp = S.space, running = n.phase === 'running';
  const lane = $('node-lane');
  lane.classList.toggle('running', running && !!a && !a.error); lane.classList.toggle('starting', n.phase === 'starting' || n.phase === 'creating');
  if (running) light('node-light', 'ok', 'running'); else if (n.phase === 'stopped') light('node-light', 'no', 'stopped'); else light('node-light', 'wait', n.phase + '…');
  $('node-sub').textContent = running ? 'What the executor holds right now. It answers at ' + n.url.replace('http://', '') + '.' : 'What the executor holds right now.';
  // Which setup this is: one node with two people, or a space shared with another node.
  const users = S.users ?? [];
  const mode = sp?.neighbourhood ? 'Shared with another node' : (sp && Object.keys(sp.uuids).length > 1) || users.length ? 'One node, two people' : null;
  $('mode-badge').classList.toggle('hidden', !mode || !running); $('mode-badge').textContent = mode ?? '';
  const agentName = Object.entries(S.people).find(([, p]) => p.login === 'agent')?.[0];
  // Node
  card('node', 'blue', running ? (a?.unlocked ? 'agent ' + esc(agentName ?? '') : a?.initialized ? 'agent locked' : 'no agent yet') : 'no node yet',
    running ? '<div class="kv"><span>version</span><span>' + esc(S.info?.version ?? '…') + '</span>'
      + '<span>agent</span><span>' + (a?.did ? '<code>' + esc(short(a.did)) + '</code>' : a?.initialized ? 'locked' : 'not created yet') + '</span>'
      + '<span>keys</span><span>' + (a?.unlocked ? 'unlocked, inside the node' : a?.initialized ? 'locked (step 3)' : '—') + '</span></div>'
    : '<p class="muted">' + (n.phase === 'stopped' ? 'The node is stopped. Start it in step 2.' : 'Starting…') + '</p>', 'runtime.info() · agent.status()');
  // People
  const mu = S.multiUser;
  const sw = running && a?.unlocked && role() !== 'join-here' ? '<span class="switch" title="runtime.setMultiUserEnabled"><button data-mu="0" class="' + (mu ? '' : 'on') + '">off</button><button data-mu="1" class="' + (mu ? 'on' : '') + '">on</button></span>' : '';
  const stranded = Object.entries(S.people).filter(([, p]) => p.login === 'user').map(([nm]) => nm);
  card('people', 'blue', running ? 'multi-user ' + (mu === null ? '?' : mu ? 'on' : 'off') + sw : '',
    running ? '<ul class="plist">' + (agentName ? '<li><span class="nm">' + esc(agentName) + '</span><code>' + esc(short(a?.did)) + '</code><span class="tag">the node\'s agent</span></li>' : '')
      + users.map(u => '<li><span class="nm">' + esc(u.name ?? '?') + '</span><code>' + esc(short(u.did)) + '</code><span class="tag">' + (S.loggedIn.includes(u.name) ? 'logged in' : 'person on this node') + '</span></li>').join('') + '</ul>'
      + (!mu && stranded.length ? '<p class="small wait">Multi-user is off: nobody can log in as ' + stranded.map(esc).join(', ') + ' now.</p>' : '')
    : '', 'runtime.multiUserEnabled() · runtime.listUsers()');
  document.querySelectorAll('[data-mu]').forEach(b => { b.onclick = e => { e.stopPropagation(); setMultiUser(b.dataset.mu === '1'); }; });
  // Apps
  const apps = (S.apps ?? []).filter(x => !x.revoked);
  card('apps', 'blue', running ? apps.length + ' app' + (apps.length === 1 ? '' : 's') : '',
    running ? (apps.length ? '<ul class="plist">' + apps.map(x => '<li><span class="nm">' + esc(x.name) + '</span><span class="tag">' + (x.everything ? 'may do everything' : 'limited') + '</span></li>').join('') + '</ul>'
      : '<p class="muted">No app holds a token yet. Step 4 asks for one.</p>') : '', 'agent.getApps()');
  // Space
  const members = memo.members ?? (sp ? Object.keys(sp.uuids).map(name => ({ name, did:S.people[name]?.did, here:true })) : []);
  card('space', 'mint', sp ? (sp.neighbourhood ? 'shared' + (sp.link ? ' · ' + (sp.link === 'server' ? 'link server' : 'Holochain') : '') : 'only on this node') : 'none yet',
    sp ? '<p><b>IIW trust tasks</b> · ' + members.length + ' member' + (members.length === 1 ? '' : 's') + '</p><ul class="plist">'
      + members.map(m => '<li><span class="nm">' + esc(m.name ?? 'agent') + '</span><code>' + esc(short(m.did)) + '</code><span class="tag' + (m.here ? '' : ' mint') + '">' + (m.here ? 'member' : 'member, another node') + '</span></li>').join('') + '</ul>'
      + (sp.neighbourhood ? '<p class="small muted">' + esc(sp.neighbourhood.slice(0, 34)) + '…</p>' : '')
    : '<p class="muted">No space yet (step 5).</p>', sp?.neighbourhood ? 'neighbourhood.otherAgents()' : 'perspective.byUUID()');
  // Flow
  const run = memo.runs[0];
  const accepts = run ? new Set(run.votes.filter(v => v.toState === 'Accepted').map(v => v.voter)).size : 0;
  card('flow', 'mint', !sp ? '' : memo.installed ? (run ? 'run: ' + esc(run.state) : 'no run yet') : 'not installed',
    !sp ? '<p class="muted">Needs a space.</p>'
    : '<p>Rules: ' + (memo.installed ? 'the stored request <code>IiwTrustTaskRequest</code> and the vote <code>TrustTaskDecision</code> <span class="ok-text">✓</span>' : '<span class="muted">not in the space yet (step 6)</span>') + '</p>'
      + (run ? '<p><b>Give Carol the role ' + esc(run.role) + '</b></p>'
        + '<div class="states"><span class="' + (run.state === 'Received' ? 'cur' : '') + '">Received</span><i>→</i><span class="' + (run.state === 'Accepted' ? 'cur' : '') + '">Accepted</span><span class="' + (run.state === 'Rejected' ? 'cur rej' : '') + '">Rejected</span></div>'
        + '<div class="votebar"><i style="width:' + Math.min(100, accepts * 50) + '%"></i></div><p class="small muted">' + accepts + ' of 2 votes to accept' + (run.votes.some(v => v.toState === 'Rejected') ? ' · a reject vote' : '') + '</p>'
        + (run.responded ? '<p class="ok-text">✓ receipt made, answer signed</p>' : '')
        + (run.state !== 'Received' ? '<p class="small muted">The decision is recorded in the space. No permission changes anywhere.</p>' : '') : ''),
    'getFlow() · flowStates() · run.proposals()');
}
async function setMultiUser(on) {
  const people = Object.entries(S.people).filter(([, p]) => p.login === 'user').map(([nm]) => nm);
  if (!on && people.length && !confirm(people.join(', ') + (people.length === 1 ? ' is a person' : ' are people') + ' on this node. With multi-user off, nobody can log in as ' + people.join(' or ') + ', so they cannot vote. Turn it off anyway?')) return;
  const res = await act(null, current === 3 ? 's3' : 's' + current, 'I am turning multi-user mode ' + (on ? 'on' : 'off') + ', then reading it back', 'POST', '/api/multiuser', { on });
  if (res.ok) { S.multiUser = res.result.multiUser; renderPanel(); }
}

// ── Start ───────────────────────────────────────────────────────────────────────
(async () => {
  await refresh();
  showStep(current);
  loadRelease(); loadDefinition(); pollLog();
  if (S?.app.did) loadTemplates();
  if (S?.space) { checkFlow(); loadRuns(); }
  setInterval(refresh, 2500);
  setInterval(pollLog, 2000);
  setInterval(() => { if (!document.hidden && S?.space && S.node.phase === 'running') loadRuns(); }, 4000);
  setInterval(() => { if (S?.app.did && !templatesLoaded) loadTemplates(); }, 5000);
})();
