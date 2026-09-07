import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverControllerRoutes, validateInventory } from './authz-inventory-lib.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multiwa-authz-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'apps/api/src/sample');
  fs.mkdirSync(directory, { recursive: true });
  const source = path.join(directory, 'sample.controller.ts');
  fs.writeFileSync(source, `
@Controller('sample')
@UseGuards(JwtOrApiKeyGuard)
export class SampleController {
  @Get(':id')
  async find(@Param('id') id: string, @Query('profileId') profileId: string) {
    return { id, profileId };
  }
}`);
  const routes = discoverControllerRoutes(root);
  const inventory = { schemaVersion: 1, reviewedBaseline: 'a'.repeat(40),
    publicSnapshotRouteCount: routes.length, routes, entrypoints: [] };
  return { root, source, routes, inventory };
}

function validate(value, discovered) {
  return validateInventory(value.root, value.inventory, discovered, []);
}

test('accepts independently discovered route, handler, selectors and evidence', t => {
  const value = fixture(t);
  assert.equal(validate(value).length, 0);
  assert.deepEqual(value.routes[0].selectors.map(item => [item.location, item.name]),
    [['path', 'id'], ['query', 'profileId']]);
});

test('detects a new source route and a stale deleted route', t => {
  const value = fixture(t);
  fs.writeFileSync(value.source, fs.readFileSync(value.source, 'utf8').replace(/}\s*$/, `
  @Get('second')
  list() { return []; }
}`));
  assert.ok(validate(value).some(error =>
    error.includes('route missing from inventory')));
  fs.writeFileSync(value.source, '@Controller("sample")\nexport class SampleController {}');
  assert.ok(validate(value).some(error =>
    error.includes('stale inventory route')));
});

test('detects wrong handler evidence and an unclassified selector', t => {
  const value = fixture(t);
  value.inventory.routes[0].handler = 'wrongHandler';
  value.inventory.routes[0].selectors[0].namespace = '';
  value.inventory.routes[0].selectors[1].parent = 'missing-parent';
  const errors = validate(value);
  assert.ok(errors.some(error => error.includes('handler evidence')));
  assert.ok(errors.some(error => error.includes('malformed selector')));
  assert.ok(errors.some(error => error.includes('selector parent')));
});

test('records Swagger-excluded routes and rejects duplicate keys', t => {
  const value = fixture(t);
  const text = fs.readFileSync(value.source, 'utf8').replace('@Get', '@ApiExcludeEndpoint()\n  @Get');
  fs.writeFileSync(value.source, text);
  const routes = discoverControllerRoutes(value.root);
  assert.equal(routes[0].excludedFromPublicSnapshot, true);
  value.inventory.routes.push({ ...value.inventory.routes[0] });
  assert.ok(validate(value).some(error =>
    error.includes('duplicate')));
});

test('rejects an intentional public route reclassified as a gap', t => {
  const value = fixture(t);
  value.inventory.routes[0].status = 'intentional-public';
  value.inventory.routes[0].targetAccess = 'organization';
  const errors = validate(value);
  assert.ok(errors.some(error => error.includes('intentional-public')));
});

test('detects a missing supplementary entrypoint', t => {
  const value = fixture(t);
  const expected = [{ key: 'STATIC /synthetic/*', source: 'apps/api/src/main.ts',
    handler: 'synthetic' }];
  const errors = validateInventory(value.root, value.inventory, value.routes, expected);
  assert.ok(errors.some(error => error.includes('supplementary entrypoint missing')));
});
