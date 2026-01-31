#!/usr/bin/env node

// Clean repository artifacts without relying on git.
// This script intentionally removes only known temporary/build outputs.

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

/**
 * @param {string} p
 */
function assertInsideRepo(p) {
  const resolved = path.resolve(p);
  const rootWithSep = repoRoot.endsWith(path.sep) ? repoRoot : repoRoot + path.sep;
  if (!resolved.startsWith(rootWithSep)) {
    throw new Error(`Refusing to operate outside repo root: ${resolved}`);
  }
  return resolved;
}

/**
 * @param {string} absPath
 */
function rel(absPath) {
  return path.relative(repoRoot, absPath) || '.';
}

/**
 * @param {string} absPath
 */
async function lstatOrNull(absPath) {
  try {
    return await fs.lstat(absPath);
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * @param {string} absPath
 * @param {string[]} removed
 */
async function removePath(absPath, removed) {
  const safePath = assertInsideRepo(absPath);
  const st = await lstatOrNull(safePath);
  if (!st) return;

  // Never follow symlinks; remove the link itself.
  const isDir = st.isDirectory() && !st.isSymbolicLink();

  await fs.rm(safePath, { recursive: isDir, force: true });
  removed.push(isDir ? `${rel(safePath)}/` : rel(safePath));
}

/**
 * @param {string} absDir
 * @param {(name: string) => boolean} predicate
 */
async function listMatchingFiles(absDir, predicate) {
  const safeDir = assertInsideRepo(absDir);
  const st = await lstatOrNull(safeDir);
  if (!st || !st.isDirectory() || st.isSymbolicLink()) return [];

  const entries = await fs.readdir(safeDir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!predicate(e.name)) continue;
    out.push(path.join(safeDir, e.name));
  }
  return out;
}

async function main() {
  /** @type {string[]} */
  const removed = [];

  // Root-level artifacts
  const rootTargets = [
    'node_modules',
    '.turbo',
    '.cache',
    'coverage',
  ].map((p) => path.join(repoRoot, p));

  for (const t of rootTargets) {
    await removePath(t, removed);
  }

  // packages/* cleanup
  const packagesDir = path.join(repoRoot, 'packages');
  const packagesStat = await lstatOrNull(packagesDir);
  if (packagesStat && packagesStat.isDirectory() && !packagesStat.isSymbolicLink()) {
    const entries = await fs.readdir(packagesDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const pkgDir = path.join(packagesDir, e.name);

      // Directories with temporary content
      const pkgDirTargets = [
        'node_modules',
        'dist',
        'out',
        '.vscode-test',
        '.turbo',
        '.cache',
        'coverage',
      ].map((p) => path.join(pkgDir, p));

      for (const t of pkgDirTargets) {
        await removePath(t, removed);
      }

      // Generated build info
      await removePath(path.join(pkgDir, 'tsconfig.tsbuildinfo'), removed);
    }
  }

  // Output removed paths
  if (removed.length === 0) {
    console.log('[clean] Nothing to remove.');
    return;
  }

  console.log('[clean] Removed:');
  for (const p of removed.sort((a, b) => a.localeCompare(b))) {
    console.log(`- ${p}`);
  }
  console.log(`[clean] Done. Removed ${removed.length} path(s).`);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.stack || err.message : String(err);
  console.error(`[clean] Failed: ${msg}`);
  process.exitCode = 1;
});
