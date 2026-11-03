// The page. Plain JavaScript: each button calls the local server (ui.mjs), which calls the
// same functions as demo.mjs and requester.mjs and sends back the result and the SDK calls made.
// Left: this demo app, one step at a time. Middle: the SDK calls of each button. Right: the node.
'use strict';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const short = did => did && did.length > 26 ? did.slice(0, 16) + '…' + did.slice(-4) : (did ?? '');
const shortId = id => String(id ?? '').replace(/^urn:uuid:/, '').slice(0, 8);
let S = null;                 // the last state from the server
const memo = { runs:[], voters:[], members:null, verified:{}, receipts:{}, open:{}, installed:null, released:false, lastClick:0, seen:null };

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
  if (/^Requester:/.test(title)) $('wire-list').firstElementChild.classList.add('req');
}
const remote = (what, text) => wireGroup('⇠ From another node: ' + what, text ? [{ kind:'remote', text }] : [], true);

// ── Who you are, and which steps that needs ─────────────────────────────────────
// Three parts: Setup (steps 1 to 4), Space (5) and Decide (6). Joining on this computer needs only
// step 1 of Setup: the node already runs here.
const PATHS = { host:[1, 2, 3, 4, 5, 6], 'join-here':[1, 5, 6], 'join-own':[1, 2, 3, 4, 5, 6] };
const GROUPS = [['setup', 'Setup', [1, 2, 3, 4]], ['space', 'Space', [5]], ['decide', 'Decide', [6]]];
const groupOf = k => k <= 4 ? 'setup' : k === 5 ? 'space' : 'decide';
// Kept in this browser, not on the server: two people on one computer each pick their own part.
const role = () => localStorage.getItem('iiw-role') || null;
const path = () => PATHS[role()] ?? PATHS.host;
const me = () => localStorage.getItem('iiw-me') || null;
let current = Number(localStorage.getItem('iiw-step')) || 1;
if (!PATHS.host.includes(current)) current = 1;
function showStep(n) {
  if (!path().includes(n)) n = path().filter(k => k <= n).pop() ?? 1;
  current = n; localStorage.setItem('iiw-step', String(n));
  layout();
  if (S) render();
  $('nodelog').open = n === 4 && !!S?.app.requestId && !S.app.did;
  window.scrollTo({ top:0, behavior:'smooth' });
}
// On Setup: its steps, the current one open, the others folded to their header. On Space or
// Decide: Setup is one bar, and the parts before the current one are folded.
function layout() {
  const p = path(), onSetup = current <= 4;
  document.querySelectorAll('.step').forEach(s => {
    const k = Number(s.dataset.n), shown = p.includes(k) && (k <= 4 ? onSetup : k <= current);
    s.classList.toggle('shown', shown); s.classList.toggle('active', k === current); s.classList.toggle('folded', shown && k !== current);
  });
  $('bar-setup').classList.toggle('hidden', onSetup);
}
document.querySelectorAll('.step h2').forEach(h => {
  h.onclick = e => { const k = Number(h.closest('.step').dataset.n); if (!e.target.closest('a') && k !== current) showStep(k); };
});
const firstOpen = steps => { const d = S ? done() : {}; return steps.find(k => !d[k]) ?? steps[0]; };
$('bar-setup').onclick = () => showStep(firstOpen(path().filter(k => k <= 4)));
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
const agentName = () => Object.entries(S?.people ?? {}).find(([, p]) => p.login === 'agent')?.[0] ?? null;
const loggedInHere = () => { const who = me(); return !!who && S.loggedIn.includes(who); };
function done() {
  const n = S.node, a = S.agent, sp = S.space, who = me();
  const here = role() === 'join-here';
  return {
    1:here ? loggedInHere() : !!role() && S.executor.ok,
    2:n.phase === 'running', 3:!!a?.unlocked, 4:!!S.app.did, 5:here ? !!(who && sp?.uuids?.[who]) : !!sp,
    6:Object.values(memo.verified).some(Boolean)
  };
}
// One short line in a step's header once it is done, so a folded step still says what it holds.
function summaries() {
  const n = S.node, a = S.agent, sp = S.space, r = role();
  return {
    1:r === 'join-here' ? 'you are ' + (me() ?? '?') + ' on this node' : (r === 'host' ? 'starting the demo' : 'joining with your own node') + (S.executor.version ? ' · ' + S.executor.version : ''),
    2:n.url ? 'running at ' + n.url.replace('http://', '') : '',
    3:(agentName() ? agentName() + ' · ' : '') + short(a?.did),
    4:'connected',
    5:sp ? (sp.neighbourhood ? 'shared space' : 'local space') + ' with ' + Object.keys(sp.uuids).join(', ') : '',
    6:''
  };
}
function render() {
  const n = S.node, a = S.agent, sp = S.space, here = role() === 'join-here';
  const d = done();
  const spaceFirst = here ? 'Get into the space first (Space, at the top).' : 'Make or join a space first (Space, at the top).';
  const blockers = {
    2:!S.executor.ok && 'Choose the executor first (step 1).',
    3:n.phase !== 'running' && 'Start the node first (step 2).',
    4:!a?.unlocked && 'Create or unlock the agent first (step 3).',
    5:here ? !loggedInHere() && 'Add yourself to this node first (step 1).' : !S.app.did && 'Connect the page first (step 4).',
    6:!d[5] && spaceFirst
  };
  if (n.phase !== 'running') for (const k of [4, 5, 6]) blockers[k] = blockers[k] || (here ? 'No node runs on this computer.' : 'The node is not running (step 2).');
  if (!path().includes(current)) return showStep(current);
  layout();
  // Three pills: Setup, Space, Decide. A pill is done when all its steps on this path are.
  const p = path();
  const pills = GROUPS.map(([g, label, ks]) => { const steps = ks.filter(k => p.includes(k));
    return '<button class="pill' + (groupOf(current) === g ? ' on' : '') + (steps.every(k => d[k]) ? ' done' : '') + '" data-group="' + g + '">' + label + '</button>'; }).join('');
  if ($('pills').dataset.html !== pills) {
    $('pills').innerHTML = pills; $('pills').dataset.html = pills;
    $('pills').querySelectorAll('.pill').forEach(b => { b.onclick = () => showStep(firstOpen(GROUPS.find(([g]) => g === b.dataset.group)[2].filter(k => path().includes(k)))); });
  }
  const sums = summaries();
  for (const k of [1, 2, 3, 4, 5, 6]) {
    const el = $('s' + k);
    el.classList.toggle('done', !!d[k]);
    el.classList.toggle('blocked', !!blockers[k]);
    el.querySelector('h2 .sum').textContent = d[k] && sums[k] ? sums[k] : '';
    let b = el.querySelector('.blocker');
    if (blockers[k]) { if (!b) { b = document.createElement('p'); b.className = 'blocker'; el.querySelector('h2').after(b); } b.textContent = blockers[k]; }
    else b?.remove();
  }
  const setup = p.filter(k => k <= 4), setupDone = setup.every(k => d[k]);
  $('bar-setup').classList.toggle('todo', !setupDone);
  $('bar-setup').querySelector('.bar-mark').textContent = setupDone ? '✓' : '!';
  $('bar-setup-sum').textContent = setupDone ? setup.map(k => sums[k]).filter(Boolean).slice(here ? 0 : 1).join(' · ') : 'not finished yet';
  const last = p.indexOf(current) === p.length - 1;
  $('btn-back').disabled = p.indexOf(current) === 0;
  $('btn-next').disabled = last;
  $('btn-next').classList.toggle('ready', !!d[current] && !last);
  // The client light: does this demo app reach a node, and does it hold a token?
  const who = me();
  if (n.phase !== 'running') light('client-light', 'no', 'no node');
  else if (here) light('client-light', loggedInHere() ? 'ok' : 'no', loggedInHere() ? 'connected as ' + who : 'not logged in');
  else if (S.app.did) light('client-light', 'ok', 'connected');
  else if (S.app.requestId) light('client-light', 'wait', 'waiting for the code');
  else light('client-light', 'no', 'not connected');
  renderRole(); renderExecutor(); renderHere(); renderNode(); renderAgent(); renderHandshake(); renderSpace(); renderDecide();
  renderRuns();
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
    const text = { host:'You are <b>starting the demo</b>: you run the node, make the space and take in the requests.',
      'join-here':'You are <b>joining on this computer</b>: you become a second person on the node that runs here, then you vote.',
      'join-own':'You are <b>joining with your own node</b>: you start your own node, join the space by the address the other person sends you, then vote. New requests come from their window.' }[r];
    if ($('role-line').dataset.r !== r) { $('role-line').innerHTML = text + ' <a href="#" id="role-change">Change</a>'; $('role-line').dataset.r = r; $('role-change').onclick = e => { e.preventDefault(); setRole(null); }; }
  }
  $('exe-part').classList.toggle('hidden', !r || r === 'join-here');
  $('here-part').classList.toggle('hidden', r !== 'join-here');
  $('s1').querySelector('h2 .t').textContent = r === 'join-here' ? 'Join on this computer' : r ? 'Get the executor' : 'Who are you in this demo?';
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
  say('here-status', loggedIn ? '✓ You are <b>' + esc(who) + '</b> on this node, with your own DID <code>' + esc(short(S.people[who]?.did)) + '</code>. The page logged you in with a token and never shows it.' : '', 'ok');
  let html = '';
  if (!loggedIn) html = '';
  else if (!sp) html = '<span class="wait">No space yet. The person starting the demo makes it under Space: a local space with you as the owner, or a shared space you then join here.</span>';
  else if (sp.uuids[who]) html = '<span class="ok">✓ You are in the space. Go to Decide to vote.</span>';
  else if (sp.neighbourhood) html = 'The space is shared. Join it as yourself: <button id="btn-here-join">Join the space as ' + esc(who) + '</button>';
  else html = '<span class="wait">The space here is local and you are not in it: it holds only the people it was made for. The person starting the demo can share it (under Space, "Share this space"); then join it here.</span>';
  if ($('here-space').dataset.html !== html) {
    $('here-space').innerHTML = html; $('here-space').dataset.html = html;
    const join = $('btn-here-join');
    if (join) join.onclick = () => act(join, 's5', 'I am joining the shared space as ' + who, 'POST', '/api/space/join', { url:S.space?.neighbourhood, as:who }).then(afterSpace);
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
  memo.runs = []; memo.verified = {}; memo.receipts = {}; memo.open = {}; memo.installed = null; memo.members = null; memo.seen = null;
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
    + '<span class="tag">' + (S.loggedIn.includes(name) ? '<span class="ok-text">logged in ✓</span>' : S.multiUser === false ? '<span class="muted">turn multi-user on to log in</span>' : '<button class="secondary small" data-login="' + esc(name) + '">Log in</button>') + '</span></li>').join('') + '</ul>'
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
    say('hs-status', '✓ Connected. This page acts as your agent <code>' + esc(S.app.did) + '</code> with its own token (see "Apps with access" in the node panel). One exception: a space owned by a person added in step 3 is that person\'s, and the node\'s agent reaches it only through the admin credential, as on the command line.', 'ok'); }
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
      say('hs-status', 'Type the 6 digits into the field. The code works once; five wrong tries cancel the request.', 'wait');
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
  $('s5-title').textContent = r === 'join-own' ? 'Join the shared space' : r === 'join-here' ? 'Get into the space' : 'Make a space';
  $('s5-lede').textContent = r === 'join-own' ? 'Join the space the starter shared with you.' : r === 'join-here' ? 'Get into the space the starter made on this node.' : 'Make the space that holds the requests, the flow and the votes.';
  document.querySelectorAll('#space-choices [data-for]').forEach(c => c.classList.toggle('hidden', c.dataset.for === 'join' ? r !== 'join-own' : r === 'join-own'));
  $('space-choices').classList.toggle('hidden', !!sp || r === 'join-here');
  $('here-space').classList.toggle('hidden', r !== 'join-here');
  $('space-current').classList.toggle('hidden', r === 'join-here');
  if (!sp) { if ($('space-current').innerHTML) $('space-current').innerHTML = ''; return; }
  const names = Object.keys(sp.uuids);
  let html = '<span class="ok">✓ ' + (sp.neighbourhood ? 'Shared space' : 'Local space') + '</span>, AD4M perspective <code>' + esc(Object.values(sp.uuids)[0]) + '</code>. '
    + 'In it on this node: ' + names.map(n => '<b>' + esc(n) + '</b>').join(', ') + '.';
  if (sp.owner) html += ' Owner: <b>' + esc(sp.owner) + '</b>. Trust tasks name the space\'s trust-task DID <code>' + esc(short(sp.spaceDid)) + '</code> as recipient: a key this demo app holds, not the node.';
  else html += ' Joined here: the demo app of the person who made it takes in the trust tasks and stores them on their node.';
  if (sp.neighbourhood && sp.owner) html += '<div class="sendbox"><b>Send this address to the second person.</b> They open this demo on their computer, choose "I\'m joining someone", then "With my own node", and paste it under Space.'
    + '<code id="nh-url">' + esc(sp.neighbourhood) + '</code><button class="secondary small" id="btn-copy">Copy</button>'
    + ' <span class="small muted">Someone on this computer chooses "On this computer" instead and joins it there.</span></div>';
  if (sp.owner && !sp.neighbourhood) html += '<p class="small muted">A second node, or a person added after this space was made, cannot get into a local space. Share it to let them in:</p>'
    + '<button class="secondary small" id="btn-share-now">Share this space through the link server</button>';
  if (!sp.neighbourhood && names.length < 2) html += '<br><span class="small wait">Only one person is in this space, so only "reject" can end a run (accept needs 2 voters).</span>';
  if (sp.owner) html += '<p class="small">Next: <a href="#" id="go-decide">Decide</a>.</p>';
  if ($('space-current').dataset.html !== html) {
    $('space-current').innerHTML = html; $('space-current').dataset.html = html;
    const copy = $('btn-copy'); if (copy) copy.onclick = () => navigator.clipboard?.writeText(sp.neighbourhood);
    const go = $('go-decide'); if (go) go.onclick = e => { e.preventDefault(); showStep(6); };
    const share = $('btn-share-now');
    if (share) share.onclick = () => act(share, 's5', 'I am sharing your space through Coasys\'s link server', 'POST', '/api/space/share', { link:'server', serverUrl:$('server-url').value.trim() }).then(afterSpace);
  }
}
$('btn-space-local').onclick = e => act(e.target, 's5', 'I am making a local space', 'POST', '/api/space/local', { as:$('local-owner').value }).then(afterSpace);
$('btn-space-share').onclick = e => act(e.target, 's5', 'I am making a space and sharing it', 'POST', '/api/space/share',
  { as:$('share-owner').value, link:document.querySelector('input[name=tpl]:checked')?.value || 'server', serverUrl:$('server-url').value.trim() }).then(afterSpace);
$('btn-space-join').onclick = e => act(e.target, 's5', 'I am joining the shared space', 'POST', '/api/space/join', { url:$('join-url').value.trim(), as:$('join-as').value }).then(afterSpace);
function afterSpace(res) { if (res.ok) { checkFlow(); loadRuns(); } }

// ── Decide: new requests, each run as a card, votes, receipts ───────────────────
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
async function checkFlow() {
  if (!S?.space) return;
  const res = await api('GET', '/api/flow/installed');
  if (!res.ok) return;
  memo.installed = res.result.installed;
  render();
}
// Only the starter's demo app takes in requests: it holds the space's trust-task key.
const isStarter = () => role() === 'host' && !!S?.space?.owner;
// The person whose window makes new requests, if this page knows their name.
const starter = () => { if (role() !== 'join-here') return null; const a = agentName(); return a && a !== me() ? a : null; };
const starterWindow = () => starter() ? starter() + '\'s window' : 'the starter\'s window';
let newBusy = false;
function renderDecide() {
  const starterHere = isStarter();
  $('new-part').classList.toggle('hidden', !starterHere);
  $('new-elsewhere').classList.toggle('hidden', starterHere || !S.space);
  $('new-elsewhere').textContent = 'New requests come from ' + starterWindow() + '.';
  $('btn-new').disabled = $('btn-req-tamper').disabled = newBusy || !S.space || S.node.phase !== 'running';
  const waiting = !starterHere && S.space && memo.installed === false
    ? 'The flow has not reached this node yet. It comes with the space\'s links from ' + (starter() ?? 'the starter') + '\'s node; this page looks again every few seconds.' : '';
  if ($('flow-status').textContent !== waiting) say('flow-status', esc(waiting), 'wait');
}
const CHECK_FOR_CODE = { proofInvalid:'proof', wrongRecipient:'recipient', malformedRequest:'schema', unsupportedType:'schema', expired:'fresh', duplicate:'not a duplicate', idConflict:'not a duplicate' };
function badges(kind, code) {
  document.querySelectorAll('#check-badges span').forEach(b => {
    b.className = kind === 'accepted' ? 'ok' : kind === 'rejected' && CHECK_FOR_CODE[code] === b.textContent ? 'no' : '';
  });
}
// "+ New request": install the flow the first time, the requester signs, this demo app checks it
// and starts a run. Three calls, each on the wire as before.
async function newRequest(button, tamper) {
  newBusy = true; button.classList.add('busy'); render();
  try {
    if (memo.installed !== true) {
      const res = await act(null, 's6', 'I am installing the flow and its classes in your space', 'POST', '/api/flow/install', {});
      if (!res.ok) return say('receive-status', esc(res.error), 'no');
      memo.installed = true;
    }
    const made = await act(null, 's6', tamper ? 'Requester: I sign a request, then change it' : 'Requester: I sign a request, "give Carol the role member", and send it to this demo app', 'POST', '/api/request/new', tamper ? { tamper:true } : {});
    if (!made.ok) return say('receive-status', esc(made.error), 'no');
    showTask(made.result.doc, true); badges(null); $('inapp-checks').classList.remove('hidden');
    const res = await act(null, 's6', 'I check the task with ToIP\'s code, then store it in your space and start a run of the flow', 'POST', '/api/request/receive', { file:made.result.file });
    if (!res.ok) return say('receive-status', esc(res.error), 'no');
    const r = res.result;
    badges(r.kind, r.code);
    if (r.kind === 'accepted') { memo.open = {}; say('receive-status', 'All five checks passed. A new run of the flow started: vote on it below.', 'ok'); }
    else if (r.kind === 'rejected') say('receive-status', (made.result.changed ? 'Changed after signing: ' + esc(made.result.changed) + '. ' : '') + 'Refused before any flow: <b>' + esc(r.code) + '</b>. Nothing reached the node. This demo app signed an error for the requester: <code>' + esc(r.path) + '</code>.', 'no');
    else say('receive-status', esc(r.kind) + (r.path ? ' → <code>' + esc(r.path) + '</code>' : ''), 'wait');
    await loadRuns();
  } finally { newBusy = false; button.classList.remove('busy'); render(); }
}
$('btn-new').onclick = e => newRequest(e.currentTarget, false);
$('btn-req-tamper').onclick = e => newRequest(e.currentTarget, true);

async function loadRuns(button) {
  if (!S?.space || S.node.phase !== 'running') { memo.runs = []; memo.members = null; memo.installed = null; return; }
  const url = '/api/runs' + (button ? '?fresh=1' : '');
  const res = button ? await act(button, 's6', 'I am listing the flow runs in your space', 'GET', url) : await api('GET', url);
  if (!res.ok) { $('runs-note').textContent = res.error; return; }
  noticeRemote(res.result);
  memo.runs = res.result.runs;
  memo.voters = res.result.voters ?? [];
  memo.members = res.result.members ?? null;
  if (res.result.installed !== undefined && memo.installed !== res.result.installed) { memo.installed = res.result.installed; checkFlow(); }
  $('runs-note').textContent = memo.runs.length ? memo.runs.length + ' request' + (memo.runs.length === 1 ? '' : 's') + '. This list refreshes every 4 s.' : '';
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
  // A different space: start over, so its old members and votes do not show up as new.
  const key = S.space?.neighbourhood ?? Object.values(S.space?.uuids ?? {})[0];
  const before = memo.seenKey === key ? memo.seen : null; memo.seen = now; memo.seenKey = key;
  if (!before || !shared) return;
  for (const did of now.members) if (!before.members.has(did)) remote('a member joined the space: ' + short(did), 'seen with neighbourhood.otherAgents()');
  for (const run of now.runs) if (!before.runs.has(run) && !S.space.owner) remote('a trust task and its flow run arrived', 'seen with FlowInstance.findAll()');
  for (const v of now.votes) if (!before.votes.has(v)) remote('a vote arrived: ' + v.split(/(Accepted|Rejected)$/)[1], 'seen with run.proposals()');
  for (const [run, state] of Object.entries(now.states))
    if (before.states[run] && before.states[run] !== state && Date.now() - memo.lastClick > 4000) remote('flow state ' + before.states[run] + ' → ' + state, 'seen with space.flowStates()');
}
const votedFor = (run, name) => run.votes.find(v => v.name === name);
function receiptOf(doc) { return doc?.payload?.ext?.['org.coasys.ad4m']?.flowReceipt ?? doc?.payload?.details?.['org.coasys.ad4m']?.flowReceipt; }
function nameOrDid(did) { const hit = Object.entries(S.people).find(([, p]) => p.did === did); return hit ? hit[0] : short(did); }
const receiptAddress = uri => uri ? 'ad4m://flow/receipt/' + String(uri).split('/').pop().slice(0, 10) + '…' : '';
// One card per run: the request in words, its state, the votes, and once it has ended, the receipt.
function runCard(run, newest) {
  const ended = run.state !== 'Received';
  const kind = run.state === 'Accepted' ? 'ok' : run.state === 'Rejected' ? 'no' : 'open';
  const head = '<span class="what">Give Carol the role <b>' + esc(run.role) + '</b></span><span class="state ' + kind + '">' + esc(ended ? run.state : 'Open') + '</span>'
    + '<span class="muted small">task ' + esc(shortId(run.taskId)) + '</span>';
  const votes = '<p class="votes small">' + (run.votes.length ? 'Votes: ' + run.votes.map(v => '<b>' + esc(v.name ?? short(v.voter) + ' (another node)') + '</b> → ' + esc(v.toState)).join(', ') : 'No votes yet.') + '</p>';
  if (!ended) {
    const joiningHere = role() === 'join-here', who = joiningHere ? me() : null;
    const rows = memo.voters.map(name => {
      const mine = votedFor(run, name);
      // Joining on this computer: you vote as yourself; the others vote in their own browser.
      if (joiningHere && name !== who) return '<div class="vote-row"><span class="name">' + esc(name) + '</span><span class="muted small">' + (mine ? 'voted ' + esc(mine.toState) : 'votes in their own browser') + '</span></div>';
      return '<div class="vote-row"><span class="name">' + esc(name) + (name === who ? ' (you)' : '') + '</span>' + (mine ? '<span class="muted small">voted ' + esc(mine.toState) + '</span>'
        : '<input data-why="' + esc(run.taskId + name) + '" placeholder="why (optional)" size="16">'
        + '<button data-vote="accept" data-as="' + esc(name) + '" data-task="' + esc(run.taskId) + '">Accept</button>'
        + '<button class="danger" data-vote="reject" data-as="' + esc(name) + '" data-task="' + esc(run.taskId) + '">Reject</button>') + '</div>';
    }).join('');
    return '<div class="run open" data-run="' + esc(run.runUri) + '"><div class="head">' + head + '</div>' + votes + rows + '</div>';
  }
  const again = isStarter() ? 'Start a new request above to ' + (run.state === 'Rejected' ? 'try again.' : 'run it again.') : 'Ask ' + (starter() ?? 'the starter') + ' for a new request.';
  const open = memo.open[run.runUri] ?? newest;
  return '<details class="run ended ' + kind + '" data-run="' + esc(run.runUri) + '"' + (open ? ' open' : '') + '><summary><span class="head">' + head + '</span>'
    + '<span class="again">' + esc(again) + '</span></summary>' + votes + receiptPart(run) + '</details>';
}
function receiptPart(run) {
  const got = memo.receipts[run.taskId], starterHere = isStarter();
  let html = got ? receiptHtml(got) : '';
  if (got && !got.error) return html;
  if (!starterHere && !run.responded) return html + '<p class="small muted">The receipt comes from ' + (starter() ? starter() + '\'s' : 'the starter\'s') + ' demo app. You can check it here once it is made.</p>';
  const label = starterHere ? (run.responded ? 'Check the receipt' : 'Make the receipt and check it') : 'Check the receipt on this node';
  return html + '<div class="row"><button class="small" data-receipt="' + esc(run.taskId) + '">' + label + '</button></div>';
}
function receiptHtml(got) {
  if (got.error) return '<p class="no-text small">' + esc(got.error) + '</p>';
  const fr = receiptOf(got.response), v = got.verdict;
  const final = v?.terminalState ?? fr?.terminalState, voters = (v?.voters ?? fr?.voters ?? []).map(nameOrDid);
  let html = '<div class="receipt"><p><span class="ok-text">✓ Flow receipt</span> <code>' + esc(receiptAddress(got.receiptUri ?? fr?.uri)) + '</code>: final state <b>' + esc(final) + '</b>, votes from ' + voters.map(n => '<b>' + esc(n) + '</b>').join(', ') + '.</p>';
  if (v) html += '<p class="small">' + (got.verify ? 'The node' : 'This node') + ' checked the receipt (<code>verifyFlowReceipt</code>): <b>' + esc(v.outcome) + '</b>.</p>';
  if (got.verify) html += '<p>' + (got.verify.ok ? '<span class="ok-text">✓ The requester checked the signed answer: its signature, the receipt\'s hash and the link to its request check out.</span>' : '<span class="no-text">✗ The answer failed a check.</span>') + '</p>';
  html += '<details><summary>The checks and the signed answer</summary>'
    + (got.verify ? '<ul class="checks">' + got.verify.checks.map(c => '<li class="' + (c.ok ? '' : 'no') + '">' + esc(c.name) + '</li>').join('') + '</ul><p class="small">' + esc(got.verify.limitation) + '.</p>' : '')
    + '<p class="small">Signed answer: <code>' + esc(got.response.type.replace('https://trusttasks.org/spec/', '')) + '</code>' + (got.response.payload?.code ? ', code <b>' + esc(got.response.payload.code) + '</b>' : '') + '</p>'
    + (got.verify ? linksBetween(got.verify.request, got.response) : '')
    + '<details><summary>The signed answer (JSON)</summary><pre class="json">' + esc(JSON.stringify(got.response, null, 2)) + '</pre></details>'
    + (got.verify ? '<details><summary>The request it sent (JSON)</summary><pre class="json">' + esc(JSON.stringify(got.verify.request, null, 2)) + '</pre></details>' : '')
    + '</details></div>';
  return html;
}
function linksBetween(request, response) {
  const fr = receiptOf(response);
  if (!request || !fr) return '';
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
  return '<details><summary>How the trust task and the flow connect, field by field</summary><div class="match">'
    + rows.map(([l, a, b, r, f = v => v]) => '<div>' + l + '<br><code>' + esc(f(a)) + '</code></div><div class="mid' + (a === b ? '' : ' no-text') + '">' + (a === b ? '=' : '≠') + '</div><div>' + r + '<br><code>' + esc(f(b)) + '</code></div>').join('') + '</div></details>';
}
function renderRuns() {
  const box = $('runs');
  if (!S?.space) { if (box.innerHTML) { box.innerHTML = ''; box.dataset.html = ''; } return; }
  if (box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;   // do not redraw under the cursor
  const html = memo.runs.length ? memo.runs.map((run, i) => runCard(run, i === 0)).join('')
    : '<p class="muted">No requests yet. ' + (isStarter() ? 'Press "+ New request" above.' : 'They show up here when ' + starterWindow() + ' makes one.') + '</p>';
  if (box.dataset.html === html) return;   // nothing new: keep open folds and typed reasons
  const typed = [...box.querySelectorAll('input[data-why]')].filter(i => i.value).map(i => [i.dataset.why, i.value]);
  box.innerHTML = html; box.dataset.html = html;
  for (const [k, v] of typed) { const i = box.querySelector('input[data-why="' + CSS.escape(k) + '"]'); if (i) i.value = v; }
  box.querySelectorAll('details.run').forEach(d => { d.ontoggle = () => { memo.open[d.dataset.run] = d.open; }; });
  box.querySelectorAll('[data-vote]').forEach(b => {
    b.onclick = async () => {
      const why = box.querySelector('input[data-why="' + CSS.escape(b.dataset.task + b.dataset.as) + '"]')?.value;
      await act(b, 's6', 'I am voting ' + b.dataset.vote + ' as ' + b.dataset.as, 'POST', '/api/vote', { action:b.dataset.vote, as:b.dataset.as, taskId:b.dataset.task, why });
      loadRuns();
    };
  });
  box.querySelectorAll('[data-receipt]').forEach(b => { b.onclick = () => receipt(b, b.dataset.receipt); });
}
// The starter's demo app makes the receipt and the answer, and the requester checks the answer.
// Anyone else checks the receipt on their own node.
async function receipt(button, taskId) {
  const run = memo.runs.find(r => r.taskId === taskId);
  if (run) memo.open[run.runUri] = true;
  if (isStarter()) {
    let made = null;
    if (!run?.responded) {
      made = await act(button, 's6', 'I ask your node for the receipt, check it, then sign the answer with the trust-task key', 'POST', '/api/respond', { taskId });
      if (!made.ok) { memo.receipts[taskId] = { error:made.error }; return loadRuns(); }
    }
    const res = await act(button, 's6', 'Requester: I check the answer against the request I sent', 'POST', '/api/verify', { taskId });
    if (!res.ok) { memo.receipts[taskId] = { error:res.error }; return loadRuns(); }
    memo.verified[taskId] = res.result.ok;
    memo.receipts[taskId] = { response:res.result.response, verdict:made?.result.verdict, receiptUri:made?.result.receiptUri, verify:res.result };
  } else {
    const res = await act(button, 's6', 'I ask this node to check the receipt', 'POST', '/api/check-receipt', { taskId, as:role() === 'join-here' ? me() : undefined });
    if (!res.ok) { memo.receipts[taskId] = { error:res.error }; return loadRuns(); }
    memo.verified[taskId] = res.result.verdict.outcome === 'verified';
    memo.receipts[taskId] = { response:res.result.answer, verdict:res.result.verdict };
  }
  loadRuns();
}
$('btn-runs').onclick = e => loadRuns(e.target);

// ── The node panel: what the executor holds ─────────────────────────────────────
const OPEN = { 1:['node'], 2:['node'], 3:['node', 'people'], 4:['apps'], 5:['space'], 6:['flow', 'space'] };
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
  const mode = sp?.neighbourhood ? ((memo.members ?? []).some(m => !m.here) ? 'Shared with another node' : 'Shared space, nobody else in it yet') : (sp && Object.keys(sp.uuids).length > 1) || users.length ? 'One node, two people' : null;
  $('mode-badge').classList.toggle('hidden', !mode || !running); $('mode-badge').textContent = mode ?? '';
  const agent = agentName();
  // Node
  card('node', 'blue', running ? (a?.unlocked ? 'agent ' + esc(agent ?? '') : a?.initialized ? 'agent locked' : 'no agent yet') : 'no node yet',
    running ? '<div class="kv"><span>version</span><span>' + esc(S.info?.version ?? '…') + '</span>'
      + '<span>agent</span><span>' + (a?.did ? '<code>' + esc(short(a.did)) + '</code>' : a?.initialized ? 'locked' : 'not created yet') + '</span>'
      + '<span>keys</span><span>' + (a?.unlocked ? 'unlocked, inside the node' : a?.initialized ? 'locked (step 3)' : '—') + '</span></div>'
    : '<p class="muted">' + (n.phase === 'stopped' ? 'The node is stopped. Start it in step 2.' : 'Starting…') + '</p>', 'runtime.info() · agent.status()');
  // People
  const mu = S.multiUser;
  const sw = running && a?.unlocked && role() !== 'join-here' ? '<span class="switch" title="runtime.setMultiUserEnabled"><button data-mu="0" class="' + (mu ? '' : 'on') + '">off</button><button data-mu="1" class="' + (mu ? 'on' : '') + '">on</button></span>' : '';
  const stranded = Object.entries(S.people).filter(([, p]) => p.login === 'user').map(([nm]) => nm);
  card('people', 'blue', running ? 'multi-user ' + (mu === null ? '?' : mu ? 'on' : 'off') + sw : '',
    running ? '<ul class="plist">' + (agent ? '<li><span class="nm">' + esc(agent) + '</span><code>' + esc(short(a?.did)) + '</code><span class="tag">the node\'s agent</span></li>' : '')
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
    : '<p class="muted">No space yet (Space, at the top).</p>', sp?.neighbourhood ? 'neighbourhood.otherAgents()' : 'perspective.byUUID()');
  // Flow
  const run = memo.runs[0];
  const accepts = run ? new Set(run.votes.filter(v => v.toState === 'Accepted').map(v => v.voter)).size : 0;
  card('flow', 'mint', !sp ? '' : memo.installed ? (run ? 'run: ' + esc(run.state) : 'no run yet') : 'not installed',
    !sp ? '<p class="muted">Needs a space.</p>'
    : '<p>Rules: ' + (memo.installed ? 'the stored request <code>IiwTrustTaskRequest</code> and the flow <code>TrustTaskDecision</code> <span class="ok-text">✓</span>' : '<span class="muted">not in the space yet: "+ New request" installs it</span>') + '</p>'
      + (run ? '<p><b>Give Carol the role ' + esc(run.role) + '</b></p>'
        + '<div class="states"><span class="' + (run.state === 'Received' ? 'cur' : '') + '">Received</span><i>→</i><span class="' + (run.state === 'Accepted' ? 'cur' : '') + '">Accepted</span><span class="' + (run.state === 'Rejected' ? 'cur rej' : '') + '">Rejected</span></div>'
        + '<div class="votebar"><i style="width:' + Math.min(100, accepts * 50) + '%"></i></div><p class="small muted">' + accepts + ' of 2 votes to accept' + (run.votes.some(v => v.toState === 'Rejected') ? ' · a reject vote' : '') + '</p>'
        + (run.responded ? '<p class="ok-text">✓ flow receipt made</p>' : '')
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
