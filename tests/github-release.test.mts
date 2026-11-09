import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { archiveName, digest } from '../scripts/release.mts';
import { prepareDraft, publishAssets, type GhRunner } from '../scripts/github-release.mts';

const TAG = 'v0.1.5';
const SCRIPT = fileURLToPath(new URL('../scripts/github-release.mts', import.meta.url));

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'budna-github-release-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const originals = new Map([
    [archiveName(TAG), Buffer.from('verified universal archive')],
    ['SHA256SUMS', Buffer.from('verified seven-asset checksum list\n')],
  ]);
  const target = archiveName(TAG, 'claude');
  const targetBytes = Buffer.from('verified Claude export');
  const exports = new Map([
    [target, targetBytes],
    [`${target}.sha256`, Buffer.from(`${digest(targetBytes)}  ${target}\n`)],
  ]);
  for (const [name, bytes] of [...originals, ...exports]) writeFileSync(join(directory, name), bytes);
  const env = {
    RELEASE_TAG: TAG, RELEASE_ID: '41', RELEASE_TARGET: 'claude', GITHUB_REPOSITORY: 'budna-marketplace/plugins',
    ARCHIVE_SHA256: digest(originals.get(archiveName(TAG))!), CHECKSUMS_SHA256: digest(originals.get('SHA256SUMS')!),
  };
  return { directory, originals, exports, env };
}

function mockGh(options: { draft?: boolean; exists?: boolean; remote?: Map<string, Buffer>; fail?: string; view?: (n: number) => object } = {}) {
  const calls: string[][] = [];
  const remote = new Map(options.remote);
  let exists = options.exists ?? true;
  let views = 0;
  const runner: GhRunner = args => {
    calls.push([...args]);
    assert.equal(args[0], 'release');
    assert.equal(args[args.length - 2], '--repo');
    assert.equal(args.at(-1), 'budna-marketplace/plugins');
    const command = args[1];
    if (options.fail === command) throw new Error(`simulated ${command} failure`);
    if (command === 'list') return JSON.stringify(exists ? [{ tagName: TAG }] : []);
    if (command === 'view') {
      views++;
      return JSON.stringify({ databaseId: 41, tagName: TAG, isDraft: options.draft ?? false, isPrerelease: false,
        assets: [...remote.keys()].map(name => ({ name })), ...options.view?.(views) });
    }
    if (command === 'create') {
      assert.equal(exists, false);
      assert.ok(args.includes('--draft') && args.includes('--verify-tag'));
      assert.equal(args[args.indexOf('--title') + 1], TAG);
      exists = true;
      return '';
    }
    if (command === 'download') {
      const name = args[args.indexOf('--pattern') + 1];
      assert.ok(remote.has(name), `unexpected download: ${name}`);
      writeFileSync(join(args[args.indexOf('--dir') + 1], name), remote.get(name)!);
      return '';
    }
    if (command === 'upload') {
      const path = args[3], name = basename(path);
      assert.equal(remote.has(name), false, 'existing assets must never be uploaded again');
      assert.equal(args.includes('--clobber'), false);
      remote.set(name, readFileSync(path));
      return '';
    }
    throw new Error(`unexpected gh operation: ${command}`);
  };
  return { runner, calls, remote, mutations: () => calls.filter(args => ['create', 'upload'].includes(args[1])) };
}

test('identical existing draft or published originals are downloaded and left unchanged', t => {
  const f = fixture(t);
  for (const draft of [true, false]) {
    const gh = mockGh({ draft, remote: f.originals });
    prepareDraft(f.directory, f.env, gh.runner);
    assert.equal(gh.calls.filter(args => args[1] === 'download').length, 2);
    assert.deepEqual(gh.mutations(), []);
  }
});

test('all existing bytes are checked before a missing draft asset can be uploaded', t => {
  const f = fixture(t);
  const gh = mockGh({ draft: true, remote: new Map([['SHA256SUMS', Buffer.from('different existing bytes')]]) });
  assert.throws(() => prepareDraft(f.directory, f.env, gh.runner), /Existing release asset differs/);
  assert.deepEqual(gh.mutations(), []);
});

test('lookup failures or unverifiable absence never create or upload', t => {
  const f = fixture(t);
  for (const fail of ['list', 'view']) {
    const gh = mockGh({ fail });
    assert.throws(() => prepareDraft(f.directory, f.env, gh.runner), /simulated/);
    assert.deepEqual(gh.mutations(), []);
  }
  for (const listing of ['{}', 'not JSON', JSON.stringify(Array.from({ length: 1000 }, (_, i) => ({ tagName: `old-${i}` })))]) {
    let mutations = 0;
    const runner: GhRunner = args => {
      if (['create', 'upload'].includes(args[1])) mutations++;
      return listing;
    };
    assert.throws(() => prepareDraft(f.directory, f.env, runner));
    assert.equal(mutations, 0);
  }
});

test('proven absent releases use a version-only draft title and rerun without overwriting', t => {
  const f = fixture(t);
  const gh = mockGh({ draft: true, exists: false });
  prepareDraft(f.directory, f.env, gh.runner);
  assert.equal(gh.calls.filter(args => args[1] === 'create').length, 1);
  assert.deepEqual([...gh.remote.keys()].sort(), [...f.originals.keys()].sort());
  const firstWrites = gh.mutations().length;
  prepareDraft(f.directory, f.env, gh.runner);
  assert.equal(gh.mutations().length, firstWrites);
});

test('corrupt local bytes and published missing originals fail without mutations', t => {
  const f = fixture(t);
  const published = mockGh();
  assert.throws(() => prepareDraft(f.directory, f.env, published.runner), /Published release is missing/);
  assert.deepEqual(published.mutations(), []);
  writeFileSync(join(f.directory, archiveName(TAG)), 'tampered');
  const corrupted = mockGh({ draft: true });
  assert.throws(() => prepareDraft(f.directory, f.env, corrupted.runner), /differs from verified tagged source/);
  assert.deepEqual(corrupted.calls, []);
});

test('publisher rejects draft, prerelease, tag or identity changes before uploads', t => {
  const f = fixture(t);
  for (const state of [{ isDraft: true }, { isPrerelease: true }, { tagName: 'v9.9.9' }, { databaseId: 42 }]) {
    const gh = mockGh({ view: () => state });
    assert.throws(() => publishAssets(f.directory, f.env, gh.runner), /Release identity or publication state/);
    assert.deepEqual(gh.mutations(), []);
    assert.equal(gh.calls.filter(args => args[1] === 'download').length, 0);
  }
});

test('publisher skips actual identical assets and aborts mismatches without overwrites', t => {
  const f = fixture(t);
  const same = mockGh({ remote: f.exports });
  publishAssets(f.directory, f.env, same.runner);
  assert.deepEqual(same.mutations(), []);
  const remote = new Map(f.exports);
  remote.set(archiveName(TAG, 'claude'), Buffer.from('tampered remote archive'));
  const changed = mockGh({ remote });
  assert.throws(() => publishAssets(f.directory, f.env, changed.runner), /Existing release asset differs/);
  assert.deepEqual(changed.mutations(), []);
});

test('publisher uploads only the target pair and rechecks identity immediately before each upload', t => {
  const f = fixture(t);
  const gh = mockGh();
  publishAssets(f.directory, f.env, gh.runner);
  assert.deepEqual([...gh.remote.keys()].sort(), [...f.exports.keys()].sort());
  publishAssets(f.directory, f.env, gh.runner);
  assert.equal(gh.mutations().length, 2);
  const changed = mockGh({ view: n => n > 1 ? { databaseId: 42 } : {} });
  assert.throws(() => publishAssets(f.directory, f.env, changed.runner), /Release identity or publication state/);
  assert.deepEqual(changed.mutations(), []);
});

test('draft identity changes and target sidecar corruption block uploads', t => {
  const f = fixture(t);
  const changed = mockGh({ draft: true, view: n => n > 1 ? { isPrerelease: true } : {} });
  assert.throws(() => prepareDraft(f.directory, f.env, changed.runner), /Release identity or publication state/);
  assert.deepEqual(changed.mutations(), []);
  const name = `${archiveName(TAG, 'claude')}.sha256`;
  const highBit = Buffer.from(f.exports.get(name)!);
  highBit[0] |= 0x80;
  for (const invalid of [Buffer.from('invalid sidecar'), highBit]) {
    writeFileSync(join(f.directory, name), invalid);
    const corrupt = mockGh();
    assert.throws(() => publishAssets(f.directory, f.env, corrupt.runner), /invalid target checksum sidecar/);
    assert.deepEqual(corrupt.mutations(), []);
  }
});

test('workflow CLI writes fingerprints and validates saved release identity without contacting GitHub', t => {
  const f = fixture(t), output = join(f.directory, 'output');
  writeFileSync(output, '');
  const env = { ...f.env, GITHUB_OUTPUT: output };
  execFileSync(process.execPath, [SCRIPT, 'fingerprint', '--directory', f.directory], { env });
  assert.equal(readFileSync(output, 'utf8'), `archive_sha256=${f.env.ARCHIVE_SHA256}\nchecksums_sha256=${f.env.CHECKSUMS_SHA256}\n`);
  const metadata = join(f.directory, 'release.json');
  writeFileSync(metadata, JSON.stringify({ databaseId: 41, tagName: TAG, isDraft: false, isPrerelease: false }));
  execFileSync(process.execPath, [SCRIPT, 'verify-release', '--file', metadata], { env });
  writeFileSync(metadata, JSON.stringify({ databaseId: 42, tagName: TAG, isDraft: false, isPrerelease: false }));
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, 'verify-release', '--file', metadata], { env, stdio: 'pipe' }));
  const imported = execFileSync(process.execPath, ['--input-type=module', '-'], {
    env, input: `await import(${JSON.stringify(pathToFileURL(SCRIPT).href)});`, encoding: 'utf8',
  });
  assert.equal(imported, '', 'stdin import must not execute either CLI main');
});
