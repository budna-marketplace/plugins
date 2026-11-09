import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const TAG = 'v0.1.0';
const MANIFESTS = [
  'plugin.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json',
  'gemini-extension.json',
];
const RUNTIME_FILES = [
  ...MANIFESTS, '.claude-plugin/marketplace.json', '.mcp.json', 'mcp.json',
  'README.md', 'LICENSE',
];
const TARGETS = ['claude', 'openai', 'gemini', 'cursor', 'copilot', 'grok'];
const archiveName = (target?: string): string => `budna-${TAG}${target ? `-${target}` : ''}.zip`;
const digest = (content: Buffer): string => createHash('sha256').update(content).digest('hex');
type Json = Record<string, any>;
type Entry = { name: string; content: Buffer; mode: number; time?: number; date?: number };
const entry = (name: string, content: string | Buffer, mode = 0o100644): Entry =>
  ({ name, content: Buffer.from(content), mode });

function readZip(path: string): Entry[] {
  const bytes = readFileSync(path);
  assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50);
  const count = bytes.readUInt16LE(bytes.length - 12);
  let offset = bytes.readUInt32LE(bytes.length - 6);
  const entries: Entry[] = [];
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    assert.equal(bytes.readUInt16LE(offset + 10), 0, 'release entries must be stored without compression');
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString();
    const local = bytes.readUInt32LE(offset + 42);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const content = bytes.subarray(start, start + size);
    assert.equal(crc32(content), bytes.readUInt32LE(offset + 16));
    entries.push({ name, content, mode: bytes.readUInt32LE(offset + 38) >>> 16,
      time: bytes.readUInt16LE(offset + 12), date: bytes.readUInt16LE(offset + 14) });
    offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  return entries;
}

function zipBytes(entries: Entry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const { name, content, mode } of entries) {
    const encodedName = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(33, 12);
    local.writeUInt32LE(crc32(content), 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(encodedName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(0x0314, 4);
    local.copy(central, 6, 4, 30);
    central.writeUInt32LE((mode * 0x10000) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    localParts.push(local, encodedName, content);
    centralParts.push(central, encodedName);
    offset += local.length + encodedName.length + content.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, end]);
}

function fixture(t: TestContext) {
  const temporary = mkdtempSync(join(tmpdir(), 'budna-release-test-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const source = join(temporary, 'source');
  const out = join(temporary, 'dist');
  const script = join(source, 'scripts/release.py');
  const exporter = join(temporary, 'runner/scripts/release.py');
  const write = (name: string, content: string | Buffer): void => {
    const path = join(source, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  for (const name of [...RUNTIME_FILES, 'scripts/release.py']) write(name, readFileSync(join(ROOT, name)));
  for (const name of ['assets', 'skills']) cpSync(join(ROOT, name), join(source, name), { recursive: true });
  mkdirSync(dirname(exporter), { recursive: true });
  copyFileSync(script, exporter);
  const updateJson = (name: string, change: (data: Json) => void): void => {
    const data = JSON.parse(readFileSync(join(source, name), 'utf8'));
    change(data);
    write(name, JSON.stringify(data));
  };
  for (const name of MANIFESTS) updateJson(name, data => { data.version = TAG.slice(1); });
  updateJson('.claude-plugin/marketplace.json', data => {
    for (const plugin of data.plugins) if ('version' in plugin) plugin.version = TAG.slice(1);
  });
  const run = (args: string[], error?: RegExp, program = script): string => {
    const result = spawnSync('python3', [program, ...args], { cwd: temporary, encoding: 'utf8', timeout: 15000 });
    assert.ifError(result.error);
    if (error) {
      assert.equal(result.status, 1, `expected rejection for ${args.join(' ')}: ${result.stdout}${result.stderr}`);
      assert.match(result.stderr, error);
    } else {
      assert.equal(result.status, 0, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
    }
    return result.stdout;
  };
  const build = (): string => {
    run(['build', '--tag', TAG, '--out', out]);
    return join(out, archiveName());
  };
  const exportTarget = (target = 'claude', error?: RegExp, destination = join(temporary, 'exported')): string => {
    run(['export', '--tag', TAG, '--target', target, '--source', join(out, archiveName()),
      '--checksums', join(out, 'SHA256SUMS'), '--out', destination], error, exporter);
    return destination;
  };
  const replaceArchive = (entries: Entry[]): void => {
    const path = join(out, archiveName());
    writeFileSync(path, zipBytes(entries));
    const checksums = readFileSync(join(out, 'SHA256SUMS'), 'utf8').split('\n').filter(Boolean)
      .map(line => line.endsWith(`  ${archiveName()}`) ? `${digest(readFileSync(path))}  ${archiveName()}` : line);
    writeFileSync(join(out, 'SHA256SUMS'), `${checksums.join('\n')}\n`);
  };
  return { temporary, source, out, write, updateJson, run, build, exportTarget, replaceArchive };
}

test('build is deterministic and contains only runtime files', t => {
  const f = fixture(t);
  for (const name of ['.github/workflows/private.yml', 'scripts/private.py', 'tests/private.ts',
    '.git/config', 'unrelated.txt', 'assets/.DS_Store']) f.write(name, 'must not ship');
  rmSync(join(f.source, '.git'), { recursive: true });
  const source = f.build();
  const snapshot = () => Object.fromEntries(readdirSync(f.out).map(name => [name, readFileSync(join(f.out, name))]));
  const before = snapshot();
  for (const path of readdirSync(f.source, { recursive: true, withFileTypes: true })) {
    if (path.isFile()) {
      const file = join(path.parentPath, path.name);
      utimesSync(file, 1700000000, 1700000000);
      chmodSync(file, 0o600);
    }
  }
  f.build();
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(Object.keys(before).sort(), [archiveName(), ...TARGETS.map(archiveName), 'SHA256SUMS'].sort());
  const entries = readZip(source);
  const names = entries.map(item => item.name);
  assert.deepEqual(names, [...names].sort());
  for (const name of RUNTIME_FILES) assert.ok(names.includes(name), name);
  for (const item of entries) {
    assert.ok(!item.content.includes('must not ship'), item.name);
    assert.equal(item.date, 33);
    assert.equal(item.time, 0);
    assert.equal(item.mode, 0o100644);
  }
  f.run(['verify', '--tag', TAG, '--directory', f.out]);
});

test('check infers the tag and rejects invalid or mismatched versions', t => {
  const f = fixture(t);
  assert.match(f.run(['check']), /Validated Budna v0\.1\.0/);
  for (const tag of ['0.1.0', 'v00.1.0', 'v0.01.0', 'v0.1.00', 'v0.1.0-alpha', 'v0.1.0+build', 'v0.1.1']) {
    f.run(['check', '--tag', tag], /tag must be|version does not match/);
  }
  for (const manifest of MANIFESTS) {
    const original = readFileSync(join(f.source, manifest));
    f.updateJson(manifest, data => { data.version = '0.2.0'; });
    f.run(['check', '--tag', TAG], /version does not match/);
    f.write(manifest, original);
  }
});

test('required metadata, schemas, and public defaults are enforced', t => {
  const f = fixture(t);
  const cases: [string, (data: Json) => void][] = [
    ['plugin.json', data => { delete data.$schema; }],
    ['plugin.json', data => { data.repository = 'https://example.com'; }],
    ['.claude-plugin/plugin.json', data => { data.mcpServers = { private: { url: 'https://example.com' } }; }],
    ['mcp.json', data => { delete data.$schema; }],
    ['.mcp.json', data => { data.mcpServers.budna.url = 'https://api.budna.se/account/mcp'; }],
    ['mcp.json', data => { data.mcpServers.budna.headers = { Authorization: 'secret' }; }],
    ['gemini-extension.json', data => { data.mcpServers.budna.env = { TOKEN: 'secret' }; }],
    ['.claude-plugin/plugin.json', data => { data.icon = '../outside.png'; }],
    ['.codex-plugin/plugin.json', data => { data.mcpServers = './missing.json'; }],
    ['.claude-plugin/marketplace.json', data => { data.plugins[0].source = '../outside'; }],
  ];
  for (const [manifest, change] of cases) {
    const original = readFileSync(join(f.source, manifest));
    f.updateJson(manifest, change);
    f.run(['check', '--tag', TAG], /release:/);
    f.write(manifest, original);
  }
});

test('OpenAI MCP review requires all four public listing URLs', t => {
  const f = fixture(t);
  const manifest = '.codex-plugin/plugin.json';
  const original = readFileSync(join(f.source, manifest));
  const urls = {
    websiteURL: 'https://budna.se',
    supportURL: 'https://connect.budna.se/contact-us',
    privacyPolicyURL: 'https://legal.budna.se/privacy-policy',
    termsOfServiceURL: 'https://legal.budna.se/terms-of-service',
  };
  f.build();
  const bundled = readZip(join(f.out, archiveName('openai'))).find(item => item.name === manifest)!;
  const metadata = JSON.parse(bundled.content.toString());
  for (const [field, url] of Object.entries(urls)) {
    assert.equal(metadata.interface[field], url, `OpenAI bundle must include ${field}`);
    f.updateJson(manifest, data => { delete data.interface[field]; });
    f.run(['check', '--tag', TAG], new RegExp(`OpenAI ${field} required`));
    f.write(manifest, original);
  }
});

test('OpenAI review includes five positive and three negative cases', t => {
  const f = fixture(t);
  const manifest = '.codex-plugin/plugin.json';
  const original = readFileSync(join(f.source, manifest));
  f.build();
  const bundled = readZip(join(f.out, archiveName('openai'))).find(item => item.name === manifest)!;
  const metadata = JSON.parse(bundled.content.toString());
  const review = metadata.extensions['com.openai'].review;
  assert.equal(review.test_cases.positive.length, 5);
  assert.equal(review.test_cases.negative.length, 3);
  assert.equal(review.demo_recording_url, undefined, 'a recording URL must not be invented');
  const changes: ((data: Json) => void)[] = [
    data => { delete data.extensions; },
    data => { data.extensions['com.openai'].review.test_cases.positive.pop(); },
    data => { data.extensions['com.openai'].review.test_cases.negative.pop(); },
    data => { data.extensions['com.openai'].review.test_cases.positive[0].prompt = ''; },
    data => { delete data.extensions['com.openai'].review.test_cases.positive[0].tools_triggered; },
    data => { data.extensions['com.openai'].review.test_cases.negative[0].expected_behavior = ''; },
  ];
  for (const change of changes) {
    f.updateJson(manifest, change);
    f.run(['check', '--tag', TAG], /OpenAI.*review|OpenAI.*cases/);
    f.write(manifest, original);
  }
});

test('checkout symlinks and submodules are rejected', t => {
  const f = fixture(t);
  const path = join(f.source, 'assets/icon.svg');
  rmSync(path);
  symlinkSync(join(f.source, 'README.md'), path);
  f.run(['check', '--tag', TAG], /regular file required/);
  rmSync(path);
  f.write('assets/icon.svg', '<svg/>');
  f.write('.gitmodules', '[submodule "external"]');
  f.run(['check', '--tag', TAG], /submodules/);
});

test('export uses the complete pinned payload and target manifest subset', t => {
  const f = fixture(t);
  const source = f.build();
  const readme = readFileSync(join(f.source, 'README.md'));
  rmSync(f.source, { recursive: true });
  const universal = readZip(source);
  const common = universal.filter(({ name }) => name.startsWith('skills/') || name.startsWith('assets/')
    || ['README.md', 'LICENSE', 'plugin.json', 'mcp.json', '.mcp.json', 'gemini-extension.json'].includes(name));
  const extras: Record<string, string[]> = {
    claude: ['.claude-plugin/plugin.json'], openai: ['.codex-plugin/plugin.json'],
    gemini: [], cursor: [], copilot: [], grok: ['.claude-plugin/plugin.json'],
  };
  for (const target of TARGETS) {
    const out = join(f.temporary, 'exported', target);
    f.exportTarget(target, undefined, out);
    const name = archiveName(target);
    const bytes = readFileSync(join(out, name));
    assert.deepEqual(bytes, readFileSync(join(f.out, name)));
    assert.equal(readFileSync(join(out, `${name}.sha256`), 'utf8'), `${digest(bytes)}  ${name}\n`);
    f.exportTarget(target, undefined, out);
    assert.deepEqual(readFileSync(join(out, name)), bytes, 'retry must preserve the pinned bytes');
    const entries = new Map(readZip(join(out, name)).map(item => [item.name, item.content]));
    assert.deepEqual([...entries.keys()].sort(), [...common.map(item => item.name), ...extras[target]].sort());
    assert.deepEqual(entries.get('README.md'), readme);
    for (const match of readme.toString().matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const href = match[1];
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) continue;
      const path = href.split(/[?#]/)[0];
      if (path) assert.ok(entries.has(posix.normalize(decodeURIComponent(path))), `broken README link in ${target}: ${href}`);
    }
    for (const item of common) {
      if (target === 'openai' && item.name === 'mcp.json') {
        const expected = JSON.parse(item.content.toString());
        expected.mcpServers.budna.extensions = { 'com.openai': { auth: { type: 'none' } } };
        assert.deepEqual(JSON.parse(entries.get(item.name)!.toString()), expected);
      } else {
        assert.deepEqual(entries.get(item.name), item.content);
      }
    }
    if (target === 'openai') {
      const metadata = JSON.parse(entries.get('.codex-plugin/plugin.json')!.toString());
      assert.ok(entries.has(metadata.mcpServers.slice(2)));
    }
  }
});

test('OpenAI no-auth cannot be removed or changed by rehashing a target ZIP', t => {
  const f = fixture(t);
  f.build();
  const name = archiveName('openai');
  const target = join(f.out, name);
  const entries = readZip(target);
  const originalChecksums = readFileSync(join(f.out, 'SHA256SUMS'), 'utf8');
  const changes: ((data: Json) => void)[] = [
    data => { delete data.mcpServers.budna.extensions; },
    data => { data.mcpServers.budna.extensions['com.openai'].auth.type = 'oauth'; },
    data => { data.mcpServers.budna.extensions['com.openai'].auth.baseScopes = ['account:read']; },
  ];
  for (const change of changes) {
    const modified = entries.map(item => {
      if (item.name !== 'mcp.json') return item;
      const data = JSON.parse(item.content.toString());
      change(data);
      return { ...item, content: Buffer.from(JSON.stringify(data)) };
    });
    const bytes = zipBytes(modified);
    writeFileSync(target, bytes);
    writeFileSync(join(f.out, 'SHA256SUMS'), originalChecksums.split('\n')
      .map(line => line.endsWith(`  ${name}`) ? `${digest(bytes)}  ${name}` : line).join('\n'));
    f.run(['verify', '--tag', TAG, '--directory', f.out], /target ZIP checksum mismatch/);
  }
});

test('corrupted universal and target assets fail verification', t => {
  const f = fixture(t);
  const source = f.build();
  const original = readFileSync(source);
  writeFileSync(source, Buffer.concat([original, Buffer.from('corrupted')]));
  f.exportTarget('claude', /universal ZIP checksum mismatch/);
  writeFileSync(source, original);
  const target = join(f.out, archiveName('claude'));
  writeFileSync(target, Buffer.concat([readFileSync(target), Buffer.from('corrupted')]));
  f.run(['verify', '--tag', TAG, '--directory', f.out], /target ZIP checksum mismatch/);
});

test('unsafe and duplicate ZIP entries are rejected before writing', t => {
  const f = fixture(t);
  const files = readZip(f.build());
  for (const name of ['../outside', '/absolute', 'assets\\outside', 'assets//outside', './README.md', '.git/config', 'scripts/run.py']) {
    f.replaceArchive([...files, entry(name, 'untrusted')]);
    f.exportTarget('claude', /unsafe file path|unexpected runtime file/);
  }
  f.replaceArchive([...files, entry('README.md', 'duplicate')]);
  f.exportTarget('claude', /duplicate ZIP entry/);
  assert.ok(!existsSync(join(f.temporary, 'exported')));
});

test('symlink, directory, and oversized ZIP entries are rejected', t => {
  const f = fixture(t);
  const files = readZip(f.build());
  for (const item of [entry('assets/linked', 'README.md', 0o120777), entry('assets/directory/', 'README.md', 0o040755)]) {
    f.replaceArchive([...files, item]);
    f.exportTarget('gemini', /regular file|unsafe file path/);
  }
  f.replaceArchive([...files, entry('assets/oversized.txt', Buffer.alloc(4 * 1024 * 1024 + 1, 65))]);
  f.exportTarget('claude', /oversized ZIP entry/);
  assert.ok(!existsSync(join(f.temporary, 'exported')));
});

test('checksum asset set and target snapshot hash are enforced', t => {
  const f = fixture(t);
  f.build();
  const path = join(f.out, 'SHA256SUMS');
  const original = readFileSync(path, 'utf8');
  for (const content of [original + original.split('\n')[0] + '\n', original.split('\n')[0] + '\n',
    original.replace('budna-v0.1.0-grok.zip', '../outside.zip')]) {
    writeFileSync(path, content);
    f.exportTarget('claude', /duplicate checksum|exactly the seven|invalid SHA256SUMS/);
  }
  writeFileSync(path, original.split('\n').map(line => line.endsWith(`  ${archiveName('claude')}`)
    ? `${'0'.repeat(64)}  ${archiveName('claude')}` : line).join('\n'));
  f.exportTarget('claude', /derived target checksum mismatch/);
  assert.ok(!existsSync(join(f.temporary, 'exported')));
});

test('ambiguous ZIP paths are rejected', t => {
  const f = fixture(t);
  const files = readZip(f.build());
  for (const name of ['skills/recommerce-buy', 'assets/ICON.png']) {
    f.replaceArchive([...files, entry(name, 'ambiguous')]);
    f.exportTarget('claude', /collision/);
  }
  f.replaceArchive([...files, entry('assets/Parent', 'file'), entry('assets/parent/child.txt', 'ambiguous')]);
  f.exportTarget('claude', /collision/);
});
