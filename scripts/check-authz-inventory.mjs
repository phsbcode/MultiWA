#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverControllerRoutes, inventorySummary, supplementaryEntrypoints,
  validateInventory } from './authz-inventory-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inventoryPath = path.join(root, 'scripts', 'authz-routes.inventory.json');
const update = process.argv.includes('--update');
if (update) {
  const publicSnapshot = JSON.parse(fs.readFileSync(path.join(root,
    'scripts', 'api-routes.snapshot.json'), 'utf8'));
  const routes = discoverControllerRoutes(root);
  let previous = {};
  try { previous = JSON.parse(fs.readFileSync(inventoryPath, 'utf8')); } catch {}
  const inventory = { schemaVersion: 1, reviewedBaseline: previous.reviewedBaseline || '',
    upstreamReference: 'ff51e79dd83da6fd5dee71765dfaf0ea71ae0d24',
    publicSnapshotRouteCount: publicSnapshot.routeCount,
    excludedControllerRoutes: routes.filter(route => route.excludedFromPublicSnapshot).map(route => route.key),
    routes, entrypoints: supplementaryEntrypoints() };
  fs.writeFileSync(inventoryPath, JSON.stringify(inventory, null, 2) + '\n');
  console.log(`Updated ${path.relative(root, inventoryPath)} with ${routes.length} controller routes.`);
  process.exit(0);
}
const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
const errors = validateInventory(root, inventory);
if (errors.length) {
  console.error('Authorization inventory drift detected:');
  errors.forEach(error => console.error('  - ' + error));
  process.exit(1);
}
console.log(JSON.stringify({ status: 'pass', ...inventorySummary(inventory),
  publicSnapshotRouteCount: inventory.publicSnapshotRouteCount,
  excludedControllerRoutes: inventory.excludedControllerRoutes.length }, null, 2));
