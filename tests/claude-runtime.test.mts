import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { archiveName, digest, readZip } from '../scripts/release.mts';
import { publishClaudeRuntime, validateClaudeRuntime, type GitApi } from '../scripts/claude-runtime.mts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const TAG = `v${JSON.parse(readFileSync(join(ROOT, 'plugin.json'), 'utf8')).version}`;
const VERSION = TAG.slice(1), COMMIT = 'a'.repeat(40), REF = 'refs/heads/claude';
const PREFIX = 'repos/budna-marketplace/plugins/git';
const base = mkdtempSync(join(tmpdir(), 'budna-claude-runtime-source-'));
after(() => rmSync(base, { recursive: true, force: true }));
execFileSync(process.execPath, [join(ROOT, 'scripts/release.mts'), 'build', '--tag', TAG, '--out', base], { stdio: 'pipe' });
const RELEASED = readZip(readFileSync(join(base, archiveName(TAG, 'claude'))));
const gitSha = (bytes: Buffer) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const hash = (value: unknown) => createHash('sha1').update(JSON.stringify(value)).digest('hex');
function version(files: Map<string, Buffer>, value: string): Map<string, Buffer> {
  const result = new Map(files);
  for (const name of ['.claude-plugin/plugin.json', 'plugin.json', 'gemini-extension.json']) {
    const data = JSON.parse(result.get(name)!.toString()); data.version = value; result.set(name, Buffer.from(JSON.stringify(data) + '\n'));
  }
  return result;
}
function zip(files: Map<string, Buffer>): Buffer {
  const locals: Buffer[] = [], directory: Buffer[] = []; let offset = 0;
  for (const [path, bytes] of files) {
    const name = Buffer.from(path), local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(33, 12);
    local.writeUInt32LE(crc32(bytes), 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); local.copy(central, 6, 4, 30);
    central.writeUInt32LE((0o100644 * 0x10000) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, name, bytes); directory.push(central, name); offset += local.length + name.length + bytes.length;
  }
  const contents = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10); end.writeUInt32LE(contents.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, contents, end]);
}
function fixture(t: TestContext, files?: Map<string, Buffer>) {
  const dir = mkdtempSync(join(tmpdir(), 'budna-claude-runtime-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, archiveName(TAG, 'claude')), checksums = join(dir, 'SHA256SUMS');
  copyFileSync(join(base, archiveName(TAG, 'claude')), source); copyFileSync(join(base, 'SHA256SUMS'), checksums);
  if (files) {
    const bytes = zip(files); writeFileSync(source, bytes);
    const lines = readFileSync(checksums, 'utf8').split('\n').map(line => line.endsWith('  ' + archiveName(TAG, 'claude')) ? `${digest(bytes)}  ${archiveName(TAG, 'claude')}` : line);
    writeFileSync(checksums, lines.join('\n'));
  }
  return { source, checksums, env: { RELEASE_TAG: TAG, RELEASE_COMMIT: COMMIT, CHECKSUMS_SHA256: digest(readFileSync(checksums)), GITHUB_REPOSITORY: 'budna-marketplace/plugins' } };
}
function mockGit(options: { initial?: Map<string, Buffer>; failLookup?: boolean; moveAt?: number; patchRace?: boolean; corruptAfterUpdate?: boolean; badMode?: boolean } = {}) {
  const calls: { method: string; path: string; body?: any }[] = [];
  const blobs = new Map<string, Buffer>(), trees = new Map<string, any[]>(), commits = new Map<string, any>();
  let head: string | undefined, lookups = 0, updated = false;
  function put(files: Map<string, Buffer>) {
    const entries = [...files].map(([path, bytes]) => { const sha = gitSha(bytes); blobs.set(sha, bytes); return { path, mode: '100644', type: 'blob', sha, size: bytes.length }; });
    const tree = hash(entries); trees.set(tree, entries); const commit = hash({ tree, initial: true });
    commits.set(commit, { sha: commit, tree: { sha: tree }, parents: [] }); return commit;
  }
  if (options.initial) head = put(options.initial);
  const originalHead = head;
  const reference = () => ({ ref: REF, object: { type: 'commit', sha: head } });
  const api: GitApi = (method, path, body) => {
    calls.push({ method, path, body }); assert.ok(path.startsWith(PREFIX + '/'));
    const tail = path.slice(PREFIX.length + 1);
    if (method === 'GET' && tail === 'matching-refs/heads/claude') {
      lookups++; if (options.failLookup) throw new Error('simulated lookup failure');
      if (options.moveAt === lookups) head = 'f'.repeat(40);
      return head ? [reference()] : [];
    }
    if (method === 'GET' && tail.startsWith('commits/')) { const result = commits.get(tail.slice(8)); assert.ok(result); return result; }
    if (method === 'GET' && tail.startsWith('trees/')) {
      const tree = tail.slice(6).split('?')[0], entries = trees.get(tree); assert.ok(entries);
      return { sha: tree, truncated: false, tree: entries.map((entry, i) => ({ ...entry, ...(options.badMode && i === 0 ? { mode: '100755' } : {}) })) };
    }
    if (method === 'GET' && tail.startsWith('blobs/')) {
      const sha = tail.slice(6), bytes = blobs.get(sha)!; assert.ok(bytes);
      return { sha, size: bytes.length, encoding: 'base64', content: options.corruptAfterUpdate && updated ? Buffer.from('wrong bytes').toString('base64') : bytes.toString('base64') };
    }
    if (method === 'POST' && tail === 'blobs') { assert.equal(body!.encoding, 'base64'); const bytes = Buffer.from(body!.content, 'base64'), sha = gitSha(bytes); blobs.set(sha, bytes); return { sha }; }
    if (method === 'POST' && tail === 'trees') {
      assert.deepEqual(Object.keys(body!), ['tree'], 'a runtime tree never inherits source/main files');
      const entries = body!.tree.map((entry: any) => ({ ...entry, size: blobs.get(entry.sha)!.length })), sha = hash(entries); trees.set(sha, entries); return { sha };
    }
    if (method === 'POST' && tail === 'commits') {
      const sha = hash(body), commit = { sha, tree: { sha: body!.tree }, parents: body!.parents.map((sha: string) => ({ sha })) };
      assert.match(body!.message, new RegExp(COMMIT)); assert.ok(body!.message.includes(TAG)); assert.match(body!.message, /Claude ZIP SHA256: [0-9a-f]{64}/);
      commits.set(sha, commit); return commit;
    }
    if (method === 'POST' && tail === 'refs') { assert.equal(head, undefined); assert.equal(body!.ref, REF); head = body!.sha; updated = true; return reference(); }
    if (method === 'PATCH' && tail === 'refs/heads/claude') {
      assert.equal(body!.force, false); if (options.patchRace) head = 'e'.repeat(40);
      assert.equal(commits.get(body!.sha).parents[0]?.sha, head, 'server rejects non-fast-forward concurrent movement');
      head = body!.sha; updated = true; return reference();
    }
    throw new Error('unexpected mock GitHub operation');
  };
  return { api, calls, blobs, trees, commits, originalHead, head: () => head, mutations: () => calls.filter(c => c.method !== 'GET'), refWrites: () => calls.filter(c => c.path.endsWith('/refs') || c.path.endsWith('/refs/heads/claude')) };
}

test('actual current-source Claude export publishes an exact orphan runtime tree and retries without mutation', t => {
  const f = fixture(t), gh = mockGit();
  assert.equal(validateClaudeRuntime(RELEASED), VERSION); assert.equal(RELEASED.size, 22); assert.equal(RELEASED.has('assets/icon.svg'), false);
  const result = publishClaudeRuntime(f.source, f.checksums, f.env, gh.api);
  assert.equal(result.status, 'published'); assert.equal(result.files, 22);
  const commit = gh.commits.get(gh.head()!); assert.deepEqual(commit.parents, []);
  const entries = gh.trees.get(commit.tree.sha)!; assert.deepEqual(entries.map(e => e.path).sort(), [...RELEASED.keys()].sort());
  for (const entry of entries) { assert.equal(entry.mode, '100644'); assert.deepEqual(gh.blobs.get(entry.sha), RELEASED.get(entry.path)); }
  const writes = gh.mutations().length; assert.equal(publishClaudeRuntime(f.source, f.checksums, f.env, gh.api).status, 'unchanged'); assert.equal(gh.mutations().length, writes);
});

test('new versions append one parent without force and read every post-publication blob', t => {
  const f = fixture(t), gh = mockGit({ initial: version(RELEASED, '0.0.1') });
  publishClaudeRuntime(f.source, f.checksums, f.env, gh.api);
  assert.deepEqual(gh.commits.get(gh.head()!).parents, [{ sha: gh.originalHead }]);
  assert.equal(gh.refWrites().length, 1); assert.equal(gh.refWrites()[0].body.force, false);
  const refIndex = gh.calls.findIndex(c => c.method === 'PATCH'); assert.equal(gh.calls.slice(refIndex + 1).filter(c => c.path.includes('/blobs/')).length, RELEASED.size);
});

test('runtime policy rejects SVG, package/config files, malformed UTF-8, NUL, disguised scripts and bad PNG', t => {
  const variants: Map<string, Buffer>[] = [];
  for (const name of ['assets/icon.svg', 'package.json', '.claude/settings.json', 'scripts/run.mts']) { const files = new Map(RELEASED); files.set(name, Buffer.from('{}')); variants.push(files); }
  for (const bytes of [Buffer.from([0xff]), Buffer.from('text\0'), Buffer.from('ordinary text with #! inside'), Buffer.from('#!/bin/sh\n'), Buffer.from('\uFEFF \n#!/bin/sh\n')]) { const files = new Map(RELEASED); files.set('README.md', bytes); variants.push(files); }
  const png = new Map(RELEASED); png.set('assets/icon.png', Buffer.from('not PNG')); variants.push(png);
  for (const files of variants) { const f = fixture(t, files), gh = mockGit(); assert.throws(() => publishClaudeRuntime(f.source, f.checksums, f.env, gh.api)); assert.deepEqual(gh.calls, []); }
});

test('trusted checksum, ZIP, repository, source identity and manifest version guards fail before GitHub', t => {
  const f = fixture(t);
  for (const env of [{ ...f.env, CHECKSUMS_SHA256: '0'.repeat(64) }, { ...f.env, GITHUB_REPOSITORY: 'other/plugins' }, { ...f.env, RELEASE_COMMIT: COMMIT + '\n' }]) { const gh = mockGit(); assert.throws(() => publishClaudeRuntime(f.source, f.checksums, env, gh.api)); assert.deepEqual(gh.calls, []); }
  const mismatched = fixture(t, version(RELEASED, '9.0.0')), wrong = mockGit(); assert.throws(() => publishClaudeRuntime(mismatched.source, mismatched.checksums, mismatched.env, wrong.api), /version/); assert.deepEqual(wrong.calls, []);
  writeFileSync(f.source, 'changed ZIP'); const gh = mockGit(); assert.throws(() => publishClaudeRuntime(f.source, f.checksums, f.env, gh.api), /ZIP differs/); assert.deepEqual(gh.calls, []);
});

test('same-version content changes and downgrades never mutate existing branches', t => {
  const f = fixture(t), modified = new Map(RELEASED); modified.set('README.md', Buffer.from('different runtime documentation'));
  for (const [initial, reason] of [[modified, /bytes differ/], [version(RELEASED, '999.0.0'), /downgrade/]] as const) { const gh = mockGit({ initial }); assert.throws(() => publishClaudeRuntime(f.source, f.checksums, f.env, gh.api), reason); assert.deepEqual(gh.mutations(), []); assert.equal(gh.head(), gh.originalHead); }
});

test('failed or ambiguous reference lookups never create a branch', t => {
  const f = fixture(t), gh = mockGit({ failLookup: true }); assert.throws(() => publishClaudeRuntime(f.source, f.checksums, f.env, gh.api), /lookup failure/); assert.deepEqual(gh.mutations(), []);
  for (const value of [{}, null, Array.from({ length: 1000 }, () => ({ ref: REF, object: { type: 'commit', sha: COMMIT } }))]) { const calls: string[] = []; const api: GitApi = method => { calls.push(method); return value; }; assert.throws(() => publishClaudeRuntime(f.source, f.checksums, f.env, api)); assert.deepEqual(calls, ['GET']); }
});

test('observed reference movement fails closed before ref writes, including an ordinary concurrent fast-forward race', t => {
  const f = fixture(t);
  for (const moveAt of [2, 4]) { const gh = mockGit({ initial: version(RELEASED, '0.0.1'), moveAt }); assert.throws(() => publishClaudeRuntime(f.source, f.checksums, f.env, gh.api), /branch moved/); assert.deepEqual(gh.refWrites(), []); if (moveAt === 2) assert.deepEqual(gh.mutations(), []); }
  const race = mockGit({ initial: version(RELEASED, '0.0.1'), patchRace: true }); assert.throws(() => publishClaudeRuntime(f.source, f.checksums, f.env, race.api), /non-fast-forward/); assert.equal(race.head(), 'e'.repeat(40));
});

test('nonregular remote entries and inconsistent post-publication blob readback are rejected', t => {
  const f = fixture(t), bad = mockGit({ initial: version(RELEASED, '0.0.1'), badMode: true }); assert.throws(() => publishClaudeRuntime(f.source, f.checksums, f.env, bad.api), /mode/); assert.deepEqual(bad.mutations(), []);
  const changed = mockGit({ corruptAfterUpdate: true }); assert.throws(() => publishClaudeRuntime(f.source, f.checksums, f.env, changed.api), /blob bytes/); assert.equal(changed.refWrites().length, 1, 'post-publication failure is reported honestly after mutation');
});
