'use strict';
const express = require('express');
const Docker = require('dockerode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------- Config ----------
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const PUBLIC_HOST = process.env.PUBLIC_HOST || 'YOUR-SERVER-IP';
const PORT_START = parseInt(process.env.MC_PORT_START || '25565', 10);
const PORT_END = parseInt(process.env.MC_PORT_END || '25575', 10);
const TZ = process.env.TZ || 'UTC';
const IMAGE = 'itzg/minecraft-server';
const DATA_FILE = path.join(__dirname, 'data', 'servers.json');
// Backups live in the Docker volume "mc-backups", mounted into the panel at /app/backups
// (see docker-compose.yml) and into short-lived helper containers at /backups.
const BACKUP_DIR = path.join(__dirname, 'backups');
const BACKUP_VOLUME = 'mc-backups';
const BACKUP_INTERVAL_H = Math.max(0, parseFloat(process.env.BACKUP_INTERVAL_HOURS ?? '6') || 0); // 0 = auto backups off
const BACKUP_KEEP = Math.min(100, Math.max(1, parseInt(process.env.BACKUP_KEEP || '8', 10) || 8));

if (ADMIN_PASSWORD.length < 8 || ADMIN_PASSWORD === 'change-me-please') {
  console.error('ERROR: set a strong ADMIN_PASSWORD (min 8 chars) in .env');
  process.exit(1);
}

const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const app = express();
app.use(express.json({ limit: '100kb' }));

// ---------- Registry (servers.json) ----------
function loadServers() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return {}; }
}
function saveServers(s) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(s, null, 2));
  fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
}
let servers = loadServers();

// ---------- Auth ----------
const sign = (v) => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('hex');
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();
function makeToken() {
  const exp = String(Date.now() + 7 * 24 * 3600 * 1000);
  return exp + '.' + sign(exp);
}
function validToken(t) {
  if (!t) return false;
  const [exp, sig] = t.split('.');
  if (!exp || !sig) return false;
  const expected = sign(exp);
  if (sig.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  return Number(exp) > Date.now();
}
function getCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
const failed = new Map(); // ip -> {count, until}

app.post('/api/login', (req, res) => {
  const ip = req.socket.remoteAddress;
  const f = failed.get(ip);
  if (f && f.until > Date.now()) return res.status(429).json({ error: 'Too many attempts. Try again in 10 minutes.' });
  const ok = crypto.timingSafeEqual(sha(req.body?.password || ''), sha(ADMIN_PASSWORD));
  if (!ok) {
    const n = (f && f.until <= Date.now() && f.count >= 10 ? 0 : f?.count || 0) + 1;
    failed.set(ip, { count: n, until: n >= 10 ? Date.now() + 10 * 60 * 1000 : 0 });
    return res.status(401).json({ error: 'Wrong password' });
  }
  failed.delete(ip);
  res.setHeader('Set-Cookie', `session=${makeToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 24 * 3600}`);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => res.json({ loggedIn: validToken(getCookie(req, 'session')) }));
app.use('/api', (req, res, next) => {
  if (!validToken(getCookie(req, 'session'))) return res.status(401).json({ error: 'Not logged in' });
  next();
});

// ---------- Settings validation ----------
const DEFAULTS = {
  type: 'PAPER', version: 'LATEST', difficulty: 'normal', gamemode: 'survival',
  maxPlayers: 20, motd: 'A Minecraft Server', onlineMode: false, pvp: true, hardcore: false,
  allowFlight: false, commandBlocks: true, viewDistance: 10, simulationDistance: 10,
  spawnProtection: 16, memory: '2G', seed: '', levelType: 'minecraft:normal',
  whitelistEnabled: false, whitelist: '', ops: '',
};
const ENUMS = {
  type: ['VANILLA', 'PAPER', 'PURPUR', 'FABRIC', 'FORGE'],
  difficulty: ['peaceful', 'easy', 'normal', 'hard'],
  gamemode: ['survival', 'creative', 'adventure', 'spectator'],
  levelType: ['minecraft:normal', 'minecraft:flat', 'minecraft:large_biomes', 'minecraft:amplified'],
};
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const PLAYER_RE = /^[A-Za-z0-9_]{1,16}$/;

class BadRequest extends Error {}
function sanitize(input, base) {
  const s = { ...DEFAULTS, ...base };
  const has = (k) => input[k] !== undefined && input[k] !== null;
  for (const k of Object.keys(ENUMS)) {
    if (has(k)) {
      if (!ENUMS[k].includes(input[k])) throw new BadRequest(`Invalid ${k}`);
      s[k] = input[k];
    }
  }
  const int = (k, min, max) => {
    if (!has(k)) return;
    const n = parseInt(input[k], 10);
    if (Number.isNaN(n) || n < min || n > max) throw new BadRequest(`${k} must be between ${min} and ${max}`);
    s[k] = n;
  };
  int('maxPlayers', 1, 200);
  int('viewDistance', 3, 32);
  int('simulationDistance', 3, 32);
  int('spawnProtection', 0, 100);
  for (const k of ['onlineMode', 'pvp', 'hardcore', 'allowFlight', 'commandBlocks', 'whitelistEnabled']) {
    if (has(k)) s[k] = input[k] === true || input[k] === 'true';
  }
  if (has('version')) {
    const v = String(input.version).trim();
    if (!/^(LATEST|SNAPSHOT|\d+(\.\d+){1,2}([-.\w]{0,20}))$/i.test(v)) throw new BadRequest('Invalid version (e.g. LATEST or 1.21.4)');
    s.version = /^(latest|snapshot)$/i.test(v) ? v.toUpperCase() : v;
  }
  if (has('memory')) {
    const m = String(input.memory).trim().toUpperCase();
    if (!/^(\d{1,2}G|\d{3,5}M)$/.test(m)) throw new BadRequest('Memory must look like 2G or 1536M');
    s.memory = m;
  }
  const clean = (v, max) => String(v).replace(/[\x00-\x1f\x7f]/g, '').slice(0, max).trim();
  if (has('motd')) s.motd = clean(input.motd, 120) || DEFAULTS.motd;
  if (has('seed')) s.seed = clean(input.seed, 64);
  for (const k of ['whitelist', 'ops']) {
    if (!has(k)) continue;
    const names = String(input[k]).split(/[\s,]+/).filter(Boolean);
    for (const n of names) if (!PLAYER_RE.test(n)) throw new BadRequest(`Invalid player name: ${n.slice(0, 20)}`);
    s[k] = names.join(',');
  }
  return s;
}

// itzg image tag depends on the Java version the Minecraft version needs
function imageFor(version) {
  if (/^(LATEST|SNAPSHOT)$/.test(version)) return `${IMAGE}:latest`;
  const [a, b = 0, c = 0] = version.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  if (a > 1) return `${IMAGE}:latest`; // new year-based versions (26.x ...)
  if (b < 17) return `${IMAGE}:java8`;
  if (b < 20 || (b === 20 && c < 5)) return `${IMAGE}:java17`;
  return `${IMAGE}:latest`;
}

function buildEnv(s) {
  const env = {
    EULA: 'TRUE', TZ, TYPE: s.type, VERSION: s.version,
    DIFFICULTY: s.difficulty, MODE: s.gamemode, MAX_PLAYERS: s.maxPlayers, MOTD: s.motd,
    ONLINE_MODE: s.onlineMode, PVP: s.pvp, HARDCORE: s.hardcore, ALLOW_FLIGHT: s.allowFlight,
    ENABLE_COMMAND_BLOCK: s.commandBlocks, VIEW_DISTANCE: s.viewDistance,
    SIMULATION_DISTANCE: s.simulationDistance, SPAWN_PROTECTION: s.spawnProtection,
    MEMORY: s.memory, LEVEL_TYPE: s.levelType,
    ENABLE_WHITELIST: s.whitelistEnabled, ENFORCE_WHITELIST: s.whitelistEnabled,
  };
  if (s.seed) env.SEED = s.seed;
  if (s.whitelist) env.WHITELIST = s.whitelist;
  if (s.ops) env.OPS = s.ops;
  return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}

// ---------- Docker helpers ----------
const cname = (name) => `mc-${name}`;

async function inspect(name) {
  try { return await docker.getContainer(cname(name)).inspect(); } catch (e) {
    if (e.statusCode === 404) return null;
    throw e;
  }
}

async function ensureImage(img) {
  try { await docker.getImage(img).inspect(); return; } catch {}
  console.log('Pulling', img, '...');
  const stream = await docker.pull(img);
  await new Promise((resolve, reject) => docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve())));
}

async function createContainer(s) {
  const img = imageFor(s.version);
  await ensureImage(img);
  const c = await docker.createContainer({
    name: cname(s.name),
    Image: img,
    Env: buildEnv(s),
    Tty: true,
    OpenStdin: true,
    Labels: { mcpanel: '1', 'mcpanel.name': s.name },
    ExposedPorts: { '25565/tcp': {} },
    HostConfig: {
      PortBindings: { '25565/tcp': [{ HostPort: String(s.port) }] },
      Binds: [`mc-${s.name}-data:/data`], // world + config persist in a Docker volume
      RestartPolicy: { Name: 'unless-stopped' }, // 24/7: comes back after crash / reboot
    },
  });
  await c.start();
}

async function removeContainer(name) {
  const info = await inspect(name);
  if (!info) return false;
  const c = docker.getContainer(cname(name));
  if (info.State.Running) await c.stop({ t: 60 }); // graceful stop saves the world
  await c.remove({ force: true });
  return info.State.Running;
}

const stripAnsi = (t) => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');

async function rcon(name, command, timeoutMs = 8000) {
  const exec = await docker.getContainer(cname(name)).exec({
    Cmd: ['rcon-cli', command], AttachStdout: true, AttachStderr: true, Tty: true,
  });
  const stream = await exec.start({ hijack: true, stdin: false, Tty: true });
  return new Promise((resolve, reject) => {
    let out = '';
    const t = setTimeout(() => { stream.destroy(); resolve(stripAnsi(out) || '(no response)'); }, timeoutMs);
    stream.on('data', (d) => (out += d.toString()));
    stream.on('end', () => { clearTimeout(t); resolve(stripAnsi(out).trim()); });
    stream.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

async function status(s) {
  const info = await inspect(s.name);
  const out = { ...s, state: 'missing', health: null, players: null, address: s.port === 25565 ? PUBLIC_HOST : `${PUBLIC_HOST}:${s.port}` };
  if (!info) return out;
  out.state = info.State.Status; // running / exited / restarting ...
  out.health = info.State.Health?.Status || null; // starting / healthy / unhealthy
  out.startedAt = info.State.Running ? info.State.StartedAt : null;
  if (info.State.Running && out.health === 'healthy') {
    try {
      const r = await rcon(s.name, 'list', 3000);
      const m = r.match(/There are (\d+) of a max(?: of)? (\d+) players online:?\s*(.*)/);
      if (m) out.players = { online: +m[1], max: +m[2], names: m[3].split(',').map((x) => x.trim()).filter(Boolean) };
    } catch {}
  }
  return out;
}

// ---------- Backups ----------
// File: backups/<server>/<YYYY-MM-DD_HH-MM-SS>_<reason>.tgz (UTC) + same name .json with a settings snapshot
const REASONS = ['auto', 'manual', 'settings', 'regenerate', 'restore'];
const BACKUP_RE = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})_(\\d{2})-(\\d{2})-(\\d{2})_(${REASONS.join('|')})\\.tgz$`);
const TAR_EXCLUDES = ['./libraries', './versions', './cache', './.cache', './logs', './crash-reports'].map((p) => `--exclude=${p}`);
const WORLD_DIRS = ['/data/world', '/data/world_nether', '/data/world_the_end'];

const stamp = () => new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
const backupDir = (name) => path.join(BACKUP_DIR, name);

function listBackups(name) {
  let files = [];
  try { files = fs.readdirSync(backupDir(name)); } catch { return []; }
  return files.map((f) => f.match(BACKUP_RE) && [f, f.match(BACKUP_RE)]).filter(Boolean).map(([file, m]) => {
    let size = 0;
    try { size = fs.statSync(path.join(backupDir(name), file)).size; } catch {}
    return {
      file, size, reason: m[5],
      createdAt: `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`,
      hasSettings: fs.existsSync(path.join(backupDir(name), file.replace(/\.tgz$/, '.json'))),
    };
  }).sort((a, b) => (a.file < b.file ? 1 : -1)); // newest first
}

function readBackupMeta(name, file) {
  try { return JSON.parse(fs.readFileSync(path.join(backupDir(name), file.replace(/\.tgz$/, '.json')), 'utf8')); } catch { return null; }
}

// Validates a backup file name from the URL and makes sure it exists
function backupFile(name, file) {
  if (!BACKUP_RE.test(String(file))) throw new BadRequest('Invalid backup name');
  if (!fs.existsSync(path.join(backupDir(name), file))) throw new BadRequest('Backup not found');
  return file;
}

function removeBackup(name, file) {
  for (const f of [file, file.replace(/\.tgz$/, '.json')]) fs.rmSync(path.join(backupDir(name), f), { force: true });
}

// Keep the newest BACKUP_KEEP auto backups and BACKUP_KEEP of the other kinds
function pruneBackups(name, protect) {
  const all = listBackups(name);
  for (const group of [all.filter((b) => b.reason === 'auto'), all.filter((b) => b.reason !== 'auto')]) {
    for (const b of group.slice(BACKUP_KEEP)) if (b.file !== protect) removeBackup(name, b.file);
  }
}

// Runs a throwaway container (same image as the server, so nothing extra is pulled) with the given argv
async function runHelper(s, argv, binds, okCodes = [0]) {
  const img = imageFor(s.version);
  await ensureImage(img);
  const c = await docker.createContainer({
    Image: img, Entrypoint: [argv[0]], Cmd: argv.slice(1), User: '0:0',
    Labels: { 'mcpanel.helper': '1', 'mcpanel.name': s.name },
    HostConfig: { Binds: binds, NetworkMode: 'none' },
  });
  try {
    await c.start();
    const r = await c.wait();
    if (!okCodes.includes(r.StatusCode)) {
      const logs = (await c.logs({ stdout: true, stderr: true }).catch(() => Buffer.from(''))).toString('utf8');
      throw new Error(`Helper failed (exit ${r.StatusCode}): ${logs.replace(/[\x00-\x08\x0e-\x1f]/g, '').trim().slice(-300)}`);
    }
  } finally {
    await c.remove({ force: true }).catch(() => {});
  }
}

// Consistent backup: pause world saving on a running server, tar the volume, resume saving
async function backup(s, reason, protect) {
  fs.mkdirSync(backupDir(s.name), { recursive: true });
  const file = `${stamp()}_${reason}.tgz`;
  const partial = path.join(backupDir(s.name), file + '.partial');
  const info = await inspect(s.name);
  const live = !!(info?.State.Running && info.State.Health?.Status === 'healthy');
  if (live) {
    await rcon(s.name, 'save-off', 5000).catch(() => {});
    await rcon(s.name, 'save-all flush', 60000).catch(() => {});
  }
  try {
    // tar exit 1 = "file changed while reading" (archive is still written) -> accepted
    await runHelper(s, ['tar', 'czf', `/backups/${s.name}/${file}.partial`, '-C', '/data', ...TAR_EXCLUDES, '.'],
      [`mc-${s.name}-data:/data:ro`, `${BACKUP_VOLUME}:/backups`], [0, 1]);
    fs.renameSync(partial, path.join(backupDir(s.name), file));
  } catch (e) {
    fs.rmSync(partial, { force: true });
    throw new Error(`Backup failed: ${e.message}`);
  } finally {
    if (live) await rcon(s.name, 'save-on', 5000).catch(() => {});
  }
  fs.writeFileSync(path.join(backupDir(s.name), file.replace(/\.tgz$/, '.json')), JSON.stringify({ reason, settings: s }, null, 2));
  pruneBackups(s.name, protect);
  console.log(`Backup ${s.name}/${file} done`);
  return file;
}

// Deletes the world folders (keeps plugins, ops, whitelist, config) and forgets the old level-seed
const REGEN_SCRIPT = `rm -rf ${WORLD_DIRS.join(' ')} && { [ ! -f /data/server.properties ] || sed -i '/^level-seed=/d' /data/server.properties; }`;
// Wipes /data (except re-downloadable server files) and unpacks the backup given as $1
const RESTORE_SCRIPT = 'find /data -mindepth 1 -maxdepth 1 ! -name libraries ! -name versions ! -name cache -exec rm -rf {} + && tar xzf "$1" -C /data';

// per-server lock so two actions don't race
const busy = new Set();
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof BadRequest) return res.status(400).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
};
function withServer(fn) {
  return wrap(async (req, res) => {
    const s = servers[req.params.name];
    if (!s) return res.status(404).json({ error: 'Server not found' });
    if (busy.has(s.name)) return res.status(409).json({ error: 'Another action is in progress for this server' });
    busy.add(s.name);
    try { await fn(s, req, res); } finally { busy.delete(s.name); }
  });
}

// ---------- API ----------
app.get('/api/config', (req, res) => res.json({ publicHost: PUBLIC_HOST, portStart: PORT_START, portEnd: PORT_END, defaults: DEFAULTS, enums: ENUMS, backup: { intervalHours: BACKUP_INTERVAL_H, keep: BACKUP_KEEP } }));

app.get('/api/servers', wrap(async (req, res) => {
  res.json(await Promise.all(Object.values(servers).map(status)));
}));

app.post('/api/servers', wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim().toLowerCase();
  if (!NAME_RE.test(name)) throw new BadRequest('Name: lowercase letters, numbers and dashes only (max 31)');
  if (servers[name] || busy.has(name)) throw new BadRequest('A server with this name already exists');
  const used = new Set(Object.values(servers).map((s) => s.port));
  let port = req.body.port ? parseInt(req.body.port, 10) : null;
  if (port) {
    if (port < PORT_START || port > PORT_END) throw new BadRequest(`Port must be ${PORT_START}-${PORT_END}`);
    if (used.has(port)) throw new BadRequest('Port already used by another server');
  } else {
    for (let p = PORT_START; p <= PORT_END; p++) if (!used.has(p)) { port = p; break; }
    if (!port) throw new BadRequest('No free port left in the range');
  }
  const s = { ...sanitize(req.body, {}), name, port, createdAt: new Date().toISOString() };
  busy.add(name);
  try {
    await createContainer(s);
    servers[name] = s;
    saveServers(servers);
  } finally { busy.delete(name); }
  res.json(await status(s));
}));

app.put('/api/servers/:name', withServer(async (s, req, res) => {
  const { name, port, createdAt } = s;
  const updated = { ...sanitize(req.body, s), name, port, createdAt };
  const before = { ...DEFAULTS, ...s };
  const changed = Object.keys(updated).some((k) => JSON.stringify(updated[k]) !== JSON.stringify(before[k]));
  if (!changed) return res.json({ ...(await status(s)), unchanged: true }); // nothing to do: no backup, no restart
  await backup(s, 'settings'); // snapshot BEFORE applying new settings; aborts the save if it fails
  const wasRunning = await removeContainer(name);
  servers[name] = updated;
  saveServers(servers);
  await createContainer(updated);
  if (!wasRunning) await docker.getContainer(cname(name)).stop({ t: 60 }).catch(() => {});
  res.json(await status(updated));
}));

app.post('/api/servers/:name/:action(start|stop|restart)', withServer(async (s, req, res) => {
  const info = await inspect(s.name);
  if (!info) await createContainer(s); // container lost? recreate from saved settings
  const c = docker.getContainer(cname(s.name));
  const action = req.params.action;
  if (action === 'start' && info && !info.State.Running) await c.start();
  if (action === 'stop' && (!info || info.State.Running)) await c.stop({ t: 60 });
  if (action === 'restart' && info) await c.restart({ t: 60 });
  res.json(await status(s));
}));

app.delete('/api/servers/:name', withServer(async (s, req, res) => {
  await removeContainer(s.name);
  if (req.query.deleteWorld === '1') {
    await docker.getVolume(`mc-${s.name}-data`).remove().catch(() => {});
  }
  delete servers[s.name];
  saveServers(servers);
  res.json({ ok: true });
}));

app.get('/api/servers/:name/logs', wrap(async (req, res) => {
  const s = servers[req.params.name];
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (!(await inspect(s.name))) return res.json({ logs: '(container not running)' });
  const tail = Math.min(Math.max(parseInt(req.query.tail, 10) || 300, 10), 2000);
  const buf = await docker.getContainer(cname(s.name)).logs({ stdout: true, stderr: true, tail });
  res.json({ logs: stripAnsi(buf.toString('utf8')) });
}));

// Live logs via Server-Sent Events
app.get('/api/servers/:name/logs/stream', wrap(async (req, res) => {
  const s = servers[req.params.name];
  if (!s) return res.status(404).json({ error: 'Server not found' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('event: reset\ndata: {}\n\n');
  if (!(await inspect(s.name))) { res.write('retry: 5000\n\n'); return res.end(); }
  const stream = await docker.getContainer(cname(s.name)).logs({ follow: true, stdout: true, stderr: true, tail: 500 });
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) { const t = stripAnsi(l); if (t.trim()) res.write(`data: ${JSON.stringify(t)}\n\n`); }
  });
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  const done = () => { clearInterval(ping); stream.destroy?.(); };
  stream.on('end', () => { done(); res.write('retry: 3000\n\n'); res.end(); }); // container stopped/restarted -> client reconnects
  stream.on('error', () => { done(); res.end(); });
  req.on('close', done);
}));

// CPU / RAM of one server container
app.get('/api/servers/:name/stats', wrap(async (req, res) => {
  const s = servers[req.params.name];
  if (!s) return res.status(404).json({ error: 'Server not found' });
  const info = await inspect(s.name);
  if (!info?.State.Running) return res.json({ running: false });
  const st = await docker.getContainer(cname(s.name)).stats({ stream: false });
  const cpuDelta = st.cpu_stats.cpu_usage.total_usage - (st.precpu_stats.cpu_usage?.total_usage || 0);
  const sysDelta = (st.cpu_stats.system_cpu_usage || 0) - (st.precpu_stats.system_cpu_usage || 0);
  const cpus = st.cpu_stats.online_cpus || os.cpus().length;
  const cpu = sysDelta > 0 ? (cpuDelta / sysDelta) * cpus * 100 : 0;
  const mem = (st.memory_stats.usage || 0) - (st.memory_stats.stats?.inactive_file || 0);
  res.json({ running: true, cpu: Math.round(cpu * 10) / 10, cpuMax: cpus * 100, mem, memLimit: os.totalmem() });
}));

// Whole machine (EC2) stats
app.get('/api/host', wrap(async (req, res) => {
  let disk = null;
  try { const d = await fs.promises.statfs(path.dirname(DATA_FILE)); disk = { total: d.blocks * d.bsize, free: d.bavail * d.bsize }; } catch {}
  res.json({ cpus: os.cpus().length, load: os.loadavg()[0], memTotal: os.totalmem(), memFree: os.freemem(), uptime: os.uptime(), disk });
}));

app.post('/api/servers/:name/command', wrap(async (req, res) => {
  const s = servers[req.params.name];
  if (!s) return res.status(404).json({ error: 'Server not found' });
  const cmd = String(req.body?.command || '').replace(/^\//, '').replace(/[\x00-\x1f]/g, '').trim().slice(0, 500);
  if (!cmd) throw new BadRequest('Empty command');
  const info = await inspect(s.name);
  if (!info?.State.Running) throw new BadRequest('Server is not running');
  res.json({ output: await rcon(s.name, cmd) });
}));

// ---------- World regenerate / backups ----------
app.post('/api/servers/:name/regenerate', withServer(async (s, req, res) => {
  const { name, port, createdAt } = s;
  const input = { seed: req.body?.seed ?? '' };
  if (req.body?.levelType) input.levelType = req.body.levelType;
  const updated = { ...sanitize(input, s), name, port, createdAt };
  await backup(s, 'regenerate'); // old world is kept as a backup
  await removeContainer(name);
  await runHelper(s, ['sh', '-c', REGEN_SCRIPT], [`mc-${name}-data:/data`]);
  servers[name] = updated;
  saveServers(servers);
  await createContainer(updated); // starts and generates a fresh world
  res.json(await status(updated));
}));

app.get('/api/servers/:name/backups', wrap(async (req, res) => {
  const s = servers[req.params.name];
  if (!s) return res.status(404).json({ error: 'Server not found' });
  res.json({ backups: listBackups(s.name), intervalHours: BACKUP_INTERVAL_H, keep: BACKUP_KEEP });
}));

app.post('/api/servers/:name/backups', withServer(async (s, req, res) => {
  res.json({ file: await backup(s, 'manual') });
}));

app.post('/api/servers/:name/backups/:file/restore', withServer(async (s, req, res) => {
  const file = backupFile(s.name, req.params.file);
  const meta = readBackupMeta(s.name, file);
  await backup(s, 'restore', file); // safety copy of the current world; never prunes the one being restored
  const { name, port, createdAt } = s;
  let next = s;
  if (req.body?.restoreSettings && meta?.settings) next = { ...sanitize(meta.settings, s), name, port, createdAt };
  const wasRunning = await removeContainer(name);
  await runHelper(s, ['sh', '-c', RESTORE_SCRIPT, 'sh', `/backups/${name}/${file}`],
    [`mc-${name}-data:/data`, `${BACKUP_VOLUME}:/backups:ro`]);
  servers[name] = next;
  saveServers(servers);
  await createContainer(next);
  if (!wasRunning) await docker.getContainer(cname(name)).stop({ t: 60 }).catch(() => {});
  res.json(await status(next));
}));

app.get('/api/servers/:name/backups/:file/download', wrap(async (req, res) => {
  const s = servers[req.params.name];
  if (!s) return res.status(404).json({ error: 'Server not found' });
  const file = backupFile(s.name, req.params.file);
  res.download(path.join(backupDir(s.name), file), `${s.name}_${file}`);
}));

app.delete('/api/servers/:name/backups/:file', withServer(async (s, req, res) => {
  removeBackup(s.name, backupFile(s.name, req.params.file));
  res.json({ ok: true });
}));

// ---------- Auto backup scheduler ----------
let ticking = false;
async function autoBackupTick() {
  if (!BACKUP_INTERVAL_H || ticking) return;
  ticking = true;
  try {
    for (const s of Object.values(servers)) {
      if (busy.has(s.name)) continue;
      const info = await inspect(s.name).catch(() => null);
      if (!info?.State.Running) continue; // stopped worlds don't change
      const last = listBackups(s.name)[0];
      if (last && Date.now() - new Date(last.createdAt).getTime() < BACKUP_INTERVAL_H * 3600e3) continue;
      try {
        const d = await fs.promises.statfs(BACKUP_DIR);
        if (d.bavail * d.bsize < 2 * 1024 ** 3) { console.warn('Auto backup skipped: less than 2 GB disk free'); continue; }
      } catch {}
      if (!servers[s.name] || busy.has(s.name)) continue;
      busy.add(s.name);
      try { await backup(s, 'auto'); } catch (e) { console.error(`Auto backup ${s.name}:`, e.message); } finally { busy.delete(s.name); }
    }
  } finally { ticking = false; }
}

app.use(express.static(path.join(__dirname, 'public')));

fs.mkdirSync(BACKUP_DIR, { recursive: true });
// remove helper containers left behind if the panel was killed mid-backup
docker.listContainers({ all: true, filters: { label: ['mcpanel.helper=1'] } })
  .then((list) => Promise.all(list.map((c) => docker.getContainer(c.Id).remove({ force: true }).catch(() => {}))))
  .catch(() => {});
setTimeout(autoBackupTick, 60 * 1000);
setInterval(autoBackupTick, 10 * 60 * 1000);

app.listen(8080, () => console.log(`Minecraft panel running on :8080 (auto backup: ${BACKUP_INTERVAL_H ? `every ${BACKUP_INTERVAL_H}h, keep ${BACKUP_KEEP}` : 'off'})`));
