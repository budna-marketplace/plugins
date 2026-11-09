#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { archiveName, digest, readChecksums, readZip, releaseVersion } from './release.mts';

type Environment = Record<string, string | undefined>;
type Json = Record<string, any>;
export type GitApi = (method: 'GET' | 'POST' | 'PATCH', path: string, body?: Json) => unknown;
const REPOSITORY = 'budna-marketplace/plugins';
const PREFIX = `repos/${REPOSITORY}/git`;
const REF = 'refs/heads/claude';
const SKILLS = ['recommerce-buy', 'recommerce-collect', 'recommerce-inspect', 'recommerce-keep', 'recommerce-kits', 'recommerce-second-look'];
const FILES = new Set([
  '.claude-plugin/plugin.json', '.mcp.json', 'LICENSE', 'README.md', 'assets/icon.png',
  'gemini-extension.json', 'mcp.json', 'plugin.json',
  ...SKILLS.flatMap(name => [`skills/${name}/SKILL.md`, `skills/${name}/LICENSE`]),
  'skills/recommerce-buy/references/budna.md', 'skills/recommerce-buy/references/discovery.md',
]);
const LIMIT = 16 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });

function require(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function object(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function sha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.exec(value)?.[0] === value;
}
function required(env: Environment, key: string): string {
  const value = env[key];
  require(typeof value === 'string' && value.length > 0, `${key} is required`);
  return value;
}
function boundedFile(path: string, limit: number): Buffer {
  const stat = lstatSync(path);
  require(stat.isFile() && stat.size > 0 && stat.size <= limit, 'bounded regular release file required');
  const bytes = readFileSync(path);
  require(bytes.length > 0 && bytes.length <= limit, 'release file size changed');
  return bytes;
}
function json(bytes: Buffer): Json {
  const value: unknown = JSON.parse(decoder.decode(bytes));
  require(object(value), 'runtime JSON object required');
  return value;
}
function blobSha(bytes: Buffer): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}
function versionCompare(left: string, right: string): number {
  const a = releaseVersion(`v${left}`).split('.').map(BigInt), b = releaseVersion(`v${right}`).split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

export function validateClaudeRuntime(files: Map<string, Buffer>, expectedVersion?: string): string {
  require(files.size === FILES.size && [...files.keys()].every(name => FILES.has(name)), 'Claude runtime must contain only the exact supported runtime files');
  let total = 0;
  for (const [name, bytes] of files) {
    require(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 4 * 1024 * 1024, 'invalid runtime file size');
    total += bytes.length;
    if (name === 'assets/icon.png') {
      require(bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        && bytes.readUInt32BE(8) === 13 && bytes.subarray(12, 16).equals(Buffer.from('IHDR', 'ascii'))
        && bytes.readUInt32BE(16) >= 512 && bytes.readUInt32BE(16) <= 2048
        && bytes.readUInt32BE(16) === bytes.readUInt32BE(20), 'runtime icon must be a square 512–2048 PNG');
    } else {
      const text = decoder.decode(bytes);
      require(!text.includes('\0') && !text.includes('#!'), 'runtime text must be UTF-8 without NUL or a shebang');
    }
  }
  require(total <= LIMIT, 'runtime tree exceeds size limit');
  const manifest = json(files.get('.claude-plugin/plugin.json')!);
  require(manifest.name === 'budna' && typeof manifest.version === 'string', 'Budna Claude manifest required');
  releaseVersion(`v${manifest.version}`);
  if (expectedVersion !== undefined) require(manifest.version === expectedVersion, 'Claude runtime version differs from release tag');
  for (const name of ['plugin.json', 'gemini-extension.json']) require(json(files.get(name)!).version === manifest.version, 'runtime manifest versions differ');
  require(manifest.icon === './assets/icon.png', 'Claude runtime icon must reference PNG');
  for (const name of ['.mcp.json', 'mcp.json']) {
    const config = json(files.get(name)!);
    require(object(config.mcpServers) && Object.keys(config.mcpServers).join() === 'budna', 'only public Budna MCP is allowed');
    const server = config.mcpServers.budna;
    require(object(server) && Object.keys(server).sort().join() === 'type,url'
      && server.url === 'https://api.budna.se/mcp' && server.type === (name === '.mcp.json' ? 'http' : 'streamable-http'), 'public Budna MCP configuration changed');
  }
  return manifest.version;
}

const defaultApi: GitApi = (method, path, body) => {
  try {
    const text = execFileSync('gh', ['api', path, '--method', method, '-H', 'Accept: application/vnd.github+json',
      '-H', 'X-GitHub-Api-Version: 2026-03-10', ...(body ? ['--input', '-'] : [])], {
      input: body ? JSON.stringify(body) : undefined, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(text);
  } catch { throw new Error(`GitHub ${method} request failed`); }
};

function currentHead(api: GitApi): string | undefined {
  const refs = api('GET', `${PREFIX}/matching-refs/heads/claude`);
  require(Array.isArray(refs) && refs.length < 1000 && refs.every(ref => object(ref) && typeof ref.ref === 'string'
    && object(ref.object) && ref.object.type === 'commit' && sha(ref.object.sha)), 'invalid Claude reference lookup');
  const exact = refs.filter(ref => ref.ref === REF);
  require(exact.length <= 1, 'duplicate Claude branch reference');
  return exact[0]?.object.sha;
}
function unchangedHead(api: GitApi, expected: string | undefined): void {
  require(currentHead(api) === expected, 'Claude branch moved during publication');
}
function commitTree(api: GitApi, commit: string): string {
  const value = api('GET', `${PREFIX}/commits/${commit}`);
  require(object(value) && value.sha === commit && object(value.tree) && sha(value.tree.sha), 'invalid runtime commit response');
  return value.tree.sha;
}
function treeFiles(api: GitApi, tree: string): Map<string, Buffer> {
  const value = api('GET', `${PREFIX}/trees/${tree}?recursive=1`);
  require(object(value) && value.sha === tree && value.truncated === false && Array.isArray(value.tree) && value.tree.length <= 256, 'invalid or truncated runtime tree');
  const directories = new Set([...FILES].flatMap(name => name.split('/').slice(0, -1).map((_, i) => name.split('/').slice(0, i + 1).join('/'))));
  const result = new Map<string, Buffer>();
  const seen = new Set<string>();
  let total = 0;
  for (const entry of value.tree) {
    require(object(entry) && typeof entry.path === 'string' && !seen.has(entry.path) && sha(entry.sha), 'invalid or duplicate runtime tree entry');
    seen.add(entry.path);
    if (entry.type === 'tree') {
      require(entry.mode === '040000' && directories.has(entry.path), 'unexpected runtime directory');
      continue;
    }
    require(entry.type === 'blob' && entry.mode === '100644' && FILES.has(entry.path)
      && Number.isSafeInteger(entry.size) && entry.size > 0 && entry.size <= 4 * 1024 * 1024, 'unexpected runtime file, mode or size');
    total += entry.size;
    require(total <= LIMIT, 'runtime tree exceeds size limit');
    const blob = api('GET', `${PREFIX}/blobs/${entry.sha}`);
    require(object(blob) && blob.sha === entry.sha && blob.encoding === 'base64' && blob.size === entry.size
      && typeof blob.content === 'string' && blob.content.length <= 6 * 1024 * 1024, 'invalid runtime blob response');
    const encoded = blob.content.replace(/[\r\n]/g, ''), bytes = Buffer.from(encoded, 'base64');
    require(bytes.toString('base64') === encoded && bytes.length === entry.size && blobSha(bytes) === entry.sha, 'runtime blob bytes or identity changed');
    result.set(entry.path, bytes);
  }
  validateClaudeRuntime(result);
  return result;
}
function identical(actual: Map<string, Buffer>, expected: Map<string, Buffer>): void {
  require(actual.size === expected.size && [...expected].every(([name, bytes]) => actual.get(name)?.equals(bytes)), 'runtime branch bytes differ from verified Claude ZIP');
}

export function publishClaudeRuntime(source: string, checksumsPath: string, env: Environment = process.env, api: GitApi = defaultApi) {
  require(required(env, 'GITHUB_REPOSITORY') === REPOSITORY, 'Claude runtime publication is restricted to the canonical repository');
  const tag = required(env, 'RELEASE_TAG'), version = releaseVersion(tag), sourceCommit = required(env, 'RELEASE_COMMIT');
  require(sha(sourceCommit), 'invalid release source commit');
  const expectedChecksums = required(env, 'CHECKSUMS_SHA256');
  const checksumBytes = boundedFile(checksumsPath, 4096);
  require(/^[0-9a-f]{64}$/.exec(expectedChecksums)?.[0] === expectedChecksums
    && digest(checksumBytes) === expectedChecksums, 'checksums differ from verified tagged source');
  const checksums = readChecksums(checksumBytes, tag), bytes = boundedFile(source, LIMIT);
  require(basename(source) === archiveName(tag, 'claude') && checksums.get(archiveName(tag, 'claude')) === digest(bytes), 'Claude ZIP differs from verified release checksum');
  const files = readZip(bytes);
  validateClaudeRuntime(files, version);
  const head = currentHead(api);
  if (head) {
    const previous = treeFiles(api, commitTree(api, head)), previousVersion = validateClaudeRuntime(previous);
    const order = versionCompare(previousVersion, version);
    require(order <= 0, 'Claude runtime downgrade is forbidden');
    if (order === 0) {
      identical(previous, files);
      unchangedHead(api, head);
      return { status: 'unchanged', commit: head, version, files: files.size, archiveSha256: digest(bytes) };
    }
  }
  unchangedHead(api, head);
  const entries = [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, content]) => {
    const result = api('POST', `${PREFIX}/blobs`, { content: content.toString('base64'), encoding: 'base64' });
    require(object(result) && result.sha === blobSha(content), 'created runtime blob differs');
    return { path, mode: '100644', type: 'blob', sha: result.sha };
  });
  const tree = api('POST', `${PREFIX}/trees`, { tree: entries });
  require(object(tree) && sha(tree.sha), 'invalid created runtime tree');
  identical(treeFiles(api, tree.sha), files);
  unchangedHead(api, head);
  const parents = head ? [head] : [];
  const commit = api('POST', `${PREFIX}/commits`, {
    message: `Publish Claude runtime ${tag}\n\nSource commit: ${sourceCommit}\nRelease tag: ${tag}\nClaude ZIP SHA256: ${digest(bytes)}\n`,
    tree: tree.sha, parents,
  });
  require(object(commit) && sha(commit.sha) && object(commit.tree) && commit.tree.sha === tree.sha
    && Array.isArray(commit.parents) && commit.parents.length === parents.length
    && commit.parents.every((parent: unknown, index: number) => object(parent) && parent.sha === parents[index]), 'created runtime commit differs');
  unchangedHead(api, head);
  const updated = head ? api('PATCH', `${PREFIX}/refs/heads/claude`, { sha: commit.sha, force: false })
    : api('POST', `${PREFIX}/refs`, { ref: REF, sha: commit.sha });
  require(object(updated) && updated.ref === REF && object(updated.object) && updated.object.type === 'commit'
    && updated.object.sha === commit.sha, 'Claude branch update response differs');
  unchangedHead(api, commit.sha);
  identical(treeFiles(api, commitTree(api, commit.sha)), files);
  unchangedHead(api, commit.sha);
  return { status: 'published', commit: commit.sha, version, files: files.size, archiveSha256: digest(bytes) };
}

function main(): void {
  const { values, positionals } = parseArgs({ options: { source: { type: 'string' }, checksums: { type: 'string' }, help: { type: 'boolean' } }, allowPositionals: true });
  if (values.help) { console.log('claude-runtime.mts publish --source CLAUDE_ZIP --checksums SHA256SUMS'); return; }
  require(positionals.length === 1 && positionals[0] === 'publish' && values.source && values.checksums, 'publish --source and --checksums are required');
  console.log(JSON.stringify(publishClaudeRuntime(values.source, values.checksums)));
}
if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`claude-runtime: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
}
