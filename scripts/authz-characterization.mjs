#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { prisma } from '@multiwa/database';

const baseUrl = process.env.AUTHZ_TEST_BASE_URL;
if (!baseUrl || process.env.AUTHZ_CHARACTERIZATION !== '1') {
  throw new Error('Set AUTHZ_CHARACTERIZATION=1 and AUTHZ_TEST_BASE_URL for an isolated API.');
}

const suffix = crypto.randomUUID().slice(0, 8);
const password = 'Synthetic-pass-123';
const organizations = [];

async function request(method, route, credential, body) {
  const headers = { 'content-type': 'application/json' };
  if (credential?.type === 'jwt') headers.authorization = 'Bearer ' + credential.value;
  if (credential?.type === 'api-key') headers['x-api-key'] = credential.value;
  const response = await fetch(baseUrl + route, { method, headers,
    body: body === undefined ? undefined : JSON.stringify(body) });
  let value = null;
  try { value = await response.json(); } catch {}
  return { status: response.status, value };
}

async function register(label) {
  const response = await request('POST', '/api/v1/auth/register', null, {
    email: `authz-${label}-${suffix}@example.test`, password,
    name: `Synthetic ${label}`, organizationName: `Synthetic ${label} ${suffix}`,
  });
  assert.equal(response.status, 201);
  organizations.push(response.value.user.organizationId);
  return { type: 'jwt', value: response.value.accessToken,
    userId: response.value.user.id, organizationId: response.value.user.organizationId };
}

async function workspace(jwt) {
  const response = await request('GET', '/api/v1/workspaces', jwt);
  assert.equal(response.status, 200);
  assert.equal(response.value.length, 1);
  return response.value[0].id;
}

async function profile(jwt, workspaceId, label) {
  const response = await request('POST', '/api/v1/profiles', jwt, {
    workspaceId, name: `Synthetic ${label}`, engine: 'baileys',
  });
  assert.equal(response.status, 201);
  return response.value.id;
}

async function apiKey(jwt, name, permissions) {
  const response = await request('POST', '/api/v1/api-keys', jwt, { name, permissions });
  assert.equal(response.status, 201);
  return { type: 'api-key', value: response.value.key, id: response.value.id };
}

const report = { schemaVersion: 1, baseline: '21722ff6d2dddc752aaed9ed8d158589306326d9',
  observed: {}, knownGaps: [], protected: [], decisions: [] };

try {
  const jwtA = await register('A');
  const jwtB = await register('B');
  const workspaceA = await workspace(jwtA);
  const workspaceB = await workspace(jwtB);
  const profileA1 = await profile(jwtA, workspaceA, 'A1');
  const profileA2 = await profile(jwtA, workspaceA, 'A2');
  const profileA3 = await profile(jwtA, workspaceA, 'A3');
  const profileB = await profile(jwtB, workspaceB, 'B');

  await prisma.profile.update({ where: { id: profileA1 }, data: {
    settings: { engine: 'baileys', dntOperationsAccess: true },
  } });
  await prisma.profile.update({ where: { id: profileA2 }, data: {
    settings: { engine: 'baileys', dntOperationsAccess: 'true' },
  } });
  await prisma.profile.update({ where: { id: profileA3 }, data: {
    settings: { engine: 'baileys', dntOperationsAccess: false },
  } });

  const conversationA2 = await prisma.conversation.create({ data: {
    profileId: profileA2, jid: `synthetic-a2-${suffix}@s.whatsapp.net`, type: 'user',
  } });
  const messageA2 = await prisma.message.create({ data: {
    profileId: profileA2, conversationId: conversationA2.id,
    messageId: `provider-a2-${suffix}`, direction: 'incoming',
    senderJid: `synthetic-a2-${suffix}@s.whatsapp.net`, type: 'text',
    content: { text: 'synthetic' }, timestamp: new Date(0),
  } });
  const conversationB = await prisma.conversation.create({ data: {
    profileId: profileB, jid: `synthetic-b-${suffix}@s.whatsapp.net`, type: 'user',
  } });
  const messageB = await prisma.message.create({ data: {
    profileId: profileB, conversationId: conversationB.id,
    messageId: `provider-b-${suffix}`, direction: 'incoming',
    senderJid: `synthetic-b-${suffix}@s.whatsapp.net`, type: 'image',
    content: { url: 'data:image/png;base64,iVBORw0KGgo=', filename: 'synthetic.png' },
    timestamp: new Date(0),
  } });

  const missing = await request('GET', '/api/v1/profiles');
  const invalid = await request('GET', '/api/v1/profiles', { type: 'jwt', value: 'invalid' });
  assert.equal(missing.status, 401);
  assert.equal(invalid.status, 401);
  report.observed.missingCredentials = missing.status;
  report.observed.invalidCredentials = invalid.status;
  report.protected.push('Protected HTTP routes reject missing and invalid credentials.');

  const ownProfiles = await request('GET', '/api/v1/profiles', jwtA);
  assert.equal(ownProfiles.status, 200);
  assert.equal(ownProfiles.value.some(item => item.id === profileB), false);
  report.observed.sameOrganizationProfiles = ownProfiles.status;
  report.protected.push('Profile listing remains organization-scoped.');

  const foreignProfile = await request('GET', `/api/v1/profiles/${profileB}`, jwtA);
  assert.equal(foreignProfile.status, 404);
  report.observed.foreignProfile = foreignProfile.status;
  report.protected.push('Direct foreign profile lookup is denied with 404.');

  const foreignMessages = await request('GET',
    `/api/v1/messages/profile/${profileB}?includeMedia=false`, jwtA);
  assert.equal(foreignMessages.status, 200);
  assert.ok(foreignMessages.value.some(item => item.id === messageB.id));
  report.observed.foreignProfileMessages = foreignMessages.status;
  report.knownGaps.push('Message profile reads accept a foreign organization profile ID.');

  const foreignMedia = await request('POST', `/api/v1/messages/profile/${profileB}/media`,
    jwtA, { ids: [messageB.id] });
  assert.equal(foreignMedia.status, 201);
  assert.equal(foreignMedia.value.length, 1);
  report.observed.foreignProfileMedia = foreignMedia.status;
  report.knownGaps.push('Bulk media retrieval accepts foreign organization profile and message IDs.');

  const foreignConversations = await request('GET',
    `/api/v1/conversations?profileId=${profileB}`, jwtA);
  assert.equal(foreignConversations.status, 200);
  assert.ok(foreignConversations.value.conversations.some(item => item.id === conversationB.id));
  report.observed.foreignConversationList = foreignConversations.status;
  report.knownGaps.push('Conversation listing accepts a foreign organization profile ID.');

  const foreignConversation = await request('GET',
    `/api/v1/conversations/${conversationB.id}?messageLimit=50`, jwtA);
  assert.equal(foreignConversation.status, 200);
  report.observed.foreignConversationDetail = foreignConversation.status;
  report.knownGaps.push('Conversation detail accepts a foreign organization conversation ID.');
  report.decisions.push('Conversation detail without messageLimit currently fails Prisma validation; track separately from authorization enforcement.');

  const mismatchedContext = await request('GET',
    `/api/v1/conversations/${conversationA2.id}/messages/${messageA2.id}/context?profileId=${profileA1}`,
    jwtA);
  assert.equal(mismatchedContext.status, 404);
  report.observed.sameOrganizationChildMismatch = mismatchedContext.status;
  report.protected.push('Message context verifies conversation and message belong to the supplied profile.');

  for (const [name, id, expected] of [
    ['boolean true', profileA1, 200], ['string true', profileA2, 404], ['boolean false', profileA3, 404],
  ]) {
    const response = await request('GET', `/api/v1/profiles/${id}/dnt-operations/status`, jwtA);
    assert.equal(response.status, expected, name);
    report.observed['dntFlag' + name.replace(/\s+/g, '')] = response.status;
  }
  report.protected.push('DNT Operations access requires the exact boolean true flag.');

  if (process.env.AUTHZ_STATIC_FIXTURE === '1') {
    const staticMedia = await request('GET', '/uploads/media/stage2a-synthetic.txt');
    assert.equal(staticMedia.status, 200);
    report.observed.unauthenticatedStaticMedia = staticMedia.status;
    report.knownGaps.push('Static media files are served without authentication or ownership checks.');
  }

  const readKey = await apiKey(jwtA, 'synthetic-read', ['messages:read']);
  const emptyKey = await apiKey(jwtA, 'synthetic-empty', []);
  const wildcardKey = await apiKey(jwtA, 'synthetic-wildcard', ['*']);
  for (const [name, key] of [['read', readKey], ['empty', emptyKey], ['wildcard', wildcardKey]]) {
    const response = await request('GET', '/api/v1/profiles', key);
    assert.equal(response.status, 200);
    report.observed[name + 'KeyRead'] = response.status;
  }
  report.decisions.push('Empty and wildcard permission sets currently retain full authenticated-key behavior.');

  const hook = await request('POST', '/api/v1/hooks', readKey, {
    url: 'https://example.invalid/synthetic', events: ['message.received'],
  });
  assert.equal(hook.status, 201);
  report.observed.readOnlyKeyHookMutation = hook.status;
  report.knownGaps.push('A messages:read API key can register a global legacy hook.');
  const hooksSeenByB = await request('GET', '/api/v1/hooks', jwtB);
  assert.equal(hooksSeenByB.status, 200);
  assert.ok(hooksSeenByB.value.data.some(item => item.id === hook.value.data.id));
  report.observed.foreignOrganizationHookVisibility = hooksSeenByB.status;
  report.knownGaps.push('Legacy hooks registered by one organization are visible to another.');

  await prisma.user.update({ where: { id: jwtA.userId }, data: { isActive: false } });
  const inactiveKey = await request('GET', '/api/v1/profiles', readKey);
  assert.equal(inactiveKey.status, 200);
  report.observed.inactiveUserApiKey = inactiveKey.status;
  report.knownGaps.push('API keys remain usable after their owning user is deactivated.');

  const orphan = await prisma.profile.create({ data: {
    displayName: 'Synthetic orphan', settings: { dntOperationsAccess: true },
  } });
  const orphanRead = await request('GET', `/api/v1/profiles/${orphan.id}`, jwtB);
  assert.equal(orphanRead.status, 404);
  await prisma.profile.delete({ where: { id: orphan.id } });
  report.observed.nullWorkspaceProfile = orphanRead.status;
  report.decisions.push('Profiles without a workspace are unreachable through organization-scoped profile lookup.');
  report.decisions.push('A missing principal organization cannot be constructed under the current required User.organizationId schema.');

  assert.equal(report.knownGaps.length, process.env.AUTHZ_STATIC_FIXTURE === '1' ? 8 : 7);
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (organizations.length) {
    await prisma.organization.deleteMany({ where: { id: { in: organizations } } });
  }
  await prisma.$disconnect();
}
