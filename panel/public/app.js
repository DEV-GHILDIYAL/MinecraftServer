'use strict';
const $ = (s) => document.querySelector(s);
let config = null;
let editing = null; // name of server being edited, or null for create
let consoleServer = null;
let consoleTimer = null;
let refreshTimer = null;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') { showLogin(); throw new Error('Not logged in'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) e.append(c);
  return e;
}

// ---------- Login ----------
function showLogin() {
  clearInterval(refreshTimer);
  $('#app-view').classList.add('hidden');
  $('#login-view').classList.remove('hidden');
  $('#password').focus();
}
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: { password: $('#password').value } });
    $('#password').value = '';
    start();
  } catch (err) { $('#login-error').textContent = err.message; }
});
$('#logout-btn').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); showLogin(); });

// ---------- Dashboard ----------
async function start() {
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  config = await api('/api/config');
  await refresh();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refresh, 5000);
}

function stateInfo(s) {
  if (s.state === 'running' && s.health === 'healthy') return ['running', 'Online'];
  if (s.state === 'running' || s.state === 'restarting') return ['starting', 'Starting…'];
  if (s.state === 'missing') return ['stopped', 'Not created'];
  return ['stopped', 'Stopped'];
}

async function refresh() {
  let list;
  try { list = await api('/api/servers'); } catch { return; }
  const box = $('#servers');
  box.replaceChildren(...list.map(serverCard));
  $('#empty').classList.toggle('hidden', list.length > 0);
}

function serverCard(s) {
  const [cls, label] = stateInfo(s);
  const running = s.state === 'running';
  const action = (name, act, opts) => el('button', { class: 'btn' + (opts?.cls ? ' ' + opts.cls : ''), onclick: (e) => doAction(e.target, name, act) }, opts?.label || act);
  return el('div', { class: 'card server' },
    el('h2', {}, el('span', { class: `dot ${cls}` }), s.name, el('span', { class: 'badge' }, label)),
    el('div', { class: 'meta' }, `${s.type} ${s.version} · ${s.difficulty} · ${s.gamemode} · ${s.memory} RAM · ${s.onlineMode ? 'Premium only' : 'Cracked allowed'}`),
    el('div', { class: 'address' },
      el('span', {}, s.address),
      el('button', { class: 'btn small', onclick: () => navigator.clipboard.writeText(s.address).then(() => toast('Address copied!')) }, 'Copy')),
    el('div', { class: 'stats' },
      el('div', {}, 'Players', el('b', {}, s.players ? `${s.players.online} / ${s.players.max}` : `– / ${s.maxPlayers}`)),
      el('div', {}, 'Port', el('b', {}, String(s.port))),
      el('div', {}, 'Whitelist', el('b', {}, s.whitelistEnabled ? 'On' : 'Off'))),
    s.players?.names.length ? el('div', { class: 'players' }, 'Online: ' + s.players.names.join(', ')) : null,
    el('div', { class: 'btns' },
      running ? action(s.name, 'stop', { label: 'Stop' }) : action(s.name, 'start', { label: 'Start', cls: 'primary' }),
      running ? action(s.name, 'restart', { label: 'Restart' }) : null,
      el('button', { class: 'btn', onclick: () => openForm(s) }, 'Settings'),
      el('button', { class: 'btn', onclick: () => openConsole(s.name) }, 'Console'),
      el('button', { class: 'btn danger', onclick: (e) => deleteServer(e.target, s.name) }, 'Delete')));
}

async function doAction(btn, name, act) {
  btn.disabled = true;
  try {
    toast(`${act}ing ${name}…`);
    await api(`/api/servers/${name}/${act}`, { method: 'POST' });
    toast(`${name}: ${act} done`);
  } catch (err) { toast(err.message); }
  btn.disabled = false;
  refresh();
}

async function deleteServer(btn, name) {
  if (prompt(`Server "${name}" delete karne ke liye uska naam type karo:`) !== name) return;
  const deleteWorld = confirm('World data bhi delete karna hai? (OK = haan, world hamesha ke liye delete. Cancel = world volume rakh lo)');
  btn.disabled = true;
  try {
    await api(`/api/servers/${name}?deleteWorld=${deleteWorld ? 1 : 0}`, { method: 'DELETE' });
    toast(`${name} deleted`);
  } catch (err) { toast(err.message); btn.disabled = false; }
  refresh();
}

// ---------- Create / Edit form ----------
const FIELDS = [
  { section: 'Basic' },
  { key: 'name', label: 'Server name', type: 'text', hint: 'lowercase, numbers, dashes (e.g. my-smp)', createOnly: true },
  { key: 'motd', label: 'MOTD (server list message)', type: 'text', full: true },
  { key: 'type', label: 'Server type', type: 'select', enum: 'type', hint: 'PAPER = fast & plugins. VANILLA = original' },
  { key: 'version', label: 'Minecraft version', type: 'text', hint: 'LATEST or e.g. 1.21.4' },
  { key: 'memory', label: 'RAM', type: 'select', options: ['1G', '1536M', '2G', '3G', '4G', '6G', '8G', '12G'], hint: 'AWS instance RAM se kam rakho' },
  { key: 'port', label: 'Port', type: 'number', hint: 'Khaali chhodo = auto', createOnly: true },
  { section: 'Gameplay' },
  { key: 'difficulty', label: 'Difficulty', type: 'select', enum: 'difficulty' },
  { key: 'gamemode', label: 'Game mode', type: 'select', enum: 'gamemode' },
  { key: 'maxPlayers', label: 'Max players', type: 'number', min: 1, max: 200 },
  { key: 'viewDistance', label: 'View distance', type: 'number', min: 3, max: 32 },
  { key: 'simulationDistance', label: 'Simulation distance', type: 'number', min: 3, max: 32 },
  { key: 'spawnProtection', label: 'Spawn protection radius', type: 'number', min: 0, max: 100 },
  { key: 'pvp', label: 'PvP', type: 'check' },
  { key: 'hardcore', label: 'Hardcore', type: 'check' },
  { key: 'allowFlight', label: 'Allow flight', type: 'check' },
  { key: 'commandBlocks', label: 'Command blocks', type: 'check' },
  { section: 'World (sirf naye world par lagta hai)' },
  { key: 'seed', label: 'Seed', type: 'text', hint: 'Khaali = random' },
  { key: 'levelType', label: 'World type', type: 'select', enum: 'levelType' },
  { section: 'Players & Access' },
  { key: 'onlineMode', label: 'Premium accounts only (online-mode)', type: 'check', full: true,
    hint: 'OFF = TLauncher / cracked / koi bhi naam se join kar sakta hai. ON = sirf paid Minecraft Java accounts.' },
  { key: 'whitelistEnabled', label: 'Whitelist ON (sirf list wale join kar sakte)', type: 'check', full: true },
  { key: 'whitelist', label: 'Whitelist players', type: 'text', full: true, hint: 'Comma separated: Steve, Alex' },
  { key: 'ops', label: 'Operators (admins in-game)', type: 'text', full: true, hint: 'Comma separated usernames' },
];

function openForm(server) {
  editing = server ? server.name : null;
  const values = server || { ...config.defaults, name: '', port: '' };
  $('#form-title').textContent = server ? `Settings — ${server.name}` : 'New Server';
  $('#form-submit').textContent = server ? 'Save & Apply' : 'Create Server';
  $('#form-note').textContent = server
    ? 'Save karne par server restart hoga (world safe rahega). Seed / world type sirf naye world par lagte hain.'
    : 'Pehli baar create mein 1–3 minute lag sakte hain (Minecraft download hota hai).';
  $('#form-error').textContent = '';
  const fields = FIELDS.filter((f) => !(server && f.createOnly)).map((f) => {
    if (f.section) return el('div', { class: 'section-title' }, f.section);
    const v = values[f.key];
    let input;
    if (f.type === 'select') {
      const opts = f.options || config.enums[f.enum];
      input = el('select', { name: f.key }, opts.map((o) => el('option', { value: o, selected: o === v }, o.replace('minecraft:', ''))));
    } else if (f.type === 'check') {
      input = el('input', { type: 'checkbox', name: f.key, checked: !!v });
      return el('div', { class: f.full ? 'full' : '' },
        el('label', { class: 'check' }, input, f.label), f.hint ? el('div', { class: 'hint' }, f.hint) : null);
    } else {
      input = el('input', { type: f.type, name: f.key, value: v ?? '', min: f.min, max: f.max,
        placeholder: f.key === 'port' ? `${config.portStart}-${config.portEnd}` : '' });
    }
    return el('label', { class: f.full ? 'full' : '' }, f.label, input, f.hint ? el('span', { class: 'hint' }, f.hint) : null);
  });
  $('#form-fields').replaceChildren(...fields);
  $('#form-modal').classList.remove('hidden');
}

$('#new-btn').addEventListener('click', () => openForm(null));
$('#server-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {};
  for (const input of $('#server-form').querySelectorAll('input, select')) {
    body[input.name] = input.type === 'checkbox' ? input.checked : input.value;
  }
  if (body.port === '') delete body.port;
  const btn = $('#form-submit');
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = editing ? 'Applying…' : 'Creating… (wait)';
  $('#form-error').textContent = '';
  try {
    if (editing) await api(`/api/servers/${editing}`, { method: 'PUT', body });
    else await api('/api/servers', { method: 'POST', body });
    closeModals();
    toast(editing ? 'Settings saved, server restarting' : 'Server created! Start hone mein ~1 min lagega');
    refresh();
  } catch (err) { $('#form-error').textContent = err.message; }
  btn.disabled = false;
  btn.textContent = old;
});

// ---------- Console ----------
async function loadLogs() {
  if (!consoleServer) return;
  const pre = $('#console-logs');
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
  try {
    const { logs } = await api(`/api/servers/${consoleServer}/logs?tail=400`);
    pre.textContent = logs;
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  } catch {}
}
function openConsole(name) {
  consoleServer = name;
  $('#console-title').textContent = `Console — ${name}`;
  $('#console-logs').textContent = 'Loading…';
  $('#console-modal').classList.remove('hidden');
  loadLogs().then(() => { const p = $('#console-logs'); p.scrollTop = p.scrollHeight; });
  consoleTimer = setInterval(loadLogs, 3000);
  $('#console-cmd').focus();
}
$('#console-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cmd = $('#console-cmd').value.trim();
  if (!cmd) return;
  $('#console-cmd').value = '';
  try {
    const { output } = await api(`/api/servers/${consoleServer}/command`, { method: 'POST', body: { command: cmd } });
    toast(output || 'Command sent');
  } catch (err) { toast(err.message); }
  loadLogs();
});

function closeModals() {
  $('#form-modal').classList.add('hidden');
  $('#console-modal').classList.add('hidden');
  clearInterval(consoleTimer);
  consoleServer = null;
}
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModals));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModals(); });

// ---------- Boot ----------
api('/api/me').then((r) => (r.loggedIn ? start() : showLogin())).catch(showLogin);
