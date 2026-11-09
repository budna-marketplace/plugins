#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync,
  rmSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { crc32, inflateRawSync } from 'node:zlib';

type Json = Record<string, any>;
type Snapshot = Map<string, Buffer>;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const PUBLIC_ENDPOINT = 'https://api.budna.se/mcp';
const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
const SKILLS = new Set([
  'recommerce-buy', 'recommerce-collect', 'recommerce-inspect',
  'recommerce-keep', 'recommerce-kits', 'recommerce-second-look',
]);
const MANIFESTS = [
  'plugin.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json',
  'gemini-extension.json',
];
const COMMON_FILES = new Set(['README.md', 'LICENSE', 'plugin.json', 'mcp.json', '.mcp.json', 'gemini-extension.json']);
const RUNTIME_FILES = new Set([
  ...MANIFESTS, '.claude-plugin/marketplace.json', '.mcp.json', 'mcp.json', 'README.md', 'LICENSE',
]);
const TARGET_FILES: Record<string, Set<string>> = {
  claude: new Set(['.claude-plugin/plugin.json']),
  openai: new Set(['.codex-plugin/plugin.json']),
  gemini: new Set(), cursor: new Set(), copilot: new Set(),
  grok: new Set(['.claude-plugin/plugin.json']),
};
export const TARGETS = Object.keys(TARGET_FILES);
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 256;
const decoder = new TextDecoder('utf-8', { fatal: true });

function require(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function object(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function keys(value: Json, expected: Iterable<string>, exact = true): boolean {
  const allowed = new Set(expected);
  return Object.keys(value).every(key => allowed.has(key)) && (!exact || Object.keys(value).length === allowed.size);
}

export function releaseVersion(tag: string): string {
  require(typeof tag === 'string' && tag.startsWith('v') && VERSION_PATTERN.exec(tag.slice(1))?.[0] === tag.slice(1),
    'tag must be vMAJOR.MINOR.PATCH with no leading zeroes or prerelease suffix');
  return tag.slice(1);
}

export function archiveName(tag: string, target?: string): string {
  releaseVersion(tag);
  return `budna-${tag}${target ? `-${target}` : ''}.zip`;
}

function assetNames(tag: string): Set<string> {
  return new Set([archiveName(tag), ...TARGETS.map(target => archiveName(tag, target))]);
}

function safePath(name: string): void {
  require(typeof name === 'string' && name.length > 0 && !/[^A-Za-z0-9_.\-/]/.test(name)
    && name.split('/').every(part => !['', '.', '..', '.git'].includes(part)), `unsafe file path: ${JSON.stringify(name)}`);
  require(RUNTIME_FILES.has(name) || name.startsWith('assets/') || name.startsWith('skills/'), `unexpected runtime file: ${name}`);
}

function readJson(files: Snapshot, name: string): Json {
  let result: unknown;
  try {
    const content = files.get(name);
    require(content, `missing JSON: ${name}`);
    result = JSON.parse(decoder.decode(content));
  } catch {
    throw new Error(`invalid or missing JSON: ${name}`);
  }
  require(object(result), `JSON object required: ${name}`);
  return result;
}

function fileReference(files: Snapshot, reference: unknown, directory = false): void {
  require(typeof reference === 'string' && reference.startsWith('./'), `repository-relative reference required: ${JSON.stringify(reference)}`);
  const name = directory ? reference.slice(2).replace(/\/+$/, '') : reference.slice(2);
  safePath(directory ? `${name}/SKILL.md` : name);
  require(directory ? [...files.keys()].some(path => path.startsWith(`${name}/`)) : files.has(name), `missing referenced path: ${reference}`);
}

function validateSnapshot(files: Snapshot, tag: string): void {
  const version = releaseVersion(tag);
  require(files.size <= MAX_FILES, 'too many runtime files');
  require([...files.values()].reduce((total, content) => total + content.length, 0) <= MAX_TOTAL_BYTES, 'runtime payload too large');
  const folded = new Set([...files.keys()].map(name => name.toLowerCase()));
  require(folded.size === files.size, 'case-insensitive file path collision');
  for (const [name, content] of files) {
    safePath(name);
    const parts = name.split('/');
    require(!parts.some((_, index) => index > 0 && folded.has(parts.slice(0, index).join('/').toLowerCase())), `file/directory path collision: ${name}`);
    require(content.length > 0 && content.length <= MAX_FILE_BYTES, `empty or oversized file: ${name}`);
  }
  require([...RUNTIME_FILES].every(name => files.has(name)), 'required runtime file missing');
  const manifests = Object.fromEntries(MANIFESTS.map(name => [name, readJson(files, name)]));
  const metadata = ['name', 'version', 'description', 'author', 'homepage', 'repository', 'license'];
  const allowed: Record<string, string[]> = {
    'plugin.json': [...metadata, '$schema'],
    '.claude-plugin/plugin.json': [...metadata, 'icon', 'privacyPolicyUrl', 'supportUrl', 'termsOfServiceUrl', 'documentationUrl'],
    '.codex-plugin/plugin.json': [...metadata, 'skills', 'mcpServers', 'interface', 'extensions'],
    'gemini-extension.json': ['name', 'version', 'description', 'mcpServers'],
  };
  for (const [name, manifest] of Object.entries(manifests)) {
    require(keys(manifest, allowed[name], false), `unexpected manifest fields: ${name}`);
    require(manifest.version === version, `version does not match ${tag}: ${name}`);
    require(manifest.name === 'budna', `plugin name must be budna: ${name}`);
    require(typeof manifest.description === 'string' && manifest.description.trim(), `description required: ${name}`);
  }
  const portable = manifests['plugin.json'];
  require(portable.$schema === PLUGIN_SCHEMA, 'Agent Plugins 1.0 schema required');
  for (const name of MANIFESTS.slice(0, 3)) {
    for (const [field, expected] of Object.entries({
      description: portable.description,
      author: { name: 'Budna Marketplace AB', url: 'https://budna.se' },
      homepage: 'https://budna.se', repository: 'https://github.com/budna-marketplace/plugins', license: 'MIT',
    })) require(isDeepStrictEqual(manifests[name][field], expected), `invalid or inconsistent ${field}: ${name}`);
  }
  const claude = manifests['.claude-plugin/plugin.json'];
  for (const [field, expected] of Object.entries({
    privacyPolicyUrl: 'https://legal.budna.se/privacy-policy',
    supportUrl: 'https://connect.budna.se/contact-us',
    termsOfServiceUrl: 'https://legal.budna.se/terms-of-service',
    documentationUrl: 'https://github.com/budna-marketplace/plugins',
  })) require(claude[field] === expected, `Claude ${field} required`);
  fileReference(files, claude.icon);
  const codex = manifests['.codex-plugin/plugin.json'];
  require(codex.skills === './skills/', 'Codex must use the shared skills directory');
  fileReference(files, codex.skills, true);
  require(['./.mcp.json', './mcp.json'].includes(codex.mcpServers), 'Codex must reference a bundled MCP configuration');
  fileReference(files, codex.mcpServers);
  const ui = codex.interface;
  require(object(ui), 'Codex interface required');
  require(typeof ui.shortDescription === 'string' && ui.shortDescription.trim() && [...ui.shortDescription].length <= 30,
    'OpenAI shortDescription must contain 1 to 30 characters');
  for (const [field, expected] of Object.entries({
    websiteURL: 'https://budna.se', supportURL: 'https://connect.budna.se/contact-us',
    privacyPolicyURL: 'https://legal.budna.se/privacy-policy', termsOfServiceURL: 'https://legal.budna.se/terms-of-service',
  })) require(ui[field] === expected, `OpenAI ${field} required`);
  require(isDeepStrictEqual(ui.capabilities, ['Read']), 'Codex must describe only the public read capability');
  for (const field of ['composerIcon', 'logo']) fileReference(files, ui[field]);
  const extensions = codex.extensions;
  require(object(extensions) && keys(extensions, ['com.openai']), 'OpenAI review extension required');
  const openai = extensions['com.openai'];
  require(object(openai) && keys(openai, ['review']), 'OpenAI review metadata required');
  const review = openai.review;
  require(object(review) && keys(review, ['test_cases']), 'OpenAI review cases required');
  const cases = review.test_cases;
  require(object(cases) && keys(cases, ['positive', 'negative']), 'OpenAI positive and negative review cases required');
  for (const [kind, count] of [['positive', 5], ['negative', 3]] as const) {
    require(Array.isArray(cases[kind]) && cases[kind].length === count, `OpenAI review requires exactly ${count} ${kind} cases`);
    for (const item of cases[kind]) {
      const fields = ['description', 'prompt', 'expected_behavior', ...(kind === 'positive' ? ['tools_triggered'] : [])];
      require(object(item) && keys(item, fields), `invalid OpenAI ${kind} review case fields`);
      require(fields.every(field => typeof item[field] === 'string' && item[field].trim()), `nonempty OpenAI ${kind} review case fields required`);
    }
  }
  require(isDeepStrictEqual(readJson(files, '.mcp.json'), { mcpServers: { budna: { type: 'http', url: PUBLIC_ENDPOINT } } }),
    'compatibility MCP must use only the public endpoint without credentials');
  require(isDeepStrictEqual(readJson(files, 'mcp.json'), {
    $schema: MCP_SCHEMA, mcpServers: { budna: { type: 'streamable-http', url: PUBLIC_ENDPOINT } },
  }), 'portable MCP schema and public endpoint required; credentials are forbidden');
  require(isDeepStrictEqual(manifests['gemini-extension.json'].mcpServers, { budna: { httpUrl: PUBLIC_ENDPOINT } }),
    'Gemini must use only the public endpoint without credentials');
  const catalog = readJson(files, '.claude-plugin/marketplace.json');
  require(catalog.name === 'budna-marketplace' && object(catalog.owner) && catalog.owner.name === 'Budna Marketplace AB', 'invalid marketplace identity');
  const entries = catalog.plugins;
  require(Array.isArray(entries) && entries.length === 1 && object(entries[0]) && entries[0].name === 'budna'
    && entries[0].source === './' && (Object.hasOwn(entries[0], 'version') ? entries[0].version : version) === version,
  'marketplace must reference the bundled plugin at its release version');
  require(keys(entries[0], ['name', 'source', 'version'], false), 'marketplace overrides are forbidden');
  require(isDeepStrictEqual(new Set([...files.keys()].filter(name => name.startsWith('skills/')).map(name => name.split('/')[1])), SKILLS),
    'exactly the six Recommerce skill folders are required');
  for (const skill of SKILLS) {
    for (const name of ['SKILL.md', 'LICENSE']) require(files.has(`skills/${skill}/${name}`), `missing ${skill}/${name}`);
    let text: string;
    try { text = decoder.decode(files.get(`skills/${skill}/SKILL.md`)!); }
    catch { throw new Error(`invalid skill text: ${skill}`); }
    const frontmatter = /^---\r?\n(.*?)\r?\n---(?:\r?\n|$)/s.exec(text);
    require(frontmatter, `skill frontmatter required: ${skill}`);
    require(new RegExp(`^name: ${skill}\\s*$`, 'm').test(frontmatter[1]), `skill name does not match directory: ${skill}`);
    require(/^description:\s*\S/m.test(frontmatter[1]), `skill description required: ${skill}`);
  }
}

function collectRuntime(root: string): Snapshot {
  require(!existsSync(join(root, '.gitmodules')), 'submodules are not allowed');
  if (existsSync(join(root, '.git'))) {
    const tracked = execFileSync('git', ['-C', root, 'ls-files', '--stage'], { encoding: 'utf8' });
    require(!tracked.split('\n').some(line => line.startsWith('160000 ')), 'submodules are not allowed');
  }
  const paths = [...RUNTIME_FILES].map(name => join(root, name));
  function walk(directory: string): void {
    require(lstatSync(directory).isDirectory(), `regular directory required: ${relative(root, directory)}`);
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const info = lstatSync(path);
      require(!info.isSymbolicLink(), `symlinks are not allowed: ${relative(root, path)}`);
      if (info.isDirectory()) walk(path);
      else if (name !== '.DS_Store') paths.push(path);
    }
  }
  for (const directory of ['assets', 'skills']) walk(join(root, directory));
  require(paths.length <= MAX_FILES, 'too many runtime files');
  const files: Snapshot = new Map();
  let total = 0;
  for (const path of paths) {
    const name = relative(root, path).split(sep).join('/');
    for (let parent = dirname(path); parent !== root; parent = dirname(parent)) {
      require(!lstatSync(parent).isSymbolicLink(), `symlinks are not allowed: ${name}`);
    }
    const info = lstatSync(path);
    require(info.isFile(), `regular file required: ${name}`);
    total += info.size;
    require(info.size <= MAX_FILE_BYTES && total <= MAX_TOTAL_BYTES, `oversized payload: ${name}`);
    files.set(name, readFileSync(path));
  }
  return files;
}

function check(root: string, tag?: string): { files: Snapshot; tag: string } {
  const files = collectRuntime(root);
  tag ??= `v${readJson(files, 'plugin.json').version ?? ''}`;
  validateSnapshot(files, tag);
  return { files, tag };
}

function zipBytes(files: Snapshot): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const name of [...files.keys()].sort()) {
    const content = files.get(name)!;
    const encoded = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(33, 12);
    local.writeUInt32LE(crc32(content), 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(encoded.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(0x0314, 4);
    local.copy(central, 6, 4, 30);
    central.writeUInt32LE((0o100644 * 0x10000) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    localParts.push(local, encoded, content);
    centralParts.push(central, encoded);
    offset += local.length + encoded.length + content.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, end]);
}

function targetSnapshot(files: Snapshot, target: string): Snapshot {
  require(TARGETS.includes(target), `unknown target: ${target}`);
  const result = new Map([...files].filter(([name]) => TARGET_FILES[target].has(name) || COMMON_FILES.has(name)
    || name.startsWith('assets/') || name.startsWith('skills/')));
  if (target === 'claude') result.delete('assets/icon.svg');
  if (target === 'openai') {
    const mcp = readJson(result, 'mcp.json');
    mcp.mcpServers.budna.extensions = { 'com.openai': { auth: { type: 'none' } } };
    result.set('mcp.json', Buffer.from(`${JSON.stringify(mcp, null, 2)}\n`));
  }
  return result;
}

export const digest = (content: Buffer): string => createHash('sha256').update(content).digest('hex');

function writeFile(path: string, content: Buffer): void {
  const parent = dirname(path);
  require(!lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink(), 'output directory cannot be a symlink');
  mkdirSync(parent, { recursive: true });
  const info = lstatSync(path, { throwIfNoEntry: false });
  require(!info || info.isFile(), `output must be a regular file: ${path}`);
  const temporary = join(parent, `.release-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

function build(root: string, tag: string, out: string): void {
  const { files } = check(root, tag);
  const archives = new Map([[archiveName(tag), zipBytes(files)],
    ...TARGETS.map(target => [archiveName(tag, target), zipBytes(targetSnapshot(files, target))] as const)]);
  for (const [name, content] of archives) writeFile(join(out, name), content);
  writeFile(join(out, 'SHA256SUMS'), Buffer.from([...archives.keys()].sort().map(name => `${digest(archives.get(name)!)}  ${name}\n`).join('')));
}

export function readChecksums(source: string | Buffer, tag: string): Map<string, string> {
  if (typeof source === 'string') {
    const info = lstatSync(source);
    require(info.isFile() && info.size <= 4096, 'invalid checksum file');
  }
  const text = Buffer.isBuffer(source) ? source : readFileSync(source);
  require(text.length <= 4096, 'invalid checksum file');
  require(!text.some(byte => byte > 127), 'invalid SHA256SUMS line');
  const checksums = new Map<string, string>();
  const lines = text.toString('ascii').split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9.\-]+)$/.exec(line);
    require(match, 'invalid SHA256SUMS line');
    require(!checksums.has(match[2]), 'duplicate checksum entry');
    checksums.set(match[2], match[1]);
  }
  require(isDeepStrictEqual(new Set(checksums.keys()), assetNames(tag)), 'SHA256SUMS must list exactly the seven release ZIPs');
  return checksums;
}

export function readZip(content: Buffer): Snapshot {
  function slice(offset: number, size: number): Buffer {
    require(offset >= 0 && size >= 0 && offset + size <= content.length, 'truncated ZIP entry');
    return content.subarray(offset, offset + size);
  }
  let end = content.length - 22;
  while (end >= Math.max(0, content.length - 65557)) {
    if (content.readUInt32LE(end) === 0x06054b50 && end + 22 + content.readUInt16LE(end + 20) === content.length) break;
    end--;
  }
  require(end >= Math.max(0, content.length - 65557), 'invalid ZIP directory');
  const footer = slice(end, 22);
  require(footer.readUInt16LE(4) === 0 && footer.readUInt16LE(6) === 0
    && footer.readUInt16LE(8) === footer.readUInt16LE(10), 'multi-disk ZIP is unsupported');
  const count = footer.readUInt16LE(10);
  require(count <= MAX_FILES, 'too many ZIP entries');
  let offset = footer.readUInt32LE(16);
  require(offset + footer.readUInt32LE(12) === end, 'invalid ZIP directory size');
  const files: Snapshot = new Map();
  const ranges: [number, number][] = [];
  let total = 0;
  for (let index = 0; index < count; index++) {
    const central = slice(offset, 46);
    require(central.readUInt32LE(0) === 0x02014b50, 'invalid ZIP directory entry');
    require(central.readUInt16LE(6) <= 20, 'unsupported ZIP version');
    const flags = central.readUInt16LE(8);
    const method = central.readUInt16LE(10);
    const size = central.readUInt32LE(24);
    const compressed = central.readUInt32LE(20);
    const nameBytes = slice(offset + 46, central.readUInt16LE(28));
    const name = decoder.decode(nameBytes);
    safePath(name);
    require(!files.has(name), 'duplicate ZIP entry');
    const mode = (central.readUInt32LE(38) >>> 16) & 0o170000;
    require((mode === 0 || mode === 0o100000) && !name.endsWith('/'), `ZIP entry must be a regular file: ${name}`);
    require(size > 0 && size <= MAX_FILE_BYTES, `empty or oversized ZIP entry: ${name}`);
    total += size;
    require(total <= MAX_TOTAL_BYTES, 'ZIP payload too large');
    require(!(flags & (1 | 0x20 | 0x40 | 0x2000)) && [0, 8].includes(method), 'unsupported ZIP encoding');
    require(central.readUInt16LE(34) === 0, 'multi-disk ZIP is unsupported');
    const localOffset = central.readUInt32LE(42);
    const local = slice(localOffset, 30);
    require(local.readUInt32LE(0) === 0x04034b50 && local.readUInt16LE(6) === flags
      && local.readUInt16LE(8) === method && local.readUInt16LE(4) === central.readUInt16LE(6), 'ZIP local header mismatch');
    require((flags & 8) || (local.readUInt32LE(14) === central.readUInt32LE(16)
      && local.readUInt32LE(18) === compressed && local.readUInt32LE(22) === size), 'ZIP local size or CRC mismatch');
    require(slice(localOffset + 30, local.readUInt16LE(26)).equals(nameBytes), 'ZIP local filename mismatch');
    const dataOffset = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    let dataEnd = dataOffset + compressed;
    if (flags & 8) {
      const start = slice(dataEnd, 4).readUInt32LE(0) === 0x08074b50 ? dataEnd + 4 : dataEnd;
      const descriptor = slice(start, 12);
      require(descriptor.readUInt32LE(0) === central.readUInt32LE(16) && descriptor.readUInt32LE(4) === compressed
        && descriptor.readUInt32LE(8) === size, 'ZIP data descriptor mismatch');
      dataEnd = start + 12;
    }
    require(dataEnd <= footer.readUInt32LE(16), 'ZIP entry overlaps directory');
    require(!ranges.some(([start, end]) => localOffset < end && dataEnd > start), 'overlapping ZIP entries');
    ranges.push([localOffset, dataEnd]);
    const encoded = slice(dataOffset, compressed);
    const decoded = method === 0 ? encoded : inflateRawSync(encoded, { maxOutputLength: MAX_FILE_BYTES });
    require(decoded.length === size && crc32(decoded) === central.readUInt32LE(16), 'ZIP entry size or CRC mismatch');
    files.set(name, decoded);
    offset += 46 + central.readUInt16LE(28) + central.readUInt16LE(30) + central.readUInt16LE(32);
  }
  require(offset === end, 'invalid ZIP directory size');
  return files;
}

function loadRelease(source: string, checksumsPath: string, tag: string): { files: Snapshot; checksums: Map<string, string> } {
  const checksums = readChecksums(checksumsPath, tag);
  require(basename(source) === archiveName(tag), 'unexpected universal ZIP name');
  const info = lstatSync(source);
  require(info.isFile() && info.size <= MAX_ARCHIVE_BYTES, 'universal ZIP must be a bounded regular file');
  const content = readFileSync(source);
  require(digest(content) === checksums.get(basename(source)), 'universal ZIP checksum mismatch');
  const files = readZip(content);
  validateSnapshot(files, tag);
  return { files, checksums };
}

function exportTarget(tag: string, target: string, source: string, checksumsPath: string, out: string): void {
  const { files, checksums } = loadRelease(source, checksumsPath, tag);
  const name = archiveName(tag, target);
  const content = zipBytes(targetSnapshot(files, target));
  require(digest(content) === checksums.get(name), `derived target checksum mismatch: ${target}`);
  writeFile(join(out, name), content);
  writeFile(join(out, `${name}.sha256`), Buffer.from(`${digest(content)}  ${name}\n`));
}

function verify(tag: string, directory: string): void {
  require(isDeepStrictEqual(new Set(readdirSync(directory)), new Set([...assetNames(tag), 'SHA256SUMS'])),
    'release directory must contain exactly seven ZIPs and SHA256SUMS');
  const { files, checksums } = loadRelease(join(directory, archiveName(tag)), join(directory, 'SHA256SUMS'), tag);
  for (const target of TARGETS) {
    const name = archiveName(tag, target);
    const path = join(directory, name);
    const info = lstatSync(path);
    require(info.isFile() && info.size <= MAX_ARCHIVE_BYTES, `target ZIP must be a bounded regular file: ${name}`);
    require(digest(readFileSync(path)) === checksums.get(name) && checksums.get(name) === digest(zipBytes(targetSnapshot(files, target))),
      `target ZIP checksum mismatch: ${name}`);
  }
}

function main(): void {
  const command = process.argv[2];
  const argumentsByCommand: Record<string, string[]> = {
    check: ['tag'], build: ['tag', 'out'], verify: ['tag', 'directory'],
    export: ['tag', 'target', 'source', 'checksums', 'out'],
  };
  require(Object.hasOwn(argumentsByCommand, command), 'command must be check, build, verify, or export');
  const allowed = argumentsByCommand[command];
  const { values } = parseArgs({ args: process.argv.slice(3), options: Object.fromEntries(allowed.map(name => [name, { type: 'string' as const }])) });
  for (const name of allowed) require(command === 'check' || values[name], `--${name} is required`);
  if (command === 'check') console.log(`Validated Budna ${check(ROOT, values.tag).tag}`);
  else if (command === 'build') {
    build(ROOT, values.tag!, resolve(values.out!));
    console.log(`Built seven release ZIPs and SHA256SUMS in ${values.out}`);
  } else if (command === 'verify') {
    verify(values.tag!, resolve(values.directory!));
    console.log(`Verified Budna ${values.tag} release assets`);
  } else {
    exportTarget(values.tag!, values.target!, resolve(values.source!), resolve(values.checksums!), resolve(values.out!));
    console.log(`Exported ${archiveName(values.tag!, values.target)} from the verified release snapshot`);
  }
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) { console.error(`release: ${error instanceof Error ? error.message : error}`); process.exitCode = 1; }
}
