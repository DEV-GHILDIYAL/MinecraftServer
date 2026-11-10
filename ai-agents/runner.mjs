// Entry point of the CraftPanel AI agents container.
// 1. Runs a tiny rate-limit gate on 127.0.0.1 that every agent process asks before each model request
//    (requests per minute + daily cap, shared by all agents because they share one API key).
// 2. Writes the harness config from AI_CONFIG (JSON set by the panel) and starts the harness.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DATA = process.env.AGENT_STATE_DIR || '/data';
const HARNESS = process.env.HARNESS_BIN || '/harness/bin/minecraft-agent.js';
const log = (msg) => process.stdout.write(`[gate] ${msg}\n`);

let cfg;
try { cfg = JSON.parse(process.env.AI_CONFIG || ''); } catch { console.error('[gate] AI_CONFIG missing or invalid'); process.exit(2); }
const RPM = Math.min(Math.max(Number(cfg.rpm) || 10, 1), 1000);
const DAILY_CAP = Math.max(0, Number(cfg.dailyCap) || 0); // 0 = no cap

// ---------- gate ----------
// Free-tier daily quotas reset at midnight Pacific time.
function pacificNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, secs: +p.hour * 3600 + +p.minute * 60 + +p.second };
}
const msToReset = () => (86400 - pacificNow().secs) * 1000 + 60000;

const STATE_FILE = path.join(DATA, 'gate.json');
let st = { day: pacificNow().day, count: 0, blockedUntil: 0, lastBlock: '' };
try { st = { ...st, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch {}
st.fatal = ''; // a new start (new config / key) clears the previous fatal error
let nextSlot = 0;
function save() {
  const out = { ...st, rpm: RPM, dailyCap: DAILY_CAP, updatedAt: new Date().toISOString() };
  try { fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(out)); fs.renameSync(STATE_FILE + '.tmp', STATE_FILE); } catch {}
}
function rollDay() {
  const day = pacificNow().day;
  if (day !== st.day) { st.day = day; st.count = 0; if (st.lastBlock === 'daily') { st.blockedUntil = 0; st.lastBlock = ''; } save(); }
}

function acquire() {
  rollDay();
  const now = Date.now();
  if (st.blockedUntil > now) return { wait: st.blockedUntil - now };
  if (DAILY_CAP && st.count >= DAILY_CAP) {
    st.blockedUntil = now + msToReset(); st.lastBlock = 'daily'; save();
    log(`daily cap of ${DAILY_CAP} requests reached; agents pause until ${new Date(st.blockedUntil).toISOString()}`);
    return { wait: st.blockedUntil - now };
  }
  if (nextSlot > now) return { wait: nextSlot - now };
  nextSlot = now + Math.ceil(60000 / RPM);
  st.count++;
  if (st.count % 25 === 0) save();
  return { ok: true };
}

function report({ daily, waitMs }) {
  const now = Date.now();
  const until = daily ? now + msToReset() : now + (Number(waitMs) || 30000);
  if (until > st.blockedUntil) {
    st.blockedUntil = until;
    st.lastBlock = daily ? 'daily' : 'rate';
    save();
    log(daily
      ? `API daily quota used up; agents pause until ${new Date(until).toISOString()}`
      : `API rate limited; pausing ${Math.round((until - now) / 1000)}s`);
  }
  return { ok: true };
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 10000) req.destroy(); });
  req.on('end', () => {
    let out = { error: 'not found' };
    try {
      if (req.method === 'POST' && req.url === '/acquire') out = acquire();
      else if (req.method === 'POST' && req.url === '/report') out = report(JSON.parse(body || '{}'));
    } catch { out = { wait: 5000 }; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  });
});

// ---------- harness config ----------
function harnessConfig() {
  const common = {
    host: cfg.host, port: cfg.port, auth: 'offline', minecraftVersion: cfg.mcVersion,
    model: cfg.model, thinking: cfg.thinking || 'low', gameMode: 'survival',
    sandbox: 'none', respawn: true, reconnect: true, allowFlight: false, quiet: false,
    stateDir: DATA,
  };
  const agents = cfg.agents.map((a) => ({
    name: a.name,
    ...(a.personality ? { personality: a.personality } : {}),
    objective: cfg.objective.replaceAll('{peers}', cfg.agents.filter((b) => b.name !== a.name).map((b) => b.name).join(', ') || 'nobody yet'),
  }));
  if (agents.length === 1) {
    const file = path.join(DATA, 'agent.json');
    fs.writeFileSync(file, JSON.stringify({ ...common, ...agents[0] }, null, 2), { mode: 0o600 });
    return ['run', '--config', file];
  }
  const file = path.join(DATA, 'team.json');
  // No shared machine: agents coordinate through DMs and their own private notes, and never get a shell.
  fs.writeFileSync(file, JSON.stringify({ ...common, sharedMachine: 'none', staggerSeconds: 15, agents }, null, 2), { mode: 0o600 });
  return ['team', file];
}

// ---------- DM feed ----------
// The harness keeps agent-to-agent DMs in SQLite (team mode). Print new ones in full so the panel can show the
// conversation ("[dm] Aarav → Meera: ..."). Read-only use: SELECT only, the cursor lives in our own file.
const MAILBOX = path.join(DATA, 'shared', 'mailbox.sqlite');
const CURSOR_FILE = path.join(DATA, 'dm-cursor.json');
let dmDb = null;
let dmCursor = 0;
try { dmCursor = JSON.parse(fs.readFileSync(CURSOR_FILE, 'utf8')).id || 0; } catch {}
async function pollDms() {
  try {
    if (!dmDb) {
      if (!fs.existsSync(MAILBOX)) return;
      const { DatabaseSync } = await import('node:sqlite');
      dmDb = new DatabaseSync(MAILBOX);
      dmDb.exec('PRAGMA busy_timeout = 2000');
    }
    const rows = dmDb.prepare('SELECT id, sender, recipient, text FROM mailbox_dm WHERE id > ? ORDER BY id LIMIT 100').all(dmCursor);
    for (const r of rows) {
      process.stdout.write(`[dm] ${r.sender} → ${r.recipient}: ${String(r.text).replace(/\s*[\r\n]+\s*/g, ' ⏎ ').slice(0, 2000)}\n`);
      dmCursor = r.id;
    }
    if (rows.length) fs.writeFileSync(CURSOR_FILE, JSON.stringify({ id: dmCursor }));
  } catch {
    try { dmDb?.close(); } catch {}
    dmDb = null;
  }
}

server.listen(0, '127.0.0.1', () => {
  if (cfg.agents.length > 1) setInterval(pollDms, 3000);
  const { port } = server.address();
  save();
  log(`listening; limit ${RPM} requests/min${DAILY_CAP ? `, ${DAILY_CAP}/day` : ''}; used today: ${st.count}`);
  const args = harnessConfig();
  const child = spawn(process.execPath, [HARNESS, ...args], {
    cwd: DATA, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AI_GATE_URL: `http://127.0.0.1:${port}`, AI_CONFIG: '' },
  });
  // Forward harness output line by line and watch for errors that a restart can't fix (bad key, unknown model).
  let fatal = '';
  const watch = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) {
        out.write(l + '\n');
        if (/stopping \(model_error\)/.test(l)) {
          if (/API.?key.{0,20}(not valid|invalid)|API_KEY_INVALID|\b401\b|\b403\b|PERMISSION_DENIED|unauthori[sz]ed|no api key/i.test(l)) fatal = 'API key galat hai (invalid). AI tab mein sahi key daal ke Save karo.';
          else if (/model_not_found|not_found|does not exist|is not found/i.test(l)) fatal = 'Model nahi mila. AI tab mein model ka naam check karo.';
        }
      }
    });
  };
  watch(child.stdout, process.stdout);
  watch(child.stderr, process.stderr);
  let stopping = false;
  const stop = () => { stopping = true; child.kill('SIGTERM'); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  child.on('exit', (code, sig) => {
    log(`harness exited (${sig || code})`);
    if (fatal && !stopping) {
      // Don't exit: Docker would restart us and the agents would rejoin and fail again in a loop.
      st.fatal = fatal;
      save();
      log(`STOPPED: ${fatal}`);
      process.removeAllListeners('SIGTERM');
      process.on('SIGTERM', () => process.exit(0));
      return;
    }
    save();
    process.exit(code ?? 0);
  });
});
