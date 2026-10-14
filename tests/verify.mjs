// Dependency-free checks; no Chrome instance or network access is used.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { webcrypto, createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import assert from 'node:assert/strict';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = name => readFileSync(resolve(root, name), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function context(state, mode = 'global') {
  const window = {};
  let element = null;
  if (mode === 'global') window.__RF_STORE__ = { getState: () => state };
  if (mode !== 'global' && mode !== 'missing') {
    const fiber = { memoizedState: null, memoizedProps: null, return: null };
    if (mode === 'hook') fiber.memoizedState = { queue: { value: state }, next: null };
    if (mode === 'base') fiber.memoizedState = { baseState: { getState: () => state }, next: null };
    if (mode === 'props') fiber.memoizedProps = state;
    element = { __reactFiberTest: { return: fiber } };
  }
  const ctx = createContext({ window, document: { title: 'Test board - Weavy', querySelector: () => element },
    location: { pathname: '/board/board-1', href: 'https://app.weavy.ai/board/board-1' },
    URL, TextEncoder, Blob, Uint8Array, AbortSignal, crypto: webcrypto,
    fetch: () => { throw new Error('Unexpected network request'); } });
  for (const name of ['extractor.js', 'zip.js', 'archive.js']) runInContext(read(name), ctx);
  ctx.makeZip = window.makeZip;
  return ctx;
}
function state() {
  const shared = { strength: 0.7 };
  const data = { prompt: 'A shot, with "quotes"\nand a newline', model: 'test-model',
    params: { seed: 0, steps: 30, custom: shared, repeated: shared, generate_audio: false },
    created_at: '2026-10-01T12:00:00Z',
    imagePath: 'https://media.weavy.ai/image/upload/a.png',
    generations: [{ uri: 'https://media.weavy.ai/video/upload/b.mp4?token=a(b)[c]' }],
    thumbnail: 'https://media.weavy.ai/image/upload/a-thumb',
    external: 'https://other.example/output.wav' };
  return { nodes: [{ id: 'node/1', type: 'model', data }, { id: 'node?1', type: 'prompt', data: { prompt: '=1+1' } }],
    edges: [{ id: 'edge1', source: 'node?1', target: 'node/1', data: { type: 'prompt', custom: 42 } }] };
}
// Read the generated archive independently, checking every CRC and central offset.
async function unzip(blob) {
  const data = Buffer.from(await blob.arrayBuffer());
  const end = data.length - 22;
  assert.equal(data.readUInt32LE(end), 0x06054b50);
  const count = data.readUInt16LE(end + 10);
  let pos = data.readUInt32LE(end + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(data.readUInt32LE(pos), 0x02014b50);
    const size = data.readUInt32LE(pos + 24);
    const length = data.readUInt16LE(pos + 28);
    const offset = data.readUInt32LE(pos + 42);
    const name = data.subarray(pos + 46, pos + 46 + length).toString('utf8');
    assert.equal(data.readUInt32LE(offset), 0x04034b50);
    const start = offset + 30 + data.readUInt16LE(offset + 26) + data.readUInt16LE(offset + 28);
    const bytes = data.subarray(start, start + size);
    assert.equal(crc32(bytes), data.readUInt32LE(pos + 16));
    assert(!files.has(name), 'duplicate ZIP entry');
    files.set(name, bytes);
    pos += 46 + length + data.readUInt16LE(pos + 30) + data.readUInt16LE(pos + 32);
  }
  assert.equal(pos, end);
  return files;
}
function extracted(ctx) {
  const board = ctx.extractWeavyBoardInPage();
  assert(!board.error, board.error);
  return board;
}

for (const mode of ['global', 'hook', 'base', 'props']) {
  test(`extracts graph through ${mode} store access`, () => {
    const input = state();
    const board = extracted(context(input, mode));
    assert.equal(board.nodes.length, 2);
    assert.equal(board.edges.length, 1);
    assert.equal(board.boardTitle, 'Test board');
    assert.equal(board.nodes[0].seed, 0);
    assert.equal(board.nodes[0].params.steps, 30);
    assert.equal(board.nodes[0].params.generate_audio, false);
    assert.deepEqual(plain(board.nodes[0].raw), input.nodes[0]);
    assert.deepEqual(plain(board.edges[0].raw), input.edges[0]);
    assert.equal(board.nodes[0].timestamps.created_at, input.nodes[0].data.created_at);
    assert(board.nodes[0].assetUrls.includes(input.nodes[0].data.generations[0].uri));
  });
}

test('preserves source error and manual reload/retry behaviour', () => {
  const input = { nodes: [], edges: [] };
  const ctx = context(input);
  assert.match(ctx.extractWeavyBoardInPage().error, /zero nodes/);
  input.nodes = state().nodes;
  assert.match(ctx.extractWeavyBoardInPage().error, /zero edges/);
  input.edges = state().edges;
  assert.equal(extracted(ctx).nodes.length, 2);
  assert.match(context(null, 'missing').extractWeavyBoardInPage().error, /Could not locate/);
});

test('runtime cycles are diagnosed and repeated objects are preserved', () => {
  const input = state();
  input.nodes[0].data.self = input.nodes[0].data;
  input.nodes[0].data.callback = () => {};
  const board = extracted(context(input));
  assert.equal(board.nodes[0].raw.data.self, '[Circular]');
  assert(board.serializationWarnings.some(item => item.includes('circular')));
  assert(board.serializationWarnings.some(item => item.includes('callback')));
  assert.equal(board.nodes[0].params.repeated.strength, 0.7);
});

test('media ZIP contains exact bytes, hashes, JSON, CSV, and failure records', async () => {
  const input = state();
  // Force safe-filename collisions across nodes.
  input.nodes[1].data.imagePath = input.nodes[0].data.imagePath;
  const ctx = context(input);
  const board = extracted(ctx);
  const calls = [];
  const bytes = new Uint8Array([0, 1, 2, 255]);
  const result = await ctx.buildArchive(board, true, () => {}, async (url, options) => {
    calls.push(url);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    if (url.endsWith('a-thumb')) return new Response('Unavailable', { status: 403 });
    return new Response(bytes, { headers: { 'content-type': url.includes('video') ? 'video/mp4' : 'image/png' } });
  });
  const files = await unzip(result.blob);
  assert.equal(calls.length, 4);
  assert.equal(result.summary.downloaded, 3);
  assert.equal(result.summary.failed, 1);
  assert.equal(result.summary.skipped, 1);
  const json = JSON.parse(files.get('Test_board.json'));
  assert.equal(files.size, 5);
  for (const node of json.nodes) for (const asset of node.assets) {
    if (asset.status !== 'downloaded') continue;
    assert.deepEqual(files.get(asset.file), Buffer.from(bytes));
    assert.equal(asset.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert(!asset.file.includes('..'));
  }
  assert.equal(json.nodes[0].assets.find(a => a.status === 'failed').error, 'HTTP 403');
  const csv = files.get('manifest.csv').toString();
  assert(csv.includes('output_file'));
  assert(csv.includes('""quotes""'));
  assert(csv.includes("'=1+1"));
  assert(csv.includes('[""node?1""]'));
});

test('metadata-only ZIP never fetches media', async () => {
  const ctx = context(state());
  const board = extracted(ctx);
  const result = await ctx.buildArchive(board, false);
  const files = await unzip(result.blob);
  assert.equal(files.size, 2);
  assert.equal(result.summary.downloaded, 0);
  assert.equal(result.summary.skipped, result.summary.referenced);
});

test('host allowlist, response validation, and classic ZIP limits', async () => {
  const ctx = context(state());
  for (const url of ['http://media.weavy.ai/a', 'https://media.weavy.ai.evil/a',
    'https://media.weavy.ai:444/a', 'https://user:pass@media.weavy.ai/a']) assert(!ctx.allowedMediaUrl(url));
  assert(ctx.allowedMediaUrl('https://media.weavy.ai/a?token=x'));
  assert.throws(() => ctx.checkZipLimits(Array(65536).fill({ name: 'x', data: [] })), /entry limit/);
  assert.throws(() => ctx.checkZipLimits([{ name: 'x', data: { length: 0xffffffff } }]), /file limit/);
  const result = await ctx.buildArchive(extracted(ctx), true, () => {}, async () =>
    new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }));
  assert.equal(result.summary.downloaded, 0);
  assert.equal(result.summary.failed, 3);
});

test('manifest is MV3 and has only the required Weavy hosts', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.host_permissions, ['https://app.weavy.ai/*', 'https://media.weavy.ai/*']);
  assert.deepEqual(manifest.permissions, ['scripting', 'downloads']);
  for (const path of ['popup.html', 'popup.css', 'extractor.js', 'archive.js', 'zip.js', 'popup.js']) assert(read(path));
});

test('popup restores controls after extraction failure and supports a second click', async () => {
  const ctx = context(state());
  const controls = Object.fromEntries(['harvest', 'media', 'status'].map(id => [id, { dataset: {}, checked: false }]));
  let click;
  controls.harvest.addEventListener = (_, fn) => { click = fn; };
  ctx.document.getElementById = id => controls[id];
  let attempt = 0;
  ctx.chrome = { tabs: { query: async () => [{ id: 7, url: 'https://app.weavy.ai/board/1' }] },
    scripting: { executeScript: async options => {
      assert.equal(options.world, 'MAIN');
      return [{ result: ++attempt === 1 ? { error: 'Not loaded' } : extracted(ctx) }];
    } }, downloads: { download: async options => { assert(options.filename.endsWith('.zip')); return 1; } } };
  runInContext(read('popup.js'), ctx);
  await click();
  assert.match(controls.status.textContent, /Not loaded/);
  assert.equal(controls.harvest.disabled, false);
  await click();
  assert.match(controls.status.textContent, /ZIP handed to Chrome/);
  assert.equal(controls.media.disabled, false);
});

if (process.env.WEAVY_REFERENCE) {
  test('mounted reference board retains every node, edge, and media reference', async () => {
    const original = JSON.parse(readFileSync(process.env.WEAVY_REFERENCE, 'utf8'));
    const ctx = context(original);
    const board = extracted(ctx);
    assert.equal(board.nodes.length, original.nodes.length);
    assert.equal(board.edges.length, original.edges.length);
    for (let i = 0; i < original.nodes.length; i++) {
      assert.deepEqual(plain(board.nodes[i].raw), original.nodes[i]);
      for (const url of ctx.nodeAssetUrls(original.nodes[i])) assert(ctx.nodeAssetUrls(board.nodes[i]).includes(url));
    }
    const result = await ctx.buildArchive(board, true, () => {}, async () =>
      new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'application/octet-stream' } }));
    const files = await unzip(result.blob);
    assert.equal(files.size, result.summary.downloaded + 2);
    assert.equal(result.summary.failed, 0);
    console.log(`Reference: ${board.nodes.length} nodes, ${board.edges.length} edges, ${result.summary.downloaded} mocked media fetches`);
  });
}
