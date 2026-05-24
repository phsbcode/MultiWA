#!/usr/bin/env node
/**
 * Release gate: API contract drift check.
 *
 * Two layers of validation run on every invocation:
 *
 *   1. Source vs snapshot
 *      Extracts the route table from NestJS controllers in apps/api/src by
 *      reading @Controller(...) and @Get/@Post/@Put/@Patch/@Delete/@Head/
 *      @Options/@All decorators, then compares the extracted list against
 *      scripts/api-routes.snapshot.json.
 *
 *      Controllers carrying @ApiExcludeController() are skipped entirely,
 *      because they are deliberately excluded from the public API surface
 *      (Swagger and docs alike). Individual methods carrying
 *      @ApiExcludeEndpoint() are also skipped.
 *
 *   2. Snapshot vs docs/07-api-specification.md
 *      Parses Markdown table rows shaped like
 *
 *          | `METHOD` | `/path` | description |
 *
 *      Doc paths are normalized to the snapshot shape by:
 *        - prefixing the global prefix (api/v1) when the doc path is relative
 *        - converting {param} to :param (we accept both styles in docs)
 *        - trimming trailing slashes
 *
 *      The check fails if any snapshot route is missing from the docs. Extra
 *      doc rows (rows that do not correspond to a snapshot route) are
 *      reported as a warning, not a hard fail, because they may be SDK or
 *      external endpoints that the docs reference for context.
 *
 * If a controller has changed but the snapshot has not been updated, this
 * script exits 1 with a precise diff. To accept the change, regenerate the
 * snapshot:
 *
 *   node scripts/check-api-contract.mjs --update
 *
 * No server, no Swagger fetch, no credential. Source-only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const API_SRC = path.join(ROOT, 'apps', 'api', 'src');
const SNAPSHOT_PATH = path.join(ROOT, 'scripts', 'api-routes.snapshot.json');
const DOCS_PATH = path.join(ROOT, 'docs', '07-api-specification.md');
const GLOBAL_PREFIX = 'api/v1';

function listControllerFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.turbo') continue;
      out.push(...listControllerFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.controller.ts')) {
      out.push(full);
    }
  }
  return out;
}

function joinPath(...parts) {
  const cleaned = parts
    .filter((p) => p !== undefined && p !== null && p !== '')
    .map((p) => String(p).replace(/^\/+/, '').replace(/\/+$/, ''))
    .filter((p) => p.length > 0);
  return '/' + cleaned.join('/');
}

function extractRoutes(file) {
  const src = fs.readFileSync(file, 'utf8');
  const relPath = path.relative(ROOT, file);

  // Skip whole controller when @ApiExcludeController() is present. This is the
  // same signal Swagger uses to exclude an endpoint from the public spec, and
  // is the convention MultiWA uses (see apps/api/src/root.controller.ts).
  if (/@ApiExcludeController\(\s*\)/.test(src)) {
    return [];
  }

  const controllerMatch = src.match(/@Controller\(\s*['"`]([^'"`]*)['"`]\s*\)/);
  const controllerPrefix = controllerMatch ? controllerMatch[1] : '';
  if (!controllerMatch && !/@Controller\(\s*\)/.test(src)) {
    return [];
  }

  const routes = [];
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const decoratorRe = /@(Get|Post|Put|Patch|Delete|Head|Options|All)\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/;
    const match = line.match(decoratorRe);
    if (!match) continue;

    // Skip individual endpoint when @ApiExcludeEndpoint() decorates the same
    // method. Look at a small window of preceding lines for the marker.
    let excluded = false;
    for (let j = Math.max(0, i - 5); j < i; j++) {
      if (/@ApiExcludeEndpoint\(\s*\)/.test(lines[j])) {
        excluded = true;
        break;
      }
    }
    if (excluded) continue;

    const method = match[1].toUpperCase();
    const subpath = match[2] || '';
    routes.push({
      method,
      path: joinPath(GLOBAL_PREFIX, controllerPrefix, subpath),
      source: relPath,
    });
  }
  return routes;
}

function collectAllRoutes() {
  const files = listControllerFiles(API_SRC);
  const all = [];
  for (const file of files) {
    all.push(...extractRoutes(file));
  }
  all.sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.method < b.method ? -1 : 1;
  });
  return all;
}

function buildSnapshotShape(routes) {
  return {
    generatedFrom: 'apps/api/src/**/*.controller.ts',
    globalPrefix: GLOBAL_PREFIX,
    swaggerPath: 'api/docs',
    note: 'Regenerate with: node scripts/check-api-contract.mjs --update',
    excludedDecorators: ['@ApiExcludeController()', '@ApiExcludeEndpoint()'],
    routeCount: routes.length,
    routes: routes.map((r) => ({ method: r.method, path: r.path })),
  };
}

function loadSnapshot() {
  if (!fs.existsSync(SNAPSHOT_PATH)) return null;
  try {
    const raw = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return { __parseError: err.message };
  }
}

function diffRoutes(currentSnapshot, savedSnapshot) {
  const cur = new Set(currentSnapshot.routes.map((r) => `${r.method} ${r.path}`));
  const saved = new Set(savedSnapshot.routes.map((r) => `${r.method} ${r.path}`));
  const added = [...cur].filter((k) => !saved.has(k)).sort();
  const removed = [...saved].filter((k) => !cur.has(k)).sort();
  return { added, removed };
}

/**
 * Normalize a path string from docs/07-api-specification.md to the same shape
 * the snapshot uses.
 *
 * Rules (kept simple and explicit so the check stays auditable):
 *   - {param} -> :param
 *   - Trim trailing slash unless the path is just "/".
 *   - If the path does not already start with "/api/v1", prefix it.
 *   - Collapse repeated slashes.
 */
function normalizeDocPath(p) {
  let s = p.trim();
  s = s.replace(/\{([^}/]+)\}/g, ':$1');
  s = s.replace(/\/{2,}/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  if (!s.startsWith('/')) s = '/' + s;
  if (!s.startsWith('/' + GLOBAL_PREFIX)) {
    s = '/' + GLOBAL_PREFIX + s;
  }
  return s;
}

/**
 * Extract route entries from docs/07-api-specification.md.
 *
 * The doc is hand-curated Markdown. We only consider rows of shape:
 *
 *   | `METHOD` | `/path` | description |
 *
 * The backticks on both METHOD and PATH are required, which avoids matching
 * unrelated Markdown tables and prose. Code-fenced blocks are skipped.
 */
function extractDocRoutes(docPath) {
  if (!fs.existsSync(docPath)) {
    return { routes: [], error: `Docs file not found at ${path.relative(ROOT, docPath)}` };
  }
  const src = fs.readFileSync(docPath, 'utf8');
  const lines = src.split(/\r?\n/);
  const routes = [];
  let inFence = false;
  const rowRe = /^\|\s*`(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ALL)`\s*\|\s*`([^`]+)`\s*\|/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(rowRe);
    if (!m) continue;
    routes.push({
      method: m[1].toUpperCase(),
      path: normalizeDocPath(m[2]),
      line: i + 1,
    });
  }
  return { routes, error: null };
}

function validateDocsAgainstSnapshot(snapshot, docInfo) {
  if (docInfo.error) {
    return { missingInDocs: [], extraInDocs: [], error: docInfo.error };
  }
  const snapSet = new Set(snapshot.routes.map((r) => `${r.method} ${r.path}`));
  const docSet = new Set(docInfo.routes.map((r) => `${r.method} ${r.path}`));
  const missingInDocs = [...snapSet].filter((k) => !docSet.has(k)).sort();
  const extraInDocs = [...docSet].filter((k) => !snapSet.has(k)).sort();
  return { missingInDocs, extraInDocs, error: null };
}

function main() {
  const args = process.argv.slice(2);
  const wantUpdate = args.includes('--update');
  const wantJson = args.includes('--json');
  const skipDocs = args.includes('--no-docs');

  const routes = collectAllRoutes();
  const current = buildSnapshotShape(routes);

  if (wantUpdate) {
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(current, null, 2) + '\n', 'utf8');
    console.log(`Updated ${path.relative(ROOT, SNAPSHOT_PATH)} with ${current.routeCount} routes.`);
    process.exit(0);
  }

  const saved = loadSnapshot();
  if (saved === null) {
    console.error(`::error::Snapshot not found at ${path.relative(ROOT, SNAPSHOT_PATH)}.`);
    console.error('Generate one with: node scripts/check-api-contract.mjs --update');
    process.exit(1);
  }
  if (saved.__parseError) {
    console.error(`::error::Snapshot at ${path.relative(ROOT, SNAPSHOT_PATH)} is unreadable: ${saved.__parseError}`);
    process.exit(1);
  }
  if (saved.globalPrefix !== current.globalPrefix) {
    console.error(`::error::Global prefix changed: snapshot=${saved.globalPrefix} current=${current.globalPrefix}`);
    console.error('If this is intentional, re-run with --update.');
    process.exit(1);
  }

  const sourceDiff = diffRoutes(current, saved);
  const sourceInSync = sourceDiff.added.length === 0 && sourceDiff.removed.length === 0;

  let docCheck = { missingInDocs: [], extraInDocs: [], error: null };
  let docRouteCount = 0;
  if (!skipDocs) {
    const docInfo = extractDocRoutes(DOCS_PATH);
    docRouteCount = docInfo.routes.length;
    docCheck = validateDocsAgainstSnapshot(saved, docInfo);
  }

  const docsInSync = !docCheck.error && docCheck.missingInDocs.length === 0;
  const overallPass = sourceInSync && docsInSync;

  if (overallPass) {
    if (docCheck.extraInDocs.length) {
      console.warn(`Docs contain ${docCheck.extraInDocs.length} route(s) that do not match the snapshot:`);
      for (const r of docCheck.extraInDocs) console.warn(`  ? ${r}`);
      console.warn('These rows are accepted as docs-only references. If any of them is a real');
      console.warn('endpoint, add it to the controller or remove it from the docs table.');
    }
    if (wantJson) {
      console.log(JSON.stringify({
        status: 'pass',
        sourceRouteCount: current.routeCount,
        snapshotRouteCount: saved.routeCount,
        docRouteCount,
        extraInDocs: docCheck.extraInDocs,
      }, null, 2));
    } else {
      console.log(`API contract is in sync.`);
      console.log(`  source     : ${current.routeCount} routes`);
      console.log(`  snapshot   : ${saved.routeCount} routes`);
      console.log(`  docs/07    : ${docRouteCount} table rows`);
    }
    process.exit(0);
  }

  // FAIL path. Print every dimension that disagrees.
  console.error('API contract drift detected.');

  if (!sourceInSync) {
    console.error('');
    console.error('[1/2] Source vs snapshot drift:');
    if (sourceDiff.added.length) {
      console.error('  Routes present in source but missing from snapshot (likely new endpoints):');
      for (const r of sourceDiff.added) console.error(`    + ${r}`);
    }
    if (sourceDiff.removed.length) {
      console.error('  Routes present in snapshot but missing from source (likely removed endpoints):');
      for (const r of sourceDiff.removed) console.error(`    - ${r}`);
    }
    console.error('  Recovery: update affected controllers/docs, then run:');
    console.error('    pnpm run check:api-contract:update');
  }

  if (!docsInSync) {
    console.error('');
    console.error('[2/2] Snapshot vs docs/07-api-specification.md drift:');
    if (docCheck.error) {
      console.error('  ' + docCheck.error);
    } else {
      console.error(`  Snapshot has ${saved.routeCount} routes, docs table has ${docRouteCount} rows.`);
      if (docCheck.missingInDocs.length) {
        console.error('  Routes missing from docs/07-api-specification.md:');
        for (const r of docCheck.missingInDocs) console.error(`    - ${r}`);
      }
      console.error('  Recovery: add the missing rows to docs/07-api-specification.md');
      console.error('  (use the table shape `| \\`METHOD\\` | \\`/path\\` | description |`),');
      console.error('  then re-run `pnpm run check:api-contract` to verify.');
    }
  }

  if (wantJson) {
    console.log(JSON.stringify({
      status: 'fail',
      sourceDrift: sourceDiff,
      docMissing: docCheck.missingInDocs,
      docExtra: docCheck.extraInDocs,
      docError: docCheck.error,
    }, null, 2));
  }
  process.exit(1);
}

main();
