// Regression test for the mineflayer velocity fix in ai-agents/harness/patches/mineflayer+4.39.0.patch.
// Encodes entity_velocity / spawn_entity exactly as a server would (minecraft-protocol serializer), decodes them as
// the client does, feeds them to mineflayer's entities plugin and checks the resulting velocity in blocks/tick.
// 26.1 uses lpVec3 (already blocks/tick); 1.21.6 uses vec3i16 (1/8000 blocks/tick). Unpatched 4.39 divides both by
// 8000, so on 26.1 every knockback became ~0.
//
//   docker run --rm --entrypoint node -v "$PWD/ai-agents/test:/t:ro" craftpanel-ai-agents:latest --test /t/velocity.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(process.env.HARNESS_PACKAGE || '/harness/package.json');
const { createSerializer, createDeserializer } = require('minecraft-protocol');
const minecraftData = require('minecraft-data');
const injectEntities = require('mineflayer/lib/plugins/entities.js');

function roundTrip(version, name, params) {
  const buf = createSerializer({ state: 'play', isServer: true, version }).createPacketBuffer({ name, params });
  return createDeserializer({ state: 'play', isServer: false, version }).parsePacketBuffer(buf).data.params;
}

function fakeBot(version) {
  const bot = new EventEmitter();
  bot._client = new EventEmitter();
  bot._client.username = 'VelocityTest';
  bot.version = version;
  bot.registry = minecraftData(version);
  bot.supportFeature = (f) => bot.registry.supportFeature(f);
  injectEntities(bot);
  bot._client.emit('login', { entityId: 1 });
  return bot;
}

const near = (actual, expected, tol) => {
  for (const k of ['x', 'y', 'z']) assert.ok(Math.abs(actual[k] - expected[k]) <= tol, `${k}: got ${actual[k]}, want ${expected[k]}`);
};
const want = { x: 0.1, y: 0.4, z: -0.2 };

test('26.1 entity_velocity (lpVec3) gives blocks/tick unchanged', () => {
  const bot = fakeBot('26.1');
  const params = roundTrip('26.1', 'entity_velocity', { entityId: 1, velocity: want });
  bot._client.emit('entity_velocity', params);
  near(bot.entity.velocity, want, 1e-3);
});

test('1.21.6 entity_velocity (vec3i16) still divides by 8000', () => {
  const bot = fakeBot('1.21.6');
  const params = roundTrip('1.21.6', 'entity_velocity', { entityId: 1, velocity: { x: 800, y: 3200, z: -1600 } });
  bot._client.emit('entity_velocity', params);
  near(bot.entity.velocity, want, 1e-9);
});

test('legacy flat velocityX/Y/Z fields still work', () => {
  const bot = fakeBot('1.21.6');
  bot._client.emit('entity_velocity', { entityId: 1, velocityX: 800, velocityY: 3200, velocityZ: -1600 });
  near(bot.entity.velocity, want, 1e-9);
});

test('26.1 spawn_entity (lpVec3) gives blocks/tick unchanged', () => {
  const bot = fakeBot('26.1');
  const reg = bot.registry;
  const params = roundTrip('26.1', 'spawn_entity', {
    entityId: 42, objectUUID: '00000000-0000-0000-0000-000000000042', type: reg.entitiesByName.pig.id,
    x: 0, y: 64, z: 0, velocity: want, pitch: 0, yaw: 0, headPitch: 0, objectData: 0,
  });
  let spawned;
  bot.on('entitySpawn', (e) => { spawned = e; });
  bot._client.emit('spawn_entity', params);
  assert.ok(spawned, 'entity spawned');
  near(spawned.velocity, want, 1e-3);
});
