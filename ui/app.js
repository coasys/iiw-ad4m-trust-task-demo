// The page. Plain JavaScript: each button calls the local server (ui.mjs), which calls the
// same functions as demo.mjs and requester.mjs and sends back the result and the SDK calls made.
'use strict';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const short = did => did && did.length > 26 ? did.slice(0, 16) + '…' + did.slice(-4) : (did ?? '');
const shortId = id => String(id ?? '').replace(/^urn:uuid:/, '').slice(0, 8);
let S = null;                 // the last state from the server
const memo = { runs:[], verified:{}, verdicts:{}, installed:null, released:false };

async function api(method, path, body) {
  try {
    const res = await fetch(path, { method, headers:body ? { 'Content-Type':'application/json' } : {}, body:body ? JSON.stringify(body) : undefined });
    return await res.json();
  } catch (error) { return { ok:false, error:'The page server does not answer. Is `npm start` still running? (' + error.message + ')', calls:[] }; }
}
// Run one button: busy state, call, show the SDK calls and the result under its step.
async function act(button, step, title, method, path, body) {
  if (button) { button.disabled = true; button.classList.add('busy'); }
  const started = Date.now();
  const res = await api(method, path, body);
  if (button) { button.disabled = false; button.classList.remove('busy'); }
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
  // The earlier buttons of this step stay readable, folded.
  for (const old of older) {
    const fold = document.createElement('details'); fold.className = 'entry-old';
    const head = old.querySelector('h4')?.textContent ?? old.querySelector('summary')?.textContent ?? 'earlier';
    fold.innerHTML = '<summary>Earlier: ' + esc(head) + '</summary>';
    fold.append(...(old.tagName === 'DETAILS' ? [...old.childNodes].filter(n => n.tagName !== 'SUMMARY') : [old]));
    box.append(fold);
  }
}
const say = (id, html, kind) => { $(id).innerHTML = kind ? '<span class="' + kind + '">' + html + '</span>' : html; };

// ── State: chips at the top, which steps are done or blocked ────────────────────
async function refresh() {
  const res = await api('GET', '/api/state');
  if (!res.ok) { $('chips').innerHTML = '<span class="chip no">' + esc(res.error) + '</span>'; return; }
  S = res.result;
  render();
}
function chip(text, kind) { return '<span class="chip ' + kind + '">' + esc(text) + '</span>'; }
function render() {
  const n = S.node, a = S.agent, sp = S.space;
  const multi = S.multiUser ?? S.settings.multiUser;
  $('chips').innerHTML = [
    chip('executor ' + (S.executor.ok ? S.executor.version : 'not chosen'), S.executor.ok ? 'ok' : 'no'),
    chip('node ' + n.phase + (n.phase === 'running' ? ' · ' + n.url.replace('http://', '') : ''), n.phase === 'running' ? 'ok' : n.phase === 'stopped' ? 'no' : 'wait'),
    chip(!a ? 'agent: no node' : a.error ? 'agent: ' + a.error : !a.initialized ? 'no agent yet' : !a.unlocked ? 'agent locked' : 'agent ' + short(a.did), a?.unlocked ? 'ok' : a?.initialized ? 'wait' : 'no'),
    chip(S.app.did ? 'page connected' : S.app.requestId ? 'page waiting for code' : 'page not connected', S.app.did ? 'ok' : S.app.requestId ? 'wait' : 'no'),
    chip(!sp ? 'no space' : sp.neighbourhood ? 'shared space' + (sp.link ? ' (' + sp.link + ')' : '') : 'local space', sp ? 'ok' : 'no'),
    chip('multi-user ' + (multi ? 'on' : 'off'), 'ok')
  ].join('');
  const done = {
    s1:S.executor.ok, s2:n.phase === 'running', s3:!!a?.unlocked && (!multi || Object.values(S.people).some(p => p.login === 'user')),
    s4:!!S.app.did, s5:!!sp, s6:memo.installed === true && memo.runs.length > 0,
    s7:memo.runs.some(r => r.state !== 'Received'), s8:Object.values(memo.verified).some(Boolean)
  };
  const blockers = {
    s2:!S.executor.ok && 'Choose the executor first (step 1).',
    s3:n.phase !== 'running' && 'Start the node first (step 2).',
    s4:!a?.unlocked && 'Create or unlock the agent first (step 3).',
    s5:!S.app.did && 'Connect the page first (step 4).',
    s6:!sp && 'Make or join a space first (step 5).',
    s7:!sp && 'Make or join a space first (step 5).',
    s8:!sp && 'Make or join a space first (step 5).'
  };
  if (n.phase !== 'running') for (const k of ['s4', 's5', 's6', 's7', 's8']) blockers[k] = blockers[k] || 'The node is not running (step 2).';
  for (const [i, li] of [...document.querySelectorAll('#nav li')].entries()) li.classList.toggle('done', !!done['s' + (i + 1)]);
  for (const id of Object.keys(done)) {
    const el = $(id);
    el.classList.toggle('done', !!done[id]);
    el.classList.toggle('blocked', !!blockers[id]);
    let b = el.querySelector('.blocker');
    if (blockers[id]) { if (!b) { b = document.createElement('p'); b.className = 'blocker'; el.querySelector('h2').after(b); } b.textContent = blockers[id]; }
    else b?.remove();
  }
  renderExecutor(); renderNode(); renderAgent(); renderHandshake(); renderSpace(); renderArrive();
}

// ── 1. Executor ─────────────────────────────────────────────────────────────────
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
$('btn-download').onclick = e => act(e.target, 's1', 'Download', 'POST', '/api/executor/download', {});
$('btn-use').onclick = e => act(e.target, 's1', 'Use this file', 'POST', '/api/executor/use', { path:$('exe-path').value.trim() });

// ── 2. Node ─────────────────────────────────────────────────────────────────────
let muTouched = false;
document.querySelectorAll('input[name=mu]').forEach(r => r.addEventListener('change', () => { muTouched = true; }));
function renderNode() {
  const n = S.node;
  if (!muTouched) document.querySelector('input[name=mu][value=' + (S.settings.multiUser ? 'on' : 'off') + ']').checked = true;
  if (document.activeElement !== $('port')) $('port').value = S.settings.port;
  const running = n.phase !== 'stopped';
  $('btn-start').disabled = running; $('btn-stop').disabled = !n.pid;
  document.querySelectorAll('input[name=mu], #port').forEach(i => { i.disabled = running; });
  let html = n.phase === 'running' ? '<span class="ok">● running</span> at <code>' + esc(n.url) + '</code> (process ' + n.pid + ')'
    : n.phase === 'stopped' ? '<span class="no">● stopped</span>' : '<span class="wait">● ' + esc(n.phase) + '…</span>';
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
$('btn-start').onclick = e => act(e.target, 's2', 'Start the node', 'POST', '/api/node/start',
  { multiUser:document.querySelector('input[name=mu]:checked').value === 'on', port:Number($('port').value) });
$('btn-stop').onclick = e => act(e.target, 's2', 'Stop the node', 'POST', '/api/node/stop', {});
$('btn-reset').onclick = e => {
  if (!confirm('Start over? This stops the node and deletes .node/ (the node\'s data and its agent), .demo/ (people, the space, keys) and out/.')) return;
  memo.runs = []; memo.verified = {}; memo.installed = null;
  act(e.target, 's2', 'Start over', 'POST', '/api/node/reset', {});
};

// ── 3. Agent and people ─────────────────────────────────────────────────────────
let agentFormFor = null;
function renderAgent() {
  const a = S.agent, box = $('agent-box');
  const kind = !a || a.error ? 'none' : !a.initialized ? 'create' : !a.unlocked ? 'unlock' : 'ready';
  if (kind !== agentFormFor || kind === 'ready') {
    agentFormFor = kind;
    const agentName = Object.entries(S.people).find(([, p]) => p.login === 'agent')?.[0];
    if (kind === 'none') box.innerHTML = '';
    else if (kind === 'create') box.innerHTML = '<p><b>This node has no agent yet.</b> Pick a name for it (only this page uses the name) and a passphrase. The passphrase encrypts the agent\'s keys on disk; it is not stored unless you tick the box.</p>'
      + '<div class="row"><label>Name <input id="ag-name" value="bob" size="10"></label>'
      + '<label>Passphrase <input id="ag-pass" type="password" autocomplete="new-password"></label>'
      + '<label>Again <input id="ag-pass2" type="password" autocomplete="new-password"></label></div>'
      + '<div class="row"><label class="small"><input type="checkbox" id="ag-remember"> Remember it in <code>.demo/agent-passphrase</code> (readable only by you), so a restarted node unlocks by itself</label></div>'
      + '<div class="row"><button id="btn-agent">Create the agent</button></div>';
    else if (kind === 'unlock') box.innerHTML = '<p><b>The agent is locked</b> (the node was restarted). Type its passphrase to unlock it.</p>'
      + '<div class="row"><label>Name <input id="ag-name" value="' + esc(agentName ?? 'bob') + '" size="10"></label><label>Passphrase <input id="ag-pass" type="password" autocomplete="current-password"></label>'
      + '<label class="small"><input type="checkbox" id="ag-remember"> Remember it</label><button id="btn-agent">Unlock</button></div>';
    else box.innerHTML = '<p class="ok-text">✓ The node\'s agent' + (agentName ? ' <b>' + esc(agentName) + '</b>' : '') + ' is unlocked: <code>' + esc(a.did) + '</code></p>';
    const btn = $('btn-agent');
    if (btn) btn.onclick = async () => {
      const pass = $('ag-pass').value;
      if (kind === 'create' && pass !== $('ag-pass2').value) return showTrace('s3', 'Create the agent', { ok:false, error:'The two passphrases differ' });
      const res = await act(btn, 's3', kind === 'create' ? 'Create the agent' : 'Unlock the agent', 'POST', '/api/agent',
        { name:$('ag-name').value.trim(), passphrase:pass, remember:$('ag-remember').checked });
      if ($('ag-pass')) $('ag-pass').value = ''; if ($('ag-pass2')) $('ag-pass2').value = '';
      if (res.ok) agentFormFor = null;
    };
  }
  const multi = S.multiUser ?? S.settings.multiUser;
  $('users-box').classList.toggle('hidden', !multi);
  const users = Object.entries(S.people).filter(([, p]) => p.login === 'user');
  $('users-list').innerHTML = users.length ? '<ul>' + users.map(([name, p]) => '<li><b>' + esc(name) + '</b> <code>' + esc(short(p.did)) + '</code> '
    + (S.loggedIn.includes(name) ? '<span class="ok-text">logged in ✓</span>' : '<button class="secondary small" data-login="' + esc(name) + '">Log in</button>') + '</li>').join('') + '</ul>'
    : '<p class="muted small">Nobody yet. Add one person, for example alice.</p>';
  document.querySelectorAll('[data-login]').forEach(b => { b.onclick = () => act(b, 's3', 'Log in ' + b.dataset.login, 'POST', '/api/users/login', { name:b.dataset.login }); });
}
$('btn-user-add').onclick = e => act(e.target, 's3', 'Add a person', 'POST', '/api/users/add', { name:$('user-name').value.trim() || 'alice' });

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
    say('hs-status', '✓ Connected. This page acts as your agent <code>' + esc(S.app.did) + '</code> with its own token. The agent\'s steps below use that token. One exception: a space owned by a user on this node (multi-user mode) is that user\'s, and the node\'s agent reaches it only through the admin credential, as on the command line.', 'ok'); }
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
      $('hs-logline').innerHTML = '<p class="small">The node wrote this line to its log (also in the log in step 2). The number after <code>rand=</code> is your code:</p><pre>' + line + '</pre>';
      $('hs-logline').classList.remove('hidden');
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
  const res = await act(e.target, 's4', 'Ask for access', 'POST', '/api/handshake/request', {});
  if (res.ok) say('hs-status', 'Asked. Request id <code>' + esc(res.result.requestId) + '</code>. Waiting for the node to write the code…', 'wait');
};
$('btn-hs-redeem').onclick = async e => {
  const res = await act(e.target, 's4', 'Send the code', 'POST', '/api/handshake/redeem', { code:$('hs-code').value.trim() });
  $('hs-code').value = '';
  if (res.ok) loadTemplates();
};

// ── 5. Space ────────────────────────────────────────────────────────────────────
async function loadTemplates() {
  const res = await api('GET', '/api/templates');
  if (!res.ok) return;
  const list = res.result;
  $('templates').classList.remove('muted');
  $('templates').innerHTML = list.map(t => '<label class="tpl"><input type="radio" name="tpl" value="' + esc(t.demo ?? '') + '"' + (t.demo ? '' : ' disabled')
    + (t.demo === 'server' ? ' checked' : '') + '> <b>' + esc(t.name) + '</b>'
    + (t.demo === 'server' ? ' <span class="rec">recommended</span>: one link server relays the links; joining took about 6 s in our tests'
      : t.demo === 'holochain' ? ': peer to peer over Holochain; joining took 16 to 60 s in our tests' : ' (this demo does not use it)')
    + '<br><code class="small muted">' + esc(t.address) + '</code></label>').join('') || 'This node knows no link language yet. Sharing needs the network.';
  showTrace('s5', 'Known link languages', res);
}
function renderSpace() {
  const people = Object.entries(S.people), sp = S.space;
  const users = people.filter(([, p]) => p.login === 'user').map(([n]) => n), agent = people.filter(([, p]) => p.login === 'agent').map(([n]) => n);
  const fill = (sel, names) => { const html = names.map(n => '<option>' + esc(n) + '</option>').join(''); if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; } };
  document.querySelectorAll('.owner-select').forEach(sel => fill(sel, [...users, ...agent]));
  fill($('join-as'), [...agent, ...users]);
  $('space-choices').classList.toggle('hidden', !!sp);
  if (!sp) { $('space-current').innerHTML = ''; return; }
  const names = Object.keys(sp.uuids);
  let html = '<span class="ok">✓ ' + (sp.neighbourhood ? 'Shared space' : 'Local space') + '</span>, AD4M perspective <code>' + esc(Object.values(sp.uuids)[0]) + '</code>. '
    + 'In it on this node: ' + names.map(n => '<b>' + esc(n) + '</b>').join(', ') + '.';
  if (sp.owner) html += ' Owner: <b>' + esc(sp.owner) + '</b>. Trust tasks go to the space\'s DID <code>' + esc(short(sp.spaceDid)) + '</code>.';
  else html += ' Joined here: the node that made it receives the trust tasks.';
  if (sp.neighbourhood) html += '<br>Neighbourhood URL (give this to the other node): <code id="nh-url">' + esc(sp.neighbourhood) + '</code> <button class="secondary small" id="btn-copy">Copy</button>';
  if (sp.owner && !sp.neighbourhood && users.length + agent.length > 0) html += '<br><span class="small muted">To let another node in, use "Start over" in step 2 and make a shared space, or run <code>node demo.mjs share</code>.</span>';
  if (!sp.neighbourhood && names.length < 2) html += '<br><span class="small wait">Only one person is in this space, so only "reject" can end a run (accept needs 2 voters).</span>';
  $('space-current').innerHTML = html;
  const copy = $('btn-copy'); if (copy) copy.onclick = () => navigator.clipboard?.writeText(sp.neighbourhood);
}
$('btn-space-local').onclick = e => act(e.target, 's5', 'Make a local space', 'POST', '/api/space/local', { as:$('local-owner').value }).then(afterSpace);
$('btn-space-share').onclick = e => act(e.target, 's5', 'Make and share', 'POST', '/api/space/share',
  { as:$('share-owner').value, link:document.querySelector('input[name=tpl]:checked')?.value || 'server', serverUrl:$('server-url').value.trim() }).then(afterSpace);
$('btn-space-join').onclick = e => act(e.target, 's5', 'Join', 'POST', '/api/space/join', { url:$('join-url').value.trim(), as:$('join-as').value }).then(afterSpace);
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
  $('mapping').textContent = res.result.lines.join('\n');
  $('links').textContent = res.result.links.join('\n');
  document.querySelectorAll('[data-diagram]').forEach(el => { el.innerHTML = ''; el.append(diagram(null)); });
  const latest = await api('GET', '/api/request/latest');
  showTask(latest.ok && latest.result.doc, false);
}
function showTask(doc, fresh) {
  if (!doc) { $('task-json').textContent = '(No trust task yet. "Requester: sign a trust task" below makes one.)'; return; }
  let text = esc(JSON.stringify(doc, null, 2));
  for (const key of ['issuer', 'recipient', 'subject', 'role']) text = text.replace(new RegExp('(&quot;' + key + '&quot;: )(&quot;[^&]*&quot;)'), '$1<span class="hl">$2</span>');
  $('task-json').innerHTML = (fresh ? '' : '<span class="muted">// the last one signed in this folder\n</span>') + text;
}
async function checkFlow(button) {
  if (!S?.space) return;
  const res = button ? await act(button, 's6', 'Is the flow installed?', 'GET', '/api/flow/installed') : await api('GET', '/api/flow/installed');
  if (!res.ok) { say('flow-status', esc(res.error), 'no'); return; }
  memo.installed = res.result.installed;
  say('flow-status', res.result.installed ? '✓ The flow <code>iiw://TrustTaskDecisionFlow</code> and its classes are in the space.'
    : (S.space.owner ? 'Not installed yet. Install it with the button.' : 'Not here yet. The space\'s maker installs it; it then syncs to this node. Check again in a few seconds.'), res.result.installed ? 'ok' : 'wait');
  $('btn-flow-install').disabled = res.result.installed || !S.space.owner;
  render();
}
function renderArrive() {
  const joined = S.space && !S.space.owner;
  $('arrive').classList.toggle('hidden', !!joined); $('arrive-joined').classList.toggle('hidden', !joined);
  ['btn-req-new', 'btn-req-receive', 'btn-req-tamper'].forEach(id => { $(id).disabled = memo.installed !== true; });
  if (memo.installed !== true) say('receive-status', 'Install the flow first.', 'muted');
}
$('btn-flow-check').onclick = e => checkFlow(e.target);
$('btn-flow-install').onclick = async e => { const res = await act(e.target, 's6', 'Install the flow', 'POST', '/api/flow/install', {}); if (res.ok) checkFlow(); };
let pending = 'out/request.json';
$('btn-req-new').onclick = async e => {
  const res = await act(e.target, 's6', 'Requester: sign a trust task', 'POST', '/api/request/new', {});
  if (res.ok) { pending = res.result.file; showTask(res.result.doc, true); say('receive-status', 'Signed by the requester and saved as <code>' + esc(res.result.file) + '</code>. Now let AD4M take it in.', 'wait'); }
};
$('btn-req-tamper').onclick = async e => {
  const res = await act(e.target, 's6', 'Requester: sign, then change it', 'POST', '/api/request/new', { tamper:true });
  if (res.ok) { pending = res.result.file; showTask(res.result.doc, true); say('receive-status', 'Changed after signing: ' + esc(res.result.changed) + '. Now let AD4M check it.', 'wait'); }
};
$('btn-req-receive').onclick = async e => {
  const res = await act(e.target, 's6', 'AD4M: check it and start the flow', 'POST', '/api/request/receive', { file:pending });
  if (!res.ok) return say('receive-status', esc(res.error), 'no');
  const r = res.result;
  if (r.kind === 'accepted') say('receive-status', 'schema ✓ recipient ✓ fresh ✓ proof ✓ not a duplicate ✓<br>Stored byte for byte ✓, and a run of the flow started in state <b>' + esc(r.state) + '</b> (<code>' + esc(r.runUri) + '</code>). Go to step 7 to vote.', 'ok');
  else if (r.kind === 'rejected') say('receive-status', 'Refused before any flow: <b>' + esc(r.code) + '</b>. Nothing was stored. The space signed an error for the requester: <code>' + esc(r.path) + '</code>.', 'no');
  else say('receive-status', esc(r.kind) + (r.path ? ' → <code>' + esc(r.path) + '</code>' : ''), 'wait');
  pending = 'out/request.json';
  loadRuns();
};

// ── 7. Runs and votes ───────────────────────────────────────────────────────────
async function loadRuns(button) {
  if (!S?.space || S.node.phase !== 'running') return;
  const res = button ? await act(button, 's7', 'List the flow runs', 'GET', '/api/runs') : await api('GET', '/api/runs');
  if (!res.ok) { $('runs-note').textContent = res.error; return; }
  memo.runs = res.result.runs;
  if (res.result.installed !== undefined && memo.installed !== res.result.installed) { memo.installed = res.result.installed; checkFlow(); }
  $('runs-note').textContent = memo.runs.length ? memo.runs.length + ' run(s); refreshes every 4 s' : '';
  renderRuns(res.result.voters ?? []);
  renderAnswerTasks();
  render();
}
const votedFor = (run, name) => run.votes.find(v => v.name === name);
function renderRuns(voters) {
  const box = $('runs');
  if (box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;   // do not redraw under the cursor
  if (!memo.runs.length) { box.innerHTML = '<p class="muted">No runs yet. A run starts when AD4M takes in a trust task (step 6).</p>'; return; }
  const open = new Set([...box.querySelectorAll('input[data-why]')].filter(i => i.value).map(i => i.dataset.why + '|' + i.value));
  box.innerHTML = '';
  for (const run of memo.runs) {
    const el = document.createElement('div'); el.className = 'run';
    const end = run.responded ? (run.state === 'Accepted' ? 'response' : 'error') : null;
    el.innerHTML = '<div class="head"><div><b>Task ' + esc(shortId(run.taskId)) + '</b>: give <code>' + esc(short(run.subject)) + '</code> the role <b>' + esc(run.role) + '</b>'
      + '<br><span class="small muted">run <code>' + esc(run.runUri) + '</code></span></div>'
      + '<div>State: <b class="' + (run.state === 'Accepted' ? 'ok-text' : run.state === 'Rejected' ? 'no-text' : '') + '">' + esc(run.state) + '</b>'
      + (run.responded ? ' · answered (' + esc(run.responseKind) + ')' : '') + '</div></div>'
      + '<div class="diagram"></div>'
      + '<div class="votes small">' + (run.votes.length ? 'Votes so far: ' + run.votes.map(v => '<b>' + esc(v.name ?? short(v.voter) + ' (another node)') + '</b> → ' + esc(v.toState)).join(', ') : 'No votes yet.') + '</div>'
      + (run.state === 'Received' ? voters.map(name => {
        const mine = votedFor(run, name);
        return '<div class="vote-row"><span class="name">' + esc(name) + '</span>' + (mine ? '<span class="muted small">voted ' + esc(mine.toState) + '</span>'
          : '<input data-why="' + esc(run.taskId + name) + '" placeholder="why (optional)" size="22">'
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
      await act(b, 's7', b.dataset.as + ' votes ' + b.dataset.vote, 'POST', '/api/vote', { action:b.dataset.vote, as:b.dataset.as, taskId:b.dataset.task, why });
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
  $('btn-respond').classList.toggle('hidden', !!joined); $('btn-verify').disabled = !!joined;
  if (joined) $('req-side').innerHTML = '<p class="small muted">The requester talks to the node that made the space. On this node you can check the receipt (left).</p>';
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
  $('links-between').innerHTML = '<h3>How the trust task and the flow connect</h3><div class="match">'
    + rows.map(([l, a, b, r, f = v => v]) => '<div>' + l + '<br><code>' + esc(f(a)) + '</code></div><div class="mid' + (a === b ? '' : ' no-text') + '">' + (a === b ? '=' : '≠') + '</div><div>' + r + '<br><code>' + esc(f(b)) + '</code></div>').join('') + '</div>';
}
$('btn-respond').onclick = async e => {
  const res = await act(e.target, 's8', 'Make the receipt and the answer', 'POST', '/api/respond', { taskId:taskNow() });
  if (!res.ok) { $('space-side').innerHTML = '<p class="no-text">' + esc(res.error) + '</p>'; return; }
  spaceSide(res.result.response, res.result.verdict, res.result.receiptUri);
  if (res.result.existing) $('space-side').insertAdjacentHTML('afterbegin', '<p class="small muted">Already answered: this is the same signed answer as before.</p>');
  loadRuns();
};
$('btn-verify').onclick = async e => {
  const res = await act(e.target, 's8', 'Requester: check the answer', 'POST', '/api/verify', { taskId:taskNow() });
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
  const res = await act(e.target, 's8', 'Check the receipt on this node', 'POST', '/api/check-receipt', { taskId:taskNow() });
  if (!res.ok) { $('space-side').innerHTML = '<p class="no-text">' + esc(res.error) + '</p>'; return; }
  spaceSide(res.result.answer, res.result.verdict);
  if (!S.space.owner) memo.verified[taskNow()] = res.result.verdict.outcome === 'verified';
  render();
};

// ── Start ───────────────────────────────────────────────────────────────────────
(async () => {
  await refresh();
  loadRelease(); loadDefinition(); pollLog();
  if (S?.app.did) loadTemplates();
  if (S?.space) { checkFlow(); loadRuns(); }
  setInterval(refresh, 2500);
  setInterval(pollLog, 2000);
  setInterval(() => { if (!document.hidden && S?.space && S.node.phase === 'running') loadRuns(); }, 4000);
})();
