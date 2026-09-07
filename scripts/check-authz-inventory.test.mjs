import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
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

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkedInventory = JSON.parse(fs.readFileSync(
  path.join(repositoryRoot, 'scripts/authz-routes.inventory.json'), 'utf8',
));
const batch2b1Routes = [
  'GET /api/v1/messages/profile/:profileId',
  'POST /api/v1/messages/profile/:profileId/media',
  'POST /api/v1/messages/profile/:profileId/resolve-senders',
  'GET /api/v1/conversations',
  'GET /api/v1/conversations/:id/messages',
  'GET /api/v1/groups/profile/:profileId',
];
const conversationMutationRoutes = [
  'PUT /api/v1/conversations/:id/read',
  'PUT /api/v1/conversations/:id/archive',
  'PUT /api/v1/conversations/:id/unarchive',
  'PUT /api/v1/conversations/:id/mute',
  'PUT /api/v1/conversations/:id/pin',
  'DELETE /api/v1/conversations/:id/messages',
  'DELETE /api/v1/conversations/:id',
];
const conversationDetailRoutes = ['GET /api/v1/conversations/:id'];
const protectedTenantRoutes = [
  ...batch2b1Routes,
  ...conversationMutationRoutes,
  ...conversationDetailRoutes,
];

function mutateSource(file, mutation) {
  const originalRead = fs.readFileSync;
  fs.readFileSync = function (candidate, ...args) {
    const value = originalRead.call(this, candidate, ...args);
    return path.resolve(String(candidate)) === path.resolve(file) && typeof value === 'string'
      ? mutation(value) : value;
  };
  try {
    return validateInventory(repositoryRoot, checkedInventory);
  } finally {
    fs.readFileSync = originalRead;
  }
}

function changeTenantDecorator(source, handler, mutation) {
  const handlerIndex = source.indexOf(`async ${handler}(`);
  assert.ok(handlerIndex > 0, `handler ${handler} must exist`);
  const start = source.lastIndexOf('@RequireTenant(', handlerIndex);
  const end = source.indexOf('\n', start);
  assert.ok(start > 0 && end > start, `tenant decorator for ${handler} must exist`);
  return source.slice(0, start) + mutation(source.slice(start, end)) + source.slice(end);
}

test('detects removal of every enforced ownership decorator', () => {
  protectedTenantRoutes.forEach(key => {
    const route = checkedInventory.routes.find(value => value.key === key);
    assert.ok(route, key);
    const errors = mutateSource(path.join(repositoryRoot, route.source), source =>
      changeTenantDecorator(source, route.handler, () => ''));
    assert.ok(errors.includes(`route tenant-check drift: ${key}`), key);
  });
});

test('detects ownership decorators disabled with comments', () => {
  protectedTenantRoutes.forEach(key => {
    const route = checkedInventory.routes.find(value => value.key === key);
    for (const comment of [decorator => `// ${decorator}`, decorator => `/* ${decorator} */`]) {
      const errors = mutateSource(path.join(repositoryRoot, route.source), source =>
        changeTenantDecorator(source, route.handler, comment));
      assert.ok(errors.includes(`route tenant-check drift: ${key}`), key);
    }
  });
});

test('rejects ambiguous tenant metadata syntax on every enforced route', () => {
  protectedTenantRoutes.forEach(key => {
    const route = checkedInventory.routes.find(value => value.key === key);
    const check = route.tenantChecks[0];
    const changes = [
      decorator => decorator.replace(/\s*}\)$/, ", 'optional': true })"),
      decorator => decorator.replace(`key: '${check.key}'`,
        `key: '${check.key}' + 'Wrong'`),
      decorator => decorator.replace(/\s*}\)$/, ', optional: !false })'),
      decorator => decorator.replace(/\s*}\)$/, ', ...extra })'),
      decorator => decorator.replace(/\s*}\)$/, ", key: 'duplicate' })"),
      decorator => decorator.replace(/\s*}\)$/, ', unsupported: true })'),
    ];
    changes.forEach(change => {
      const errors = mutateSource(path.join(repositoryRoot, route.source), source =>
        changeTenantDecorator(source, route.handler, change));
      assert.ok(errors.includes(`route tenant-check drift: ${key}`), key);
    });
  });
});

test('detects weakened tenant selectors on enforced conversation routes', () => {
  [...conversationMutationRoutes, ...conversationDetailRoutes].forEach(key => {
    const route = checkedInventory.routes.find(value => value.key === key);
    const changes = [
      decorator => decorator.replace("resource: 'conversation'", "resource: 'profile'"),
      decorator => decorator.replace("from: 'param'", "from: 'query'"),
      decorator => decorator.replace("key: 'id'", "key: 'otherId'"),
      decorator => decorator.replace(/\s*}\)$/, ', optional: true })'),
    ];
    changes.forEach(change => {
      const errors = mutateSource(path.join(repositoryRoot, route.source), source =>
        changeTenantDecorator(source, route.handler, change));
      assert.ok(errors.includes(`route tenant-check drift: ${key}`), key);
    });
  });
});

test('detects TenantGuard disabled with a comment', () => {
  const key = 'GET /api/v1/messages/profile/:profileId';
  const route = checkedInventory.routes.find(value => value.key === key);
  const errors = mutateSource(path.join(repositoryRoot, route.source), source =>
    source.replace('@UseGuards(JwtOrApiKeyGuard, TenantGuard)',
      '// @UseGuards(JwtOrApiKeyGuard, TenantGuard)'));
  assert.ok(errors.includes(`route guard drift: ${key}`));
});

test('detects removal of TenantGuard from a protected controller', () => {
  const key = 'GET /api/v1/messages/profile/:profileId';
  const route = checkedInventory.routes.find(value => value.key === key);
  const errors = mutateSource(path.join(repositoryRoot, route.source), source =>
    source.replace('@UseGuards(JwtOrApiKeyGuard, TenantGuard)', '@UseGuards(JwtOrApiKeyGuard)'));
  assert.ok(errors.includes(`route guard drift: ${key}`));
});

test('detects TenantGuard removal or commenting for enforced conversation routes', () => {
  [...conversationMutationRoutes, ...conversationDetailRoutes].forEach(key => {
    const route = checkedInventory.routes.find(value => value.key === key);
    for (const replacement of [
      '// @UseGuards(JwtOrApiKeyGuard, TenantGuard)',
      '@UseGuards(JwtOrApiKeyGuard)',
    ]) {
      const errors = mutateSource(path.join(repositoryRoot, route.source), source =>
        source.replace('@UseGuards(JwtOrApiKeyGuard, TenantGuard)', replacement));
      assert.ok(errors.includes(`route guard drift: ${key}`), key);
    }
  });
});
