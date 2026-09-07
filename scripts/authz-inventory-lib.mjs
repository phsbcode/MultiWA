import fs from 'node:fs';
import path from 'node:path';

export const ACCESS_CATEGORIES = new Set([
  'public', 'authenticated-user', 'organization', 'administrative', 'legacy-global',
]);
export const INVENTORY_STATUSES = new Set([
  'protected', 'intentional-public', 'confirmed-gap', 'decision-required',
]);

const HTTP_DECORATOR = /@(Get|Post|Put|Patch|Delete|Head|Options|All)\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/g;
const PUBLIC_AUTH_PATHS = new Set([
  '/api/v1/auth/register', '/api/v1/auth/login', '/api/v1/auth/2fa/verify',
  '/api/v1/auth/refresh',
]);
const INTENTIONAL_PUBLIC_PATHS = new Set(['/api/v1', '/api/v1/health', '/api/v1/health/ready']);

function walk(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith('.controller.ts')) result.push(full);
  }
  return result;
}

function walkTypeScript(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walkTypeScript(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) result.push(full);
  }
  return result;
}

function joinRoute(prefix, route) {
  return ('/' + ['api/v1', prefix, route].filter(Boolean).join('/'))
    .replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
}

function guardNames(text) {
  const result = new Set();
  for (const match of text.matchAll(/@UseGuards\(([^)]*)\)/g)) {
    match[1].split(',').map(value => value.trim()).filter(Boolean).forEach(value => result.add(value));
  }
  return [...result];
}

function tenantChecks(text) {
  const result = [];
  for (const call of text.matchAll(/@RequireTenant\(([\s\S]*?)\)/g)) {
    for (const object of call[1].matchAll(/\{([^}]+)\}/g)) {
      const field = name => object[1].match(new RegExp(
        `\\b${name}\\s*:\\s*['\"]([^'\"]+)['\"]`,
      ))?.[1] || '';
      result.push({ resource: field('resource'), from: field('from'), key: field('key'),
        optional: /\boptional\s*:\s*true\b/.test(object[1]) });
    }
  }
  return result;
}

function methodDetails(source, routeEnd, nextRouteIndex) {
  const segment = source.slice(routeEnd, nextRouteIndex);
  const method = segment.match(/\n\s*(?:public\s+|private\s+|protected\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/);
  if (!method) throw new Error('Route decorator is not followed by a method');
  const methodIndex = routeEnd + (method.index || 0);
  const handler = method[1];
  const block = source.slice(methodIndex, nextRouteIndex);
  const signature = block.match(/^[\s\S]*?\)\s*(?::[^\n{]+)?\s*\{/);
  const header = signature ? signature[0] : block.slice(0, 1500);
  return { handler, methodIndex, header, block };
}

function selectorNamespace(name, type, routePath) {
  const lower = String(name || '').toLowerCase();
  if (lower.includes('profile')) return 'profile-id';
  if (lower.includes('conversation')) return 'conversation-id';
  if (lower.includes('message')) return lower === 'id' && routePath.includes('/messages/:id')
    ? 'database-message-id' : 'provider-or-database-message-id';
  if (lower.includes('group')) return 'group-jid-or-id';
  if (lower.includes('workspace')) return 'workspace-id';
  if (lower.includes('organization')) return 'organization-id';
  if (lower.includes('account')) return 'account-id';
  if (lower === 'to') return 'whatsapp-recipient';
  if (lower === 'jid') return 'whatsapp-jid';
  if (lower === 'chatid') return 'whatsapp-chat-id';
  if (lower === 'participants') return 'whatsapp-participant-list';
  if (lower === 'id') return 'route-resource-id';
  if (type) return 'dto:' + type.replace(/\s+/g, ' ').trim();
  return 'scalar';
}

function resourceField(name) {
  return /^(?:profileId|workspaceId|accountId|organizationId|orgId|conversationId|messageId|quotedMessageId|groupId|userId|roleId|contactId|webhookId|templateId|broadcastId|automationId|sessionId|chatId|jid|to|ids|participants)$/i.test(name);
}

function classBody(source, start) {
  const open = source.indexOf('{', start);
  if (open < 0) return '';
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}' && --depth === 0) return source.slice(open + 1, index);
  }
  return '';
}

function dtoFieldIndex(root) {
  const classes = {};
  for (const file of walkTypeScript(path.join(root, 'apps', 'api', 'src'))) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:export\s+)?class\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+([A-Za-z_$][\w$]*))?/g)) {
      const body = classBody(source, match.index || 0);
      classes[match[1]] = { parent: match[2] || '', fields:
        [...body.matchAll(/^\s*([A-Za-z_$][\w$]*)(\?)?[!:]\s*([^;\n]+)/gm)]
          .map(field => ({ name: field[1], required: !field[2], type: field[3].trim() })) };
    }
  }
  const result = {};
  function resolve(name, seen = new Set()) {
    if (result[name]) return result[name];
    if (!classes[name] || seen.has(name)) return [];
    seen.add(name);
    const inherited = classes[name].parent ? resolve(classes[name].parent, seen) : [];
    result[name] = [...inherited, ...classes[name].fields];
    return result[name];
  }
  Object.keys(classes).forEach(name => resolve(name));
  return result;
}

function selectors(routePath, header, dtoFields) {
  const result = [];
  for (const match of routePath.matchAll(/:([A-Za-z_$][\w$]*)/g)) {
    result.push({ location: 'path', name: match[1], required: true,
      namespace: selectorNamespace(match[1], '', routePath), parent: '' });
  }
  for (const match of header.matchAll(/@(Query|Body)\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)\s*([A-Za-z_$][\w$]*)?(\?)?\s*(?::\s*([^,\n\)]+))?/g)) {
    const location = match[1].toLowerCase();
    const name = match[2] || match[3] || location;
    if (result.some(value => value.location === location && value.name === name)) continue;
    const type = String(match[5] || '').trim();
    if (location === 'query' || match[2]) {
      result.push({ location, name, required: !match[4],
        namespace: selectorNamespace(name, type, routePath), parent: '' });
    }
    if (location !== 'body') continue;
    let fields = dtoFields[type] || [];
    if (!fields.length && type.startsWith('{')) {
      fields = [...type.matchAll(/([A-Za-z_$][\w$]*)(\?)?\s*:\s*([^;}]+)/g)]
        .map(field => ({ name: field[1], required: !field[2], type: field[3].trim() }));
    }
    fields.filter(field => resourceField(field.name)).forEach(field => {
      const fieldName = `${name}.${field.name}`;
      const parentCandidate = result.find(value => value.name === field.name ||
        value.name === `${name}.profileId` || value.name === 'profileId');
      result.push({ location: 'body', name: fieldName, required: field.required,
        namespace: field.name === 'ids' ? 'resource-id-list' :
          selectorNamespace(field.name, field.type, routePath),
        parent: parentCandidate?.name || '' });
    });
  }
  return result;
}

function proposedPermission(routePath, method) {
  if (PUBLIC_AUTH_PATHS.has(routePath) || INTENTIONAL_PUBLIC_PATHS.has(routePath)) return 'public';
  const read = ['GET', 'HEAD', 'OPTIONS'].includes(method) ||
    /\/messages\/profile\/:profileId\/(?:media)$/.test(routePath);
  if (routePath.includes('/messages') || routePath.includes('/conversations')) {
    return read ? 'messages:read' : 'messages:write';
  }
  if (routePath.includes('/contacts')) return read ? 'contacts:read' : 'contacts:write';
  if (routePath.includes('/profiles') || routePath.includes('/groups')) {
    return read ? 'profiles:read' : 'profiles:write';
  }
  if (routePath.includes('/hooks') || routePath.includes('/webhooks')) {
    return read ? 'webhooks:read' : 'webhooks:write';
  }
  if (routePath.includes('/broadcast')) return read ? 'messages:read' : 'broadcast:write';
  return read ? 'authenticated:read' : 'authenticated:write';
}

function clientsFor(routePath, method) {
  const clients = [];
  const paymentRoute =
    (method === 'GET' && /^\/api\/v1\/(?:profiles\/:id\/status|groups\/profile\/:profileId|conversations|conversations\/:id\/messages|conversations\/:id\/messages\/:messageId\/context|messages\/profile\/:profileId)$/.test(routePath)) ||
    (method === 'POST' && /^\/api\/v1\/(?:messages\/profile\/:profileId\/(?:media|resolve-senders)|hooks)$/.test(routePath)) ||
    (method === 'GET' && routePath === '/api/v1/hooks') ||
    (method === 'DELETE' && routePath === '/api/v1/hooks/:id');
  if (paymentRoute) {
    clients.push('dnt-payments-monitor');
  }
  if (/\/dnt-operations(?:\/|$)/.test(routePath)) clients.push('dnt-operations');
  return clients;
}

function serviceReference(root, controllerFile, controllerSource, methodText) {
  const call = methodText.match(/this\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/);
  if (!call) return '';
  const type = controllerSource.match(new RegExp(
    `(?:private|public|protected)\\s+(?:readonly\\s+)?${call[1]}\\s*:\\s*([A-Za-z_$][\\w$]*)`,
  ))?.[1];
  if (!type) return '';
  const escaped = type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const imported = controllerSource.match(new RegExp(
    `import\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}\\s*from\\s*['\"]([^'\"]+)['\"]`,
  ))?.[1];
  if (!imported?.startsWith('.')) return '';
  const candidate = path.resolve(path.dirname(controllerFile), imported + '.ts');
  if (!fs.existsSync(candidate)) return '';
  return `${path.relative(root, candidate).replaceAll(path.sep, '/')}#${call[2]}`;
}

function classify(route, classGuards, methodGuards, methodText, classSource, decoratorText) {
  const guards = [...new Set([...classGuards, ...methodGuards])];
  const protectedByAuth = guards.some(value => /JwtAuthGuard|JwtOrApiKeyGuard/.test(value));
  const administrative = guards.some(value => /RolesGuard|RbacGuard/.test(value));
  const publicTarget = PUBLIC_AUTH_PATHS.has(route.path) || INTENTIONAL_PUBLIC_PATHS.has(route.path);
  let implementedAccess;
  let evidence;
  if (route.source.endsWith('/hooks/hooks.controller.ts')) {
    implementedAccess = 'legacy-global';
    evidence = 'Authenticated global JSON hook registry has no organization or profile owner field.';
  } else if (administrative) {
    implementedAccess = 'administrative';
    evidence = 'Method or class declares an administrative guard.';
  } else if (/@RequireTenant\(/.test(decoratorText)) {
    implementedAccess = 'organization';
    evidence = 'Route declares a tenant resource selector enforced after authentication.';
  } else if (/organizationId|req\.user\.id|request\.user\.id|@Request\(\)/.test(methodText) &&
      /(organizationId|req\.user|request\.user)/.test(methodText)) {
    implementedAccess = 'organization';
    evidence = 'Handler passes authenticated user or organization context into its service/query.';
  } else if (protectedByAuth) {
    implementedAccess = 'authenticated-user';
    evidence = 'Authentication guard is present; no handler-level ownership evidence was found.';
  } else {
    implementedAccess = 'public';
    evidence = 'No HTTP authentication guard applies to this handler.';
  }
  const selfService = /\/api\/v1\/(?:auth(?:\/|$)|api-keys(?:\/|$)|notifications(?:\/|$)|account(?:\/|$))/.test(route.path);
  const administrativeTarget = /\/api\/v1\/(?:rbac|settings|audit)(?:\/|$)/.test(route.path) ||
    (/\/api\/v1\/(?:organizations|workspaces)(?:\/|$)/.test(route.path) &&
      !['GET', 'HEAD', 'OPTIONS'].includes(route.method));
  const targetAccess = publicTarget ? 'public' : administrativeTarget ? 'administrative' :
    selfService ? 'authenticated-user' : 'organization';
  const satisfiesTarget = targetAccess === 'public' ? implementedAccess === 'public' :
    targetAccess === 'authenticated-user' ?
      ['authenticated-user', 'organization', 'administrative'].includes(implementedAccess) :
      targetAccess === 'organization' ? ['organization', 'administrative'].includes(implementedAccess) :
        implementedAccess === 'administrative';
  const status = publicTarget && implementedAccess === 'public' ? 'intentional-public' :
    implementedAccess === 'legacy-global' ? 'decision-required' :
      satisfiesTarget ? 'protected' : 'confirmed-gap';
  const principals = guards.some(value => value.includes('JwtOrApiKeyGuard')) ? ['jwt', 'api-key'] :
    guards.some(value => value.includes('JwtAuthGuard')) ? ['jwt'] : ['unauthenticated'];
  return { guards, principals, implementedAccess, targetAccess, status, evidence,
    classUsesOrganization: /organizationId/.test(classSource) };
}

export function discoverControllerRoutes(root) {
  const apiSource = path.join(root, 'apps', 'api', 'src');
  const dtoFields = dtoFieldIndex(root);
  const routes = [];
  for (const file of walk(apiSource)) {
    const source = fs.readFileSync(file, 'utf8');
    const relative = path.relative(root, file).replaceAll(path.sep, '/');
    const classMatch = source.match(/export\s+class\s+([A-Za-z_$][\w$]*)/);
    const controller = classMatch?.[1] || '';
    const controllerMatch = source.match(/@Controller\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/);
    if (!controllerMatch) continue;
    const classStart = classMatch?.index || source.length;
    const classDecorators = source.slice(0, classStart);
    const classGuards = guardNames(classDecorators);
    const matches = [...source.matchAll(HTTP_DECORATOR)];
    matches.forEach((match, index) => {
      const next = matches[index + 1]?.index ?? source.length;
      const details = methodDetails(source, (match.index || 0) + match[0].length, next);
      const previousMethodEnd = source.lastIndexOf('\n  }', match.index || 0);
      const decoratorStart = Math.max(classStart, previousMethodEnd < 0 ? classStart : previousMethodEnd + 4);
      const decoratorText = source.slice(decoratorStart, details.methodIndex);
      const methodGuards = guardNames(decoratorText);
      const ownershipChecks = tenantChecks(decoratorText);
      const route = { method: match[1].toUpperCase(),
        path: joinRoute(controllerMatch[1] || '', match[2] || ''),
        source: relative, controller, handler: details.handler,
        excludedFromPublicSnapshot: /@ApiExcludeController\(\)/.test(classDecorators) ||
          /@ApiExcludeEndpoint\(\)/.test(decoratorText) };
      const classification = classify(
        route, classGuards, methodGuards, details.block, classDecorators, decoratorText,
      );
      const service = serviceReference(root, file, source, details.block);
      routes.push({ key: `${route.method} ${route.path}`, ...route,
        principals: classification.principals, guards: classification.guards,
        tenantChecks: ownershipChecks,
        implementedAccess: classification.implementedAccess,
        targetAccess: classification.targetAccess, status: classification.status,
        selectors: selectors(route.path, details.header, dtoFields),
        ownershipEvidence: [`${relative}#${details.handler}`,
          ...(service ? [service] : []), classification.evidence],
        sideEffect: ['GET', 'HEAD', 'OPTIONS'].includes(route.method) ? 'read' :
          route.path.endsWith('/media') ? 'read-media' :
          route.path.endsWith('/resolve-senders') ? 'identity-repair' : 'mutation',
        proposedPermission: proposedPermission(route.path, route.method),
        clients: clientsFor(route.path, route.method), notes: '' });
    });
  }
  return routes.sort((left, right) => left.key.localeCompare(right.key));
}

export function supplementaryEntrypoints() {
  return [
    { key: 'STATIC /uploads/media/*', source: 'apps/api/src/main.ts', handler: '@fastify/static',
      principals: ['unauthenticated'], implementedAccess: 'public', targetAccess: 'organization',
      status: 'decision-required', tenantChecks: [], selectors: [{ location: 'path', name: '*', required: true,
        namespace: 'storage-relative-path', parent: '' }], ownershipEvidence: [
        'apps/api/src/main.ts#fastify-static', 'Static media prefix has no controller guard.' ],
      sideEffect: 'read-media', proposedPermission: 'messages:read', clients: [], notes: '' },
    { key: 'GET /api/docs', source: 'apps/api/src/main.ts', handler: 'SwaggerModule.setup',
      principals: ['unauthenticated'], implementedAccess: 'public', targetAccess: 'public',
      status: 'intentional-public', tenantChecks: [], selectors: [], ownershipEvidence: [
        'apps/api/src/main.ts#SwaggerModule.setup', 'Public API documentation endpoint.' ],
      sideEffect: 'read', proposedPermission: 'public', clients: [], notes: '' },
    { key: 'SOCKET /ws (EventsGateway)', source: 'apps/api/src/modules/events/events.gateway.ts',
      handler: 'EventsGateway', principals: ['jwt', 'api-key'], implementedAccess: 'organization',
      targetAccess: 'organization', status: 'protected', tenantChecks: [], selectors: [{ location: 'message',
        name: 'profileId', required: true, namespace: 'profile-id', parent: '' }],
      ownershipEvidence: ['apps/api/src/modules/events/events.gateway.ts#authenticate',
        'EventsGateway.handleJoin verifies profile workspace organization before joining a room.'],
      sideEffect: 'subscription', proposedPermission: 'profiles:read', clients: [], notes: '' },
    { key: 'SOCKET /ws (RealtimeGateway)', source: 'apps/api/src/modules/websocket/realtime.gateway.ts',
      handler: 'RealtimeGateway', principals: ['api-key'], implementedAccess: 'authenticated-user',
      targetAccess: 'organization', status: 'confirmed-gap', tenantChecks: [], selectors: [{ location: 'message',
        name: 'profileId', required: true, namespace: 'profile-id', parent: '' }],
      ownershipEvidence: ['apps/api/src/modules/websocket/realtime.gateway.ts#handleSubscribe',
        'Subscription stores the supplied profile ID without an organization ownership query.'],
      sideEffect: 'subscription', proposedPermission: 'profiles:read', clients: [], notes: '' },
  ];
}

export function inventorySummary(inventory) {
  const all = [...inventory.routes, ...inventory.entrypoints];
  const count = field => Object.fromEntries([...new Set(all.map(value => value[field]))].sort()
    .map(value => [value, all.filter(item => item[field] === value).length]));
  return { controllerRoutes: inventory.routes.length, supplementaryEntrypoints: inventory.entrypoints.length,
    total: all.length, byStatus: count('status'), byImplementedAccess: count('implementedAccess') };
}

export function validateInventory(root, inventory, discovered = discoverControllerRoutes(root),
  expectedSupplementary = supplementaryEntrypoints()) {
  const errors = [];
  if (inventory.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  const entries = [...(inventory.routes || []), ...(inventory.entrypoints || [])];
  const keys = new Set();
  entries.forEach(entry => {
    if (!entry.key || keys.has(entry.key)) errors.push(`duplicate or missing key: ${entry.key || '<blank>'}`);
    keys.add(entry.key);
    if (!ACCESS_CATEGORIES.has(entry.implementedAccess)) errors.push(`${entry.key}: invalid implementedAccess`);
    if (!ACCESS_CATEGORIES.has(entry.targetAccess)) errors.push(`${entry.key}: invalid targetAccess`);
    if (!INVENTORY_STATUSES.has(entry.status)) errors.push(`${entry.key}: invalid status`);
    if (entry.status === 'intentional-public' && entry.targetAccess !== 'public') {
      errors.push(`${entry.key}: intentional-public requires public targetAccess`);
    }
    if (!Array.isArray(entry.principals) || !entry.principals.length) errors.push(`${entry.key}: principals missing`);
    if (!Array.isArray(entry.ownershipEvidence) || entry.ownershipEvidence.length < 2) {
      errors.push(`${entry.key}: ownership evidence missing`);
    }
    if (!Array.isArray(entry.selectors)) errors.push(`${entry.key}: selectors missing`);
    if (!Array.isArray(entry.tenantChecks)) errors.push(`${entry.key}: tenantChecks missing`);
    (entry.tenantChecks || []).forEach(check => {
      if (!['profile', 'conversation'].includes(check.resource) ||
          !['param', 'query', 'body'].includes(check.from) || !check.key ||
          typeof check.optional !== 'boolean') {
        errors.push(`${entry.key}: malformed tenant check`);
      }
    });
    (entry.selectors || []).forEach(selector => {
      if (!selector.location || !selector.name || !selector.namespace ||
          typeof selector.required !== 'boolean' || typeof selector.parent !== 'string') {
        errors.push(`${entry.key}: malformed selector`);
      }
      if (selector.parent && !(entry.selectors || []).some(value => value.name === selector.parent)) {
        errors.push(`${entry.key}: selector parent is not present`);
      }
    });
    const sourcePath = path.join(root, entry.source || '');
    if (!fs.existsSync(sourcePath)) errors.push(`${entry.key}: source missing`);
    else if (entry.handler && !fs.readFileSync(sourcePath, 'utf8').includes(entry.handler)) {
      errors.push(`${entry.key}: handler evidence missing from source`);
    }
    (entry.ownershipEvidence || []).forEach(evidence => {
      const match = String(evidence).match(/^((?:apps|packages)\/[^#]+)#([A-Za-z_$][\w$]*)$/);
      if (!match) return;
      const evidencePath = path.join(root, match[1]);
      if (!fs.existsSync(evidencePath) || !fs.readFileSync(evidencePath, 'utf8').includes(match[2])) {
        errors.push(`${entry.key}: referenced ownership evidence is stale`);
      }
    });
  });
  const expected = new Map(discovered.map(route => [route.key, route]));
  const actual = new Map((inventory.routes || []).map(route => [route.key, route]));
  for (const [key, route] of expected) {
    if (!actual.has(key)) errors.push(`route missing from inventory: ${key}`);
    else if (actual.get(key).source !== route.source || actual.get(key).handler !== route.handler) {
      errors.push(`route evidence drift: ${key}`);
    } else if (JSON.stringify(actual.get(key).selectors) !== JSON.stringify(route.selectors)) {
      errors.push(`route selector drift: ${key}`);
    } else if (JSON.stringify(actual.get(key).guards) !== JSON.stringify(route.guards)) {
      errors.push(`route guard drift: ${key}`);
    } else if (JSON.stringify(actual.get(key).tenantChecks) !== JSON.stringify(route.tenantChecks)) {
      errors.push(`route tenant-check drift: ${key}`);
    }
  }
  for (const key of actual.keys()) if (!expected.has(key)) errors.push(`stale inventory route: ${key}`);
  const expectedEntrypoints = new Map(expectedSupplementary.map(entry => [entry.key, entry]));
  const actualEntrypoints = new Map((inventory.entrypoints || []).map(entry => [entry.key, entry]));
  for (const [key, entry] of expectedEntrypoints) {
    if (!actualEntrypoints.has(key)) errors.push(`supplementary entrypoint missing: ${key}`);
    else if (actualEntrypoints.get(key).source !== entry.source ||
        actualEntrypoints.get(key).handler !== entry.handler) {
      errors.push(`supplementary entrypoint evidence drift: ${key}`);
    }
  }
  for (const key of actualEntrypoints.keys()) {
    if (!expectedEntrypoints.has(key)) errors.push(`unexpected supplementary entrypoint: ${key}`);
  }
  const publicCount = discovered.filter(route => !route.excludedFromPublicSnapshot).length;
  if (inventory.publicSnapshotRouteCount !== publicCount) {
    errors.push('public snapshot route count does not match discovered routes');
  }
  if (!/^[0-9a-f]{40}$/.test(String(inventory.reviewedBaseline || ''))) {
    errors.push('reviewedBaseline must be a full commit hash');
  }
  return errors;
}
