// Scripted stand-in for an LLM, for live-testing the harness against a real Minecraft server without an API key.
// Speaks the OpenAI Chat Completions streaming API (pi provider api "openai-completions", see models.fake.json).
// Every agent walks through STEPS in order; each step may look at earlier tool results. Each request and tool
// result is logged as one JSON line on stdout so a test run can be checked afterwards.
//
//   node fake-model.mjs [port]      (default 18080)
import http from 'node:http';
import fs from 'node:fs';

const PORT = Number(process.argv[2] || 18080);
const log = (o) => process.stdout.write(JSON.stringify({ t: new Date().toISOString().slice(11, 19), ...o }) + '\n');

// ---------- helpers over the conversation ----------
const text = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p.text ?? '').join('') : '');
const toolResults = (messages) => messages.filter((m) => m.role === 'tool').map((m) => text(m.content));
const lastResult = (messages) => toolResults(messages).at(-1) ?? '';
function agentName(messages) {
  const sys = messages.filter((m) => m.role === 'system' || m.role === 'developer').map((m) => text(m.content)).join('\n');
  return /(?:You are|your name is|username(?: is)?:?)\s*"?([A-Za-z0-9_]{3,16})/i.exec(sys)?.[1] ?? 'agent';
}
// Own position from the most recent observation that has one
function myPos(messages) {
  for (const r of toolResults(messages).reverse()) {
    const m = /"position"\s*:\s*\{\s*"x"\s*:\s*(-?[\d.]+)\s*,\s*"y"\s*:\s*(-?[\d.]+)\s*,\s*"z"\s*:\s*(-?[\d.]+)/.exec(r)
      || /"pos(?:ition)?"\s*:\s*\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)/.exec(r);
    if (m) return { x: Math.floor(+m[1]), y: Math.floor(+m[2]), z: Math.floor(+m[3]) };
  }
  return null;
}

// ---------- the script ----------
// Items are given by the test runner over RCON before the agents start (see run-live-test.sh).
const STEPS = [
  () => ['observe_world', {}],
  () => ['inventory', {}],
  () => ['craft', { item: 'oak_planks', count: 16 }], // 2 for sticks + 4 for the crafting table + 3 for the pickaxe
  () => ['craft', { item: 'stick', count: 4 }],
  () => ['craft', { item: 'wooden_pickaxe', count: 1 }],
  () => ['equip', { item: 'wooden_pickaxe' }],
  () => ['gather', { block: 'dirt', count: 3 }],
  (msgs) => { const p = myPos(msgs); return ['place', { block: 'dirt', x: p.x + 2, y: p.y, z: p.z }]; },
  (msgs) => { const p = myPos(msgs); return ['break_block', { x: p.x + 2, y: p.y, z: p.z }]; },
  () => ['eat', { item: 'bread' }],
  (msgs) => { const p = myPos(msgs); return ['place', { block: 'chest', x: p.x, y: p.y, z: p.z + 2 }]; },
  () => ['deposit', { item: 'dirt' }],
  () => ['withdraw', { item: 'dirt', count: 1 }],
  (msgs) => { const p = myPos(msgs); return ['go_to', { x: p.x + 6, y: p.y, z: p.z + 6 }]; },
  (msgs, me, peers) => (peers.length ? ['send_dm', { to: peers[0], text: `Hi ${peers[0]}, I am ${me}. Rule 1: share iron. Rule 2: build 150 blocks from spawn.` }] : ['observe_world', {}]),
  (msgs, me, peers) => (peers.length ? ['read_dms', { after: -1 }] : ['observe_world', {}]),
  () => ['observe_world', {}],
];

let schemasWritten = false;
const done = new Set();

function reply(res, model, { tool, args, content }) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const base = { id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model };
  const send = (o) => res.write(`data: ${JSON.stringify({ ...base, ...o })}\n\n`);
  if (tool) {
    send({ choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] }, finish_reason: null }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
  } else {
    send({ choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) { res.writeHead(404); return res.end(); }
    let j;
    try { j = JSON.parse(body); } catch { res.writeHead(400); return res.end(); }
    const msgs = j.messages ?? [];
    const toolNames = (j.tools ?? []).map((t) => t.function?.name);
    if (!schemasWritten && j.tools) { fs.writeFileSync('tool-schemas.json', JSON.stringify(j.tools, null, 1)); schemasWritten = true; }
    const me = agentName(msgs);
    const sys = msgs.filter((m) => m.role === 'system' || m.role === 'developer').map((m) => text(m.content)).join('\n');
    const peers = ['Aarav', 'Meera', 'Kabir', 'Tester1', 'Tester2'].filter((n) => n !== me && sys.includes(n));
    const step = msgs.filter((m) => m.role === 'assistant' && m.tool_calls?.length).length;
    const prev = lastResult(msgs);
    if (step > 0) log({ agent: me, step: step - 1, result: prev.replace(/\s+/g, ' ').slice(0, 700) });
    if (step >= STEPS.length) {
      if (!done.has(me)) { done.add(me); log({ agent: me, event: 'script_finished' }); }
      await new Promise((r) => setTimeout(r, 30000)); // idle politely; the harness will ask again
      return reply(res, j.model, { tool: 'observe_world', args: {} });
    }
    if (step === 1) await new Promise((r) => setTimeout(r, 12000)); // let the test runner /give items after spawn
    let tool, args;
    try { [tool, args] = STEPS[step](msgs, me, peers); } catch (e) { tool = 'observe_world'; args = {}; log({ agent: me, step, event: 'step_error', error: e.message }); }
    if (!toolNames.includes(tool)) log({ agent: me, step, event: 'unknown_tool', tool, available: toolNames });
    log({ agent: me, step, call: tool, args });
    reply(res, j.model, { tool, args });
  });
}).listen(PORT, () => log({ event: 'listening', port: PORT }));
