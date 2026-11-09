#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { archiveName, digest, releaseVersion, TARGETS } from './release.mts';

type Environment = Record<string, string | undefined>;
export type GhRunner = (args: string[]) => string;
type Release = { databaseId: number; tagName: string; isDraft: boolean; isPrerelease: boolean; assets?: { name: string }[] };
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const FIELDS = 'databaseId,isDraft,isPrerelease,tagName,assets';
const NOTES = 'Universal Budna plugin package and SHA-256 checksums.\n\n'
  + 'Publish this draft from GitHub to request the six environment-gated platform exports. '
  + 'Platform assets are published after their environments approve. '
  + 'Directory listings require separate submission and provider review.\n';

function require(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function required(env: Environment, key: string): string {
  const value = env[key];
  require(typeof value === 'string' && value.length > 0, `${key} is required`);
  return value;
}

function tagFrom(env: Environment): string {
  const tag = required(env, 'RELEASE_TAG');
  releaseVersion(tag);
  return tag;
}

function repositoryFrom(env: Environment): string {
  const repository = required(env, 'GITHUB_REPOSITORY');
  require(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.exec(repository)?.[0] === repository, 'invalid repository');
  return repository;
}

function regularBytes(path: string, limit: number): Buffer {
  const stat = lstatSync(path);
  require(stat.isFile() && stat.size > 0 && stat.size <= limit, `bounded regular file required: ${basename(path)}`);
  const bytes = readFileSync(path);
  require(bytes.length > 0 && bytes.length <= limit, `oversized asset: ${basename(path)}`);
  return bytes;
}

const defaultRunner: GhRunner = args => execFileSync('gh', args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024,
});

function gh(repository: string, args: string[], runner: GhRunner): string {
  return runner([...args, '--repo', repository]);
}

function parseRelease(text: string, tag: string, assetsRequired: boolean): Release {
  const value = JSON.parse(text) as Release;
  require(value && typeof value === 'object' && !Array.isArray(value)
    && Number.isSafeInteger(value.databaseId) && value.databaseId > 0
    && value.tagName === tag && typeof value.isDraft === 'boolean'
    && typeof value.isPrerelease === 'boolean', 'Release identity or publication state changed');
  if (assetsRequired) {
    require(Array.isArray(value.assets) && value.assets.every(asset => asset && typeof asset.name === 'string'),
      'invalid release asset list');
    require(new Set(value.assets.map(asset => asset.name)).size === value.assets.length, 'duplicate release asset name');
  }
  return value;
}

function assertPublished(release: Release, env: Environment): void {
  const id = required(env, 'RELEASE_ID');
  require(/^[1-9][0-9]*$/.test(id) && !release.isDraft && !release.isPrerelease
    && String(release.databaseId) === id, 'Release identity or publication state changed');
}

export function fingerprint(directory: string, env: Environment = process.env): Record<string, string> {
  const tag = tagFrom(env);
  return {
    archive_sha256: digest(regularBytes(join(directory, archiveName(tag)), MAX_ARCHIVE_BYTES)),
    checksums_sha256: digest(regularBytes(join(directory, 'SHA256SUMS'), 4096)),
  };
}

export function verifyDownload(directory: string, env: Environment = process.env): void {
  const actual = fingerprint(directory, env);
  for (const [name, key] of [['archive_sha256', 'ARCHIVE_SHA256'], ['checksums_sha256', 'CHECKSUMS_SHA256']]) {
    const expected = required(env, key);
    require(/^[0-9a-f]{64}$/.test(expected) && actual[name] === expected,
      `Release asset differs from verified tagged source: ${name}`);
  }
}

export function verifyReleaseFile(path: string, env: Environment = process.env): void {
  const release = parseRelease(regularBytes(path, 64 * 1024).toString('utf8'), tagFrom(env), false);
  assertPublished(release, env);
}

function missingAssets(release: Release, paths: string[], tag: string, repository: string, runner: GhRunner): string[] {
  const names = new Set(release.assets!.map(asset => asset.name));
  const missing: string[] = [];
  for (const path of paths) {
    const expected = regularBytes(path, path.endsWith('.zip') ? MAX_ARCHIVE_BYTES : 4096);
    if (!names.has(basename(path))) {
      missing.push(path);
      continue;
    }
    const directory = mkdtempSync(join(tmpdir(), 'budna-release-asset-'));
    try {
      gh(repository, ['release', 'download', tag, '--pattern', basename(path), '--dir', directory], runner);
      const actual = regularBytes(join(directory, basename(path)), path.endsWith('.zip') ? MAX_ARCHIVE_BYTES : 4096);
      require(digest(actual) === digest(expected), `Existing release asset differs: ${basename(path)}`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  return missing;
}

export function prepareDraft(directory: string, env: Environment = process.env, runner: GhRunner = defaultRunner): void {
  const tag = tagFrom(env), repository = repositoryFrom(env);
  verifyDownload(directory, env);
  const listing = JSON.parse(gh(repository, ['release', 'list', '--limit', '1000', '--json', 'tagName'], runner)) as unknown;
  require(Array.isArray(listing) && listing.every(value => value && typeof value === 'object' && typeof value.tagName === 'string'),
    'invalid release lookup');
  const exists = listing.some(value => value.tagName === tag);
  require(exists || listing.length < 1000, 'release lookup limit reached; absence is unknown');
  if (!exists) {
    gh(repository, ['release', 'create', tag, '--verify-tag', '--draft', '--title', tag, '--notes', NOTES], runner);
  }
  const release = parseRelease(gh(repository, ['release', 'view', tag, '--json', FIELDS], runner), tag, true);
  require(!release.isPrerelease, 'A stable release tag cannot refer to a prerelease');
  const paths = [join(directory, archiveName(tag)), join(directory, 'SHA256SUMS')];
  const missing = missingAssets(release, paths, tag, repository, runner);
  require(release.isDraft || missing.length === 0, 'Published release is missing its original draft asset');
  for (const path of missing) {
    const current = parseRelease(gh(repository, ['release', 'view', tag, '--json', FIELDS], runner), tag, true);
    require(current.databaseId === release.databaseId && current.isDraft && !current.isPrerelease,
      'Release identity or publication state changed');
    gh(repository, ['release', 'upload', tag, path], runner);
  }
}

export function publishAssets(directory: string, env: Environment = process.env, runner: GhRunner = defaultRunner): void {
  const tag = tagFrom(env), repository = repositoryFrom(env), target = required(env, 'RELEASE_TARGET');
  require(TARGETS.includes(target), 'unknown release target');
  const release = parseRelease(gh(repository, ['release', 'view', tag, '--json', FIELDS], runner), tag, true);
  assertPublished(release, env);
  const archive = join(directory, archiveName(tag, target));
  const bytes = regularBytes(archive, MAX_ARCHIVE_BYTES);
  const sidecar = `${archive}.sha256`;
  require(regularBytes(sidecar, 4096).equals(Buffer.from(`${digest(bytes)}  ${basename(archive)}\n`, 'ascii')),
    'invalid target checksum sidecar');
  const missing = missingAssets(release, [archive, sidecar], tag, repository, runner);
  for (const path of missing) {
    const current = parseRelease(gh(repository, ['release', 'view', tag, '--json', FIELDS], runner), tag, true);
    assertPublished(current, env);
    gh(repository, ['release', 'upload', tag, path], runner);
  }
}

function main(): void {
  const { values, positionals } = parseArgs({
    options: { directory: { type: 'string' }, file: { type: 'string' }, help: { type: 'boolean' } },
    allowPositionals: true,
  });
  if (values.help) {
    console.log('github-release.mts fingerprint|verify-download|prepare-draft|publish-assets --directory DIR\n'
      + 'github-release.mts verify-release --file FILE');
    return;
  }
  require(positionals.length === 1, 'one release operation is required');
  const command = positionals[0];
  if (command === 'verify-release') {
    require(values.file && !values.directory, '--file is required');
    verifyReleaseFile(values.file);
  } else {
    require(values.directory && !values.file, '--directory is required');
    if (command === 'fingerprint') {
      const fields = fingerprint(values.directory);
      const output = required(process.env, 'GITHUB_OUTPUT');
      require(lstatSync(output).isFile(), 'GITHUB_OUTPUT must be a regular file');
      appendFileSync(output, Object.entries(fields).map(([key, value]) => `${key}=${value}\n`).join(''));
    } else if (command === 'verify-download') verifyDownload(values.directory);
    else if (command === 'prepare-draft') prepareDraft(values.directory);
    else if (command === 'publish-assets') publishAssets(values.directory);
    else throw new Error('unknown release operation');
  }
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(`github-release: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
