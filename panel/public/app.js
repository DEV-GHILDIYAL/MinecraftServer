'use strict';
/* ================= helpers ================= */
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

function el(tag, attrs = {}, ...children) {
  const isSvg = tag === 'svg';
  const e = isSvg ? document.createElementNS('http://www.w3.org/2000/svg', 'svg') : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (isSvg) e.setAttribute(k === 'class' ? 'class' : k, v);
    else if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k in e && typeof v !== 'string') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c);
  return e;
}

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

function toast(msg, isErr = false) {
  const t = el('div', { class: 'toast' + (isErr ? ' err' : '') }, msg);
  $('#toasts').append(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 3500);
  setTimeout(() => t.remove(), 3900);
}

const fmtBytes = (b) => (b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : Math.round(b / 1048576) + ' MB');
function fmtDuration(sec) {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}
function statusOf(s) {
  if (!s) return ['offline', 'Offline'];
  if (s.state === 'running' && s.health === 'healthy') return ['online', 'Online'];
  if (s.state === 'running' || s.state === 'restarting') return ['starting', 'Starting…'];
  if (s.state === 'missing') return ['offline', 'Not created'];
  return ['offline', 'Offline'];
}
const headUrl = (name) => `https://mc-heads.net/avatar/${encodeURIComponent(name)}/64`;

/* ================= state ================= */
const state = {
  config: null,
  servers: [],
  selected: null,
  tab: 'overview',
  logs: [],
  es: null,
  hist: { cpu: [], mem: [] },
  lastStats: null,
  cmdHistory: [],
  cmdIdx: -1,
  filter: '',
  hideNoise: true,
  autoscroll: true,
  timers: [],
};
const MAX_LOGS = 3000;
const NOISE = /RCON (Listener|Client)|Thread RCON/;

/* ================= login ================= */
function showLogin() {
  state.timers.forEach(clearInterval);
  state.timers = [];
  state.es?.close();
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
    boot();
  } catch (err) { $('#login-error').textContent = err.message; }
});
$('#logout-btn').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); showLogin(); });

/* ================= boot / polling ================= */
async function boot() {
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  state.config = await api('/api/config');
  const [name, tab] = decodeURIComponent(location.hash.slice(1)).split('/');
  await refreshServers();
  select(name && state.servers.some((s) => s.name === name) ? name : state.servers[0]?.name || null, tab || 'overview');
  refreshHost();
  state.timers.push(setInterval(refreshServers, 4000));
  state.timers.push(setInterval(refreshHost, 10000));
  state.timers.push(setInterval(refreshStats, 3000));
  state.timers.push(setInterval(tickUptime, 1000));
}

async function refreshServers() {
  try { state.servers = await api('/api/servers'); } catch { return; }
  renderSidebar();
  if (state.selected && !current()) select(state.servers[0]?.name || null);
  else updateLive();
}
const current = () => state.servers.find((s) => s.name === state.selected);

async function refreshHost() {
  try {
    const h = await api('/api/host');
    const memUsed = h.memTotal - h.memFree;
    const chip = (label, val, pct, color) => el('div', { class: 'chip' }, label, el('b', {}, val),
      pct != null ? el('span', { class: 'mini-bar' }, el('i', { style: `width:${Math.min(100, pct)}%;background:${color}` })) : null);
    const items = [
      chip('CPU', `${Math.round((h.load / h.cpus) * 100)}%`, (h.load / h.cpus) * 100, 'var(--diamond)'),
      chip('RAM', `${fmtBytes(memUsed)} / ${fmtBytes(h.memTotal)}`, (memUsed / h.memTotal) * 100, 'var(--grass)'),
    ];
    if (h.disk) {
      const used = h.disk.total - h.disk.free;
      items.push(chip('Disk', `${fmtBytes(used)} / ${fmtBytes(h.disk.total)}`, (used / h.disk.total) * 100, 'var(--gold)'));
    }
    items.push(chip('Uptime', fmtDuration(h.uptime)));
    $('#host-stats').replaceChildren(...items);
  } catch {}
}

async function refreshStats() {
  const s = current();
  if (!s || s.state !== 'running') { state.lastStats = null; return; }
  try {
    const st = await api(`/api/servers/${s.name}/stats`);
    if (!st.running || s.name !== state.selected) return;
    state.lastStats = st;
    state.hist.cpu.push(st.cpu / (st.cpuMax / 100));
    state.hist.mem.push(st.mem);
    if (state.hist.cpu.length > 40) { state.hist.cpu.shift(); state.hist.mem.shift(); }
    updateStats();
  } catch {}
}

function tickUptime() {
  const s = current();
  const node = $('#st-uptime');
  if (node) node.textContent = s?.startedAt ? fmtDuration((Date.now() - new Date(s.startedAt)) / 1000) : '—';
}

/* ================= sidebar ================= */
function renderSidebar() {
  const list = $('#server-list');
  if (!state.servers.length) {
    list.replaceChildren(el('div', { class: 'side-empty' }, 'Koi server nahi. "+ New" dabao!'));
    return;
  }
  list.replaceChildren(...state.servers.map((s) => {
    const [cls, label] = statusOf(s);
    return el('a', { class: 'srv-item' + (s.name === state.selected ? ' active' : ''), href: `#${s.name}`, onclick: (e) => { e.preventDefault(); select(s.name); } },
      el('span', { class: `dot ${cls}` }),
      el('div', { class: 'grow' }, el('div', { class: 'name' }, s.name), el('div', { class: 'sub' }, `${label} · ${s.version}`)),
      el('span', { class: 'count' }, s.players ? `${s.players.online}/${s.players.max}` : ''));
  }));
}

/* ================= selection & main ================= */
function select(name, tab) {
  const changed = name !== state.selected;
  state.selected = name;
  if (tab) state.tab = tab;
  if (changed) {
    state.logs = [];
    state.hist = { cpu: [], mem: [] };
    state.lastStats = null;
    openLogStream();
    refreshStats();
  }
  history.replaceState(null, '', name ? `#${name}/${state.tab}` : '#');
  renderSidebar();
  renderMain();
}

function openLogStream() {
  state.es?.close();
  state.es = null;
  if (!state.selected) return;
  const es = new EventSource(`/api/servers/${encodeURIComponent(state.selected)}/logs/stream`);
  es.addEventListener('reset', () => { state.logs = []; $$('.console').forEach((c) => c.replaceChildren()); });
  es.onmessage = (e) => { try { pushLog(JSON.parse(e.data)); } catch {} };
  state.es = es;
}

function renderMain() {
  const main = $('#main');
  const s = current();
  if (!s) {
    main.replaceChildren(el('div', { class: 'welcome' },
      el('div', { class: 'block' }),
      el('h1', {}, 'Welcome to CraftPanel'),
      el('p', {}, 'Apna pehla Minecraft server banao — naam do, difficulty chuno, players set karo, aur 2 minute mein dosto ke saath khelo.'),
      el('button', { class: 'mc-btn green', style: 'padding:12px 22px;font-size:15px', onclick: () => openCreate() }, '+ Create your first server')));
    return;
  }
  const tabs = [['overview', '📊 Overview'], ['console', '⌨ Console'], ['players', '👥 Players'], ['settings', '⚙ Settings']];
  main.replaceChildren(
    renderHero(s),
    el('div', { class: 'tabs' }, tabs.map(([id, label]) => el('button', {
      class: 'tab' + (state.tab === id ? ' active' : ''), id: `tab-${id}`,
      onclick: () => select(s.name, id),
    }, label, id === 'players' && s.players?.online ? el('span', { class: 'badge' }, String(s.players.online)) : null))),
    el('div', { id: 'tab-body' }, state.tab === 'console' ? renderConsoleTab()
      : state.tab === 'players' ? renderPlayersTab(s)
        : state.tab === 'settings' ? renderSettingsTab(s)
          : renderOverviewTab(s)));
  paintConsoles();
  updateLive();
  updateStats();
  tickUptime();
}

/* ---------- hero ---------- */
function renderHero(s) {
  return el('section', { class: 'hero' },
    el('div', { class: 'hero-top' },
      el('div', {},
        el('h1', {}, s.name, el('span', { class: 'pill', id: 'hero-pill' })),
        el('div', { class: 'motd', id: 'hero-motd' }, s.motd)),
      el('div', { class: 'hero-actions', id: 'hero-actions' })),
    el('div', { class: 'address' },
      el('div', { style: 'flex:1;min-width:0' }, el('div', { class: 'lbl' }, 'Server address · Java Edition'), el('code', { id: 'hero-addr' }, s.address)),
      el('button', { class: 'mc-btn gold small', onclick: () => navigator.clipboard.writeText(current().address).then(() => toast('📋 Address copied!')) }, 'Copy')));
}

function updateLive() {
  const s = current();
  if (!s) return;
  const [cls, label] = statusOf(s);
  const pill = $('#hero-pill');
  if (pill) { pill.className = `pill ${cls}`; pill.replaceChildren(el('span', { class: `dot ${cls}` }), label); }
  const motd = $('#hero-motd'); if (motd) motd.textContent = s.motd;
  const actions = $('#hero-actions');
  if (actions && actions.dataset.state !== s.state + busyKey()) {
    actions.dataset.state = s.state + busyKey();
    const running = s.state === 'running';
    const busy = state.busy === s.name;
    actions.replaceChildren(
      running ? actionBtn('stop', '■ Stop', 'red', busy) : actionBtn('start', '▶ Start', 'green', busy),
      running ? actionBtn('restart', '↻ Restart', 'blue', busy) : null);
  }
  const badge = $('#tab-players .badge');
  const tp = $('#tab-players');
  if (tp) {
    if (s.players?.online && !badge) tp.append(el('span', { class: 'badge' }, String(s.players.online)));
    else if (badge) s.players?.online ? (badge.textContent = s.players.online) : badge.remove();
  }
  // overview stats
  const pl = $('#st-players');
  if (pl) {
    pl.replaceChildren(s.players ? String(s.players.online) : '0', el('small', {}, ` / ${s.maxPlayers}`));
    $('#bar-players').style.width = `${s.players ? (s.players.online / s.players.max) * 100 : 0}%`;
  }
  const ol = $('#ov-online');
  if (ol) ol.replaceChildren(...onlineHeads(s));
  if (state.tab === 'players') {
    const grid = $('#players-grid');
    const key = JSON.stringify(s.players?.names || []);
    if (grid && grid.dataset.key !== key) { grid.dataset.key = key; grid.replaceChildren(...playerCards(s)); }
  }
}
const busyKey = () => (state.busy ? '|busy' : '');

function actionBtn(act, label, color, busy) {
  return el('button', { class: `mc-btn ${color}`, disabled: busy, onclick: () => doAction(act) }, busy ? el('span', { class: 'spin' }) : null, label);
}

async function doAction(act) {
  const s = current();
  state.busy = s.name;
  updateLive();
  try {
    await api(`/api/servers/${s.name}/${act}`, { method: 'POST' });
    toast({ start: '▶ Server starting…', stop: '■ Server stopped', restart: '↻ Server restarting…' }[act]);
  } catch (err) { toast(err.message, true); }
  state.busy = null;
  await refreshServers();
  if (act !== 'stop') openLogStream();
}

/* ---------- overview ---------- */
function statCard(id, icon, label, color) {
  return el('div', { class: 'card stat' },
    el('div', { class: 'k' }, icon, ' ', label),
    el('div', { class: 'v', id: `st-${id}` }, '—'),
    el('div', { class: 'bar' }, el('i', { id: `bar-${id}`, style: `--c:${color}` })),
    el('svg', { class: 'spark', id: `spark-${id}`, viewBox: '0 0 100 40', preserveAspectRatio: 'none' }));
}

function renderOverviewTab(s) {
  const info = [
    ['Type', s.type], ['Version', s.version], ['Difficulty', s.difficulty], ['Game mode', s.gamemode],
    ['Max players', s.maxPlayers], ['RAM', s.memory], ['PvP', s.pvp ? 'On' : 'Off'],
    ['Accounts', s.onlineMode ? 'Premium only' : 'Cracked allowed'], ['Whitelist', s.whitelistEnabled ? 'On' : 'Off'], ['Port', s.port],
  ];
  return el('div', {},
    el('div', { class: 'stats' },
      statCard('players', '👥', 'Players online', 'var(--grass)'),
      statCard('cpu', '⚡', 'CPU', 'var(--diamond)'),
      statCard('mem', '🧠', 'RAM used', 'var(--amethyst)'),
      el('div', { class: 'card stat' }, el('div', { class: 'k' }, '⏱ Uptime'), el('div', { class: 'v', id: 'st-uptime' }, '—'),
        el('div', { class: 'muted', style: 'font-size:12px' }, '24/7 auto-restart ON'))),
    el('div', { class: 'grid2' },
      el('div', { class: 'card' },
        el('div', { class: 'card-title' }, el('span', {}, '● Live logs'),
          el('button', { class: 'mc-btn ghost small', onclick: () => select(s.name, 'console') }, 'Open console →')),
        el('div', { class: 'console mini', 'data-mini': '1' })),
      el('div', { style: 'display:grid;gap:14px;align-content:start' },
        el('div', { class: 'card' }, el('div', { class: 'card-title' }, 'Online now'), el('div', { id: 'ov-online', style: 'display:flex;gap:8px;flex-wrap:wrap' })),
        el('div', { class: 'card' }, el('div', { class: 'card-title' }, 'Server info'),
          el('div', { class: 'info-list' }, info.map(([k, v]) => el('div', {}, el('span', {}, k), el('b', {}, String(v)))))),
        el('div', { class: 'card' }, el('div', { class: 'card-title' }, '🎮 Kaise join kare'),
          el('ol', { class: 'steps' },
            el('li', {}, 'Minecraft ', el('b', {}, 'Java Edition'), ' kholo', s.version !== 'LATEST' ? ` (version ${s.version})` : ' (latest version)'),
            el('li', {}, el('b', {}, 'Multiplayer → Add Server')),
            el('li', {}, 'Address: ', el('code', {}, s.address)),
            el('li', {}, s.onlineMode ? 'Paid Microsoft account chahiye' : 'Koi bhi launcher / username chalega (TLauncher bhi)'))))));
}

function onlineHeads(s) {
  if (!s.players?.names.length) return [el('span', { class: 'muted' }, s.state === 'running' ? 'Abhi koi online nahi 😴' : 'Server offline')];
  return s.players.names.map((n) => el('div', { title: n, style: 'display:flex;align-items:center;gap:6px;background:var(--bg2);padding:4px 10px 4px 4px;border-radius:99px' },
    el('img', { src: headUrl(n), width: 24, height: 24, style: 'border-radius:4px;image-rendering:pixelated', onerror: (e) => { e.target.src = headUrl('MHF_Steve'); } }),
    el('span', { style: 'font-size:13px;font-weight:600' }, n)));
}

function sparkPath(vals, max) {
  if (vals.length < 2) return '';
  const step = 100 / (vals.length - 1);
  const pts = vals.map((v, i) => `${(i * step).toFixed(1)},${(40 - (Math.min(v, max) / max) * 38).toFixed(1)}`);
  return `M0,40 L${pts.join(' L')} L100,40 Z`;
}
function drawSpark(id, vals, max, color) {
  const svg = $(`#spark-${id}`);
  if (!svg) return;
  svg.innerHTML = `<path d="${sparkPath(vals, max)}" fill="${color}"/>`;
}

function updateStats() {
  const st = state.lastStats;
  const cpu = $('#st-cpu');
  if (!cpu) return;
  if (!st) {
    cpu.textContent = '—'; $('#st-mem').textContent = '—';
    $('#bar-cpu').style.width = '0'; $('#bar-mem').style.width = '0';
    return;
  }
  const cpuPct = st.cpu / (st.cpuMax / 100);
  cpu.replaceChildren(cpuPct.toFixed(1), el('small', {}, ' %'));
  $('#bar-cpu').style.width = `${Math.min(100, cpuPct)}%`;
  const s = current();
  const memMax = parseMem(s?.memory) * 1.3 || st.memLimit;
  $('#st-mem').replaceChildren(fmtBytes(st.mem).split(' ')[0], el('small', {}, ' ' + fmtBytes(st.mem).split(' ')[1] + ` · heap ${s?.memory}`));
  $('#bar-mem').style.width = `${Math.min(100, (st.mem / memMax) * 100)}%`;
  drawSpark('cpu', state.hist.cpu, 100, 'var(--diamond)');
  drawSpark('mem', state.hist.mem, memMax, 'var(--amethyst)');
}
function parseMem(m) {
  if (!m) return 0;
  const n = parseInt(m, 10);
  return m.endsWith('G') ? n * 1073741824 : n * 1048576;
}

/* ---------- console ---------- */
function renderConsoleTab() {
  const quick = [
    ['☀ Day', 'time set day'], ['🌙 Night', 'time set night'], ['🌤 Clear weather', 'weather clear'],
    ['🌧 Rain', 'weather rain'], ['💾 Save world', 'save-all'], ['📋 Player list', 'list'],
    ['🕊 Peaceful', 'difficulty peaceful'], ['⚔ Hard', 'difficulty hard'], ['📢 Say hello', 'say Hello from CraftPanel!'],
  ];
  const input = el('input', { id: 'cmd-input', placeholder: 'Command likho… (op Steve, gamemode creative Alex, tp Alex Steve)', autocomplete: 'off', onkeydown: cmdKeys });
  return el('div', {},
    el('div', { class: 'console-tools' },
      el('input', { placeholder: '🔍 Search logs…', value: state.filter, oninput: (e) => { state.filter = e.target.value; paintConsoles(); } }),
      el('label', { class: 'toggle' }, el('input', { type: 'checkbox', checked: state.autoscroll, onchange: (e) => { state.autoscroll = e.target.checked; } }), 'Auto-scroll'),
      el('label', { class: 'toggle' }, el('input', { type: 'checkbox', checked: state.hideNoise, onchange: (e) => { state.hideNoise = e.target.checked; paintConsoles(); } }), 'Hide RCON noise'),
      el('span', { style: 'flex:1' }),
      el('button', { class: 'mc-btn ghost small', onclick: downloadLogs }, '⬇ Download'),
      el('button', { class: 'mc-btn ghost small', onclick: () => { state.logs = []; paintConsoles(); } }, '🧹 Clear view')),
    el('div', { class: 'console full' }),
    el('form', { class: 'cmd-row', onsubmit: sendCmd },
      el('div', { class: 'prompt' }, el('span', {}, '/'), input),
      el('button', { class: 'mc-btn green', type: 'submit' }, 'Send ↵')),
    el('div', { class: 'quick' }, quick.map(([label, cmd]) => el('button', { type: 'button', onclick: () => runCmd(cmd) }, label))));
}

function classify(line) {
  if (/^> /.test(line)) return 'cmd';
  if (/\bERROR\b|Exception|FATAL|SEVERE/.test(line)) return 'err';
  if (/\bWARN/.test(line)) return 'warn';
  if (/joined the game|logged in with entity/.test(line)) return 'join';
  if (/left the game|lost connection/.test(line)) return 'left';
  if (/INFO\]: <[^>]+>|\[Server\]|\[Rcon\]/.test(line)) return 'chat';
  if (/Done \([\d.]+s\)!|For help, type/.test(line)) return 'ok';
  if (/^\[(init|mc-image-helper)\]/.test(line)) return 'init';
  return '';
}

function lineNode(line) {
  const node = el('span', { class: 'ln ' + classify(line) });
  const m = line.match(/^(\[\d{2}:\d{2}:\d{2}\]\s?)(.*)$/);
  let rest = line;
  if (m) { node.append(el('span', { class: 'ts' }, m[1])); rest = m[2]; }
  if (state.filter) {
    const q = state.filter.toLowerCase();
    let i = 0, low = rest.toLowerCase(), j;
    while ((j = low.indexOf(q, i)) !== -1) {
      node.append(rest.slice(i, j), el('mark', {}, rest.slice(j, j + q.length)));
      i = j + q.length;
    }
    node.append(rest.slice(i));
  } else node.append(rest);
  node.append('\n');
  return node;
}
const visible = (line) => !(state.hideNoise && NOISE.test(line)) && (!state.filter || line.toLowerCase().includes(state.filter.toLowerCase()));

function paintConsoles() {
  for (const c of $$('.console')) {
    const lines = state.logs.filter(visible);
    const slice = c.dataset.mini ? lines.slice(-150) : lines;
    c.replaceChildren(...slice.map(lineNode));
    if (!slice.length) c.append(el('span', { class: 'ln', style: 'color:var(--dim)' }, current()?.state === 'running' ? 'Waiting for logs…' : 'Server offline — Start dabao.'));
    c.scrollTop = c.scrollHeight;
  }
}

function pushLog(line) {
  state.logs.push(line);
  if (state.logs.length > MAX_LOGS) state.logs.splice(0, state.logs.length - MAX_LOGS);
  if (!visible(line)) return;
  for (const c of $$('.console')) {
    const placeholder = c.querySelector('.ln[style]');
    if (placeholder) placeholder.remove();
    const nearBottom = c.scrollTop + c.clientHeight >= c.scrollHeight - 40;
    c.append(lineNode(line));
    if (c.dataset.mini && c.childElementCount > 150) c.firstChild.remove();
    if (c.dataset.mini || (state.autoscroll && nearBottom) || (state.autoscroll && /^> /.test(line))) c.scrollTop = c.scrollHeight;
  }
}

function cmdKeys(e) {
  const h = state.cmdHistory;
  if (e.key === 'ArrowUp' && h.length) {
    e.preventDefault();
    state.cmdIdx = Math.min(h.length - 1, state.cmdIdx + 1);
    e.target.value = h[h.length - 1 - state.cmdIdx];
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    state.cmdIdx = Math.max(-1, state.cmdIdx - 1);
    e.target.value = state.cmdIdx < 0 ? '' : h[h.length - 1 - state.cmdIdx];
  }
}
function sendCmd(e) {
  e.preventDefault();
  const input = $('#cmd-input');
  const cmd = input.value.trim();
  if (!cmd) return;
  input.value = '';
  state.cmdHistory.push(cmd);
  state.cmdIdx = -1;
  runCmd(cmd);
}
async function runCmd(cmd, quiet) {
  const s = current();
  if (!s) return;
  pushLog(`> /${cmd.replace(/^\//, '')}`);
  try {
    const { output } = await api(`/api/servers/${s.name}/command`, { method: 'POST', body: { command: cmd } });
    if (output) pushLog(`> ${output}`);
    if (quiet) toast(output || 'Done ✓');
  } catch (err) { pushLog(`> ERROR: ${err.message}`); toast(err.message, true); }
}
function downloadLogs() {
  const blob = new Blob([state.logs.join('\n')], { type: 'text/plain' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `${state.selected}-logs.txt` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- players ---------- */
function renderPlayersTab(s) {
  const list = (str) => (str ? str.split(',').filter(Boolean) : []);
  const chips = (names) => names.length
    ? names.map((n) => el('span', { class: 'pill', style: 'padding:3px 10px 3px 3px' }, el('img', { src: headUrl(n), width: 20, height: 20, style: 'border-radius:3px', onerror: (e) => { e.target.src = headUrl('MHF_Steve'); } }), n))
    : [el('span', { class: 'muted' }, 'Koi nahi')];
  const quickForm = (placeholder, btn, cmdFn) => {
    const input = el('input', { placeholder, maxlength: 16 });
    return el('form', { class: 'inline-form', onsubmit: (e) => { e.preventDefault(); const n = input.value.trim(); if (!n) return; runCmd(cmdFn(n), true); input.value = ''; } },
      input, el('button', { class: 'mc-btn green', type: 'submit' }, btn));
  };
  const grid = el('div', { class: 'players-grid', id: 'players-grid', 'data-key': JSON.stringify(s.players?.names || []) }, playerCards(s));
  return el('div', { style: 'display:grid;gap:14px' },
    el('div', { class: 'card' }, el('div', { class: 'card-title' }, `Online players (${s.players?.online || 0}/${s.maxPlayers})`), grid),
    el('div', { class: 'grid2' },
      el('div', { class: 'card' },
        el('div', { class: 'card-title' }, `📜 Whitelist ${s.whitelistEnabled ? '(ON)' : '(OFF)'}`),
        el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' }, chips(list(s.whitelist))),
        quickForm('Player name', '+ Whitelist', (n) => `whitelist add ${n}`),
        el('p', { class: 'muted', style: 'font-size:12px;margin:8px 0 0' }, 'Permanent list ke liye Settings → Whitelist players mein bhi naam daal do.')),
      el('div', { class: 'card' },
        el('div', { class: 'card-title' }, '👑 Operators (admins)'),
        el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' }, chips(list(s.ops))),
        quickForm('Player name', '+ Make OP', (n) => `op ${n}`),
        quickForm('Player name', 'Unban', (n) => `pardon ${n}`))));
}

function playerCards(s) {
  if (!s.players?.names.length) {
    return [el('div', { class: 'empty-state', style: 'grid-column:1/-1' },
      el('div', { class: 'big-ico' }, s.state === 'running' ? '🌙' : '💤'),
      el('h2', {}, s.state === 'running' ? 'Koi online nahi' : 'Server offline'),
      el('div', {}, s.state === 'running' ? `Dosto ko address bhejo: ${s.address}` : 'Pehle server Start karo'))];
  }
  return s.players.names.map((n) => {
    const act = (label, cmd, danger) => el('button', { class: danger ? 'danger' : '', onclick: () => {
      if (danger) return confirmModal(`${label} ${n}?`, `Kya aap sach mein ${n} ko ${label.toLowerCase()} karna chahte ho?`, label, () => runCmd(cmd, true));
      runCmd(cmd, true);
    } }, label);
    return el('div', { class: 'player' },
      el('img', { src: headUrl(n), alt: n, onerror: (e) => { e.target.src = headUrl('MHF_Steve'); } }),
      el('div', { style: 'min-width:0' },
        el('div', { class: 'pname' }, n),
        el('div', { class: 'acts' },
          act('OP', `op ${n}`), act('De-OP', `deop ${n}`),
          act('Creative', `gamemode creative ${n}`), act('Survival', `gamemode survival ${n}`),
          act('Heal', `effect give ${n} minecraft:instant_health 1 10`),
          act('Kick', `kick ${n}`, true), act('Ban', `ban ${n}`, true))));
  });
}

/* ---------- settings form ---------- */
const FIELDS = [
  { section: '🧱 Basic' },
  { key: 'name', label: 'Server name', type: 'text', hint: 'lowercase, numbers, dashes (e.g. my-smp)', createOnly: true, required: true },
  { key: 'motd', label: 'MOTD (server list message)', type: 'text', full: true },
  { key: 'type', label: 'Server type', type: 'select', enum: 'type', hint: 'PAPER = fast + plugins · VANILLA = original' },
  { key: 'version', label: 'Minecraft version', type: 'text', hint: 'LATEST ya e.g. 1.21.4' },
  { key: 'memory', label: 'RAM', type: 'select', options: ['1G', '1536M', '2G', '3G', '4G', '5G', '6G', '8G', '12G'], hint: 'Machine RAM se kam rakho' },
  { key: 'port', label: 'Port', type: 'number', hint: 'Khaali = auto', createOnly: true },
  { section: '⚔ Gameplay' },
  { key: 'difficulty', label: 'Difficulty', type: 'select', enum: 'difficulty' },
  { key: 'gamemode', label: 'Game mode', type: 'select', enum: 'gamemode' },
  { key: 'maxPlayers', label: 'Max players', type: 'number', min: 1, max: 200 },
  { key: 'viewDistance', label: 'View distance', type: 'number', min: 3, max: 32 },
  { key: 'simulationDistance', label: 'Simulation distance', type: 'number', min: 3, max: 32 },
  { key: 'spawnProtection', label: 'Spawn protection', type: 'number', min: 0, max: 100 },
  { key: 'pvp', label: 'PvP', type: 'check', hint: 'Players ek dusre ko maar sakte hain' },
  { key: 'hardcore', label: 'Hardcore', type: 'check', hint: 'Ek hi life' },
  { key: 'allowFlight', label: 'Allow flight', type: 'check', hint: 'Fly mods par kick nahi' },
  { key: 'commandBlocks', label: 'Command blocks', type: 'check' },
  { section: '🌍 World (sirf naye world par lagta hai)' },
  { key: 'seed', label: 'Seed', type: 'text', hint: 'Khaali = random' },
  { key: 'levelType', label: 'World type', type: 'select', enum: 'levelType' },
  { section: '🔐 Players & Access' },
  { key: 'onlineMode', label: 'Premium accounts only', type: 'check', full: true, hint: 'OFF = TLauncher / cracked / koi bhi naam. ON = sirf paid Microsoft accounts.' },
  { key: 'whitelistEnabled', label: 'Whitelist ON', type: 'check', full: true, hint: 'Sirf list wale players join kar sakte hain' },
  { key: 'whitelist', label: 'Whitelist players', type: 'text', full: true, hint: 'Comma separated: Steve, Alex' },
  { key: 'ops', label: 'Operators (in-game admins)', type: 'text', full: true, hint: 'Comma separated usernames' },
];

function buildForm(values, isCreate) {
  const sections = [];
  let grid = null;
  for (const f of FIELDS) {
    if (f.createOnly && !isCreate) continue;
    if (f.section) {
      grid = el('div', { class: 'form-grid' });
      sections.push(el('div', { class: 'card' }, el('div', { class: 'card-title' }, f.section), grid));
      continue;
    }
    const v = values[f.key];
    let node;
    if (f.type === 'check') {
      node = el('label', { class: 'switch' + (f.full ? ' full' : '') },
        el('span', { class: 'txt' }, f.label, f.hint ? el('small', {}, f.hint) : null),
        el('input', { type: 'checkbox', name: f.key, checked: !!v }), el('span', { class: 'knob' }));
    } else {
      let input;
      if (f.type === 'select') {
        const opts = f.options || state.config.enums[f.enum];
        input = el('select', { name: f.key }, opts.map((o) => el('option', { value: o, selected: o === v }, o.replace('minecraft:', '').replace('_', ' '))));
      } else {
        input = el('input', { type: f.type, name: f.key, value: v ?? '', min: f.min, max: f.max, required: f.required,
          placeholder: f.key === 'port' ? `${state.config.portStart}-${state.config.portEnd}` : f.key === 'name' ? 'my-smp' : '' });
      }
      node = el('label', { class: 'field' + (f.full ? ' full' : '') }, f.label, input, f.hint ? el('span', { class: 'hint' }, f.hint) : null);
    }
    grid.append(node);
  }
  return el('div', { class: 'form-sections' }, sections);
}
function readForm(form) {
  const body = {};
  for (const i of $$('input[name], select[name]', form)) body[i.name] = i.type === 'checkbox' ? i.checked : i.value;
  if (body.port === '') delete body.port;
  return body;
}

function renderSettingsTab(s) {
  const err = el('p', { class: 'error' });
  const btn = el('button', { class: 'mc-btn green', type: 'submit' }, '💾 Save & Apply');
  const form = el('form', { onsubmit: async (e) => {
    e.preventDefault();
    btn.disabled = true; btn.replaceChildren(el('span', { class: 'spin' }), ' Applying…'); err.textContent = '';
    try {
      await api(`/api/servers/${s.name}`, { method: 'PUT', body: readForm(form) });
      toast('✅ Settings saved — server restart ho raha hai');
      await refreshServers();
      openLogStream();
      select(s.name, 'overview');
    } catch (ex) { err.textContent = ex.message; btn.disabled = false; btn.replaceChildren('💾 Save & Apply'); }
  } }, buildForm(s, false),
  el('div', { class: 'form-foot' }, el('span', { class: 'note' }, '⚠ Save karne par server restart hoga (world safe rehta hai).'), btn), err);
  return el('div', { style: 'display:grid;gap:14px' }, form,
    el('div', { class: 'card danger-zone' },
      el('div', {}, el('b', { style: 'color:var(--redstone)' }, '☠ Danger zone'), el('div', { class: 'muted', style: 'font-size:13px' }, 'Server ko hamesha ke liye delete karo')),
      el('button', { class: 'mc-btn red', type: 'button', onclick: () => openDelete(s) }, 'Delete server')));
}

/* ================= modals ================= */
function openModal(content, small) {
  $('#modal-box').className = 'modal-box' + (small ? ' small' : '');
  $('#modal-box').replaceChildren(...content);
  $('#modal').classList.remove('hidden');
}
function closeModal() { $('#modal').classList.add('hidden'); }
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

function confirmModal(title, text, okLabel, onOk) {
  openModal([
    el('h2', {}, title), el('p', { class: 'muted' }, text),
    el('div', { class: 'modal-actions' },
      el('button', { class: 'mc-btn ghost', onclick: closeModal }, 'Cancel'),
      el('button', { class: 'mc-btn red', onclick: () => { closeModal(); onOk(); } }, okLabel)),
  ], true);
}

function openCreate() {
  const err = el('p', { class: 'error' });
  const btn = el('button', { class: 'mc-btn green', type: 'submit' }, '⛏ Create Server');
  const form = el('form', { onsubmit: async (e) => {
    e.preventDefault();
    btn.disabled = true; btn.replaceChildren(el('span', { class: 'spin' }), ' Creating… (1–3 min)'); err.textContent = '';
    try {
      const body = readForm(form);
      const s = await api('/api/servers', { method: 'POST', body });
      closeModal();
      toast(`🎉 ${s.name} create ho gaya! ~1 min mein Online hoga`);
      await refreshServers();
      select(s.name, 'console');
    } catch (ex) { err.textContent = ex.message; btn.disabled = false; btn.replaceChildren('⛏ Create Server'); }
  } },
  el('h2', {}, 'New Server'),
  el('p', { class: 'muted', style: 'margin:0 0 14px' }, 'Settings baad mein bhi badal sakte ho.'),
  buildForm({ ...state.config.defaults, name: '', port: '' }, true),
  err,
  el('div', { class: 'modal-actions' }, el('button', { class: 'mc-btn ghost', type: 'button', onclick: closeModal }, 'Cancel'), btn));
  openModal([form]);
  setTimeout(() => $('input[name=name]', form)?.focus(), 50);
}
$('#new-btn').addEventListener('click', openCreate);

function openDelete(s) {
  const nameInput = el('input', { placeholder: s.name, autocomplete: 'off' });
  const worldBox = el('input', { type: 'checkbox' });
  const err = el('p', { class: 'error' });
  const btn = el('button', { class: 'mc-btn red', type: 'submit' }, 'Delete forever');
  openModal([el('form', { onsubmit: async (e) => {
    e.preventDefault();
    if (nameInput.value !== s.name) { err.textContent = 'Naam match nahi hua'; return; }
    btn.disabled = true; btn.replaceChildren(el('span', { class: 'spin' }), ' Deleting…');
    try {
      await api(`/api/servers/${s.name}?deleteWorld=${worldBox.checked ? 1 : 0}`, { method: 'DELETE' });
      closeModal();
      toast(`🗑 ${s.name} deleted`);
      await refreshServers();
      select(state.servers[0]?.name || null, 'overview');
    } catch (ex) { err.textContent = ex.message; btn.disabled = false; btn.replaceChildren('Delete forever'); }
  } },
  el('h2', {}, `Delete "${s.name}"?`),
  el('p', { class: 'muted' }, 'Confirm karne ke liye server ka naam type karo:'),
  nameInput,
  el('label', { class: 'toggle', style: 'margin-top:12px;color:var(--text)' }, worldBox, 'World data bhi delete karo (wapas nahi aayega!)'),
  err,
  el('div', { class: 'modal-actions' }, el('button', { class: 'mc-btn ghost', type: 'button', onclick: closeModal }, 'Cancel'), btn))], true);
  setTimeout(() => nameInput.focus(), 50);
}

window.addEventListener('hashchange', () => {
  if (!state.config) return;
  const [name, tab] = decodeURIComponent(location.hash.slice(1)).split('/');
  if (state.servers.some((s) => s.name === name)) select(name, tab || 'overview');
});

/* ================= start ================= */
api('/api/me').then((r) => (r.loggedIn ? boot() : showLogin())).catch(showLogin);
