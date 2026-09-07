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
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
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

async function mutationFixture(profileId, label) {
  const conversation = await prisma.conversation.create({ data: {
    profileId,
    jid: `synthetic-mutation-${label}-${suffix}@s.whatsapp.net`,
    type: 'user',
    unreadCount: 2,
    metadata: { seed: label },
    lastMessageAt: new Date('2026-09-07T02:00:00Z'),
  } });
  const messages = await Promise.all(['one', 'two'].map((part, index) =>
    prisma.message.create({ data: {
      profileId,
      conversationId: conversation.id,
      messageId: `provider-mutation-${label}-${part}-${suffix}`,
      direction: 'incoming',
      senderJid: `synthetic-mutation-${label}-${suffix}@s.whatsapp.net`,
      type: 'text',
      content: { text: `synthetic ${label} ${part}` },
      status: index === 0 ? 'delivered' : 'sent',
      timestamp: new Date(`2026-09-07T02:0${index}:00Z`),
    } })));
  return { conversation, messages };
}

async function mutationSnapshot(conversationId) {
  return {
    conversation: await prisma.conversation.findUnique({ where: { id: conversationId },
      select: { id: true, profileId: true, unreadCount: true, metadata: true,
        lastMessageAt: true } }),
    messages: await prisma.message.findMany({ where: { conversationId },
      select: { id: true, status: true }, orderBy: { id: 'asc' } }),
  };
}

function routeWithForgedSelectors(path, profileId, organizationId) {
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}profileId=${encodeURIComponent(profileId)}` +
    `&organizationId=${encodeURIComponent(organizationId)}`;
}

const report = { schemaVersion: 1, baseline: 'ebe8a71ba471c3b41297c78522eff08e0d6ddf07',
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
    settings: { engine: 'mock', dntOperationsAccess: true },
  } });
  await prisma.profile.update({ where: { id: profileA2 }, data: {
    settings: { engine: 'baileys', dntOperationsAccess: 'true' },
  } });
  await prisma.profile.update({ where: { id: profileA3 }, data: {
    settings: { engine: 'baileys', dntOperationsAccess: false },
  } });

  const conversationA1 = await prisma.conversation.create({ data: {
    profileId: profileA1, jid: `synthetic-a1-${suffix}@s.whatsapp.net`, type: 'user',
    lastMessageAt: new Date('2026-09-07T01:03:00Z'),
  } });
  const conversationA1Older = await prisma.conversation.create({ data: {
    profileId: profileA1, jid: `synthetic-a1-older-${suffix}@s.whatsapp.net`, type: 'user',
    lastMessageAt: new Date('2026-09-07T00:59:00Z'),
  } });
  const conversationA1Group = await prisma.conversation.create({ data: {
    profileId: profileA1, jid: `synthetic-a1-${suffix}@g.us`, type: 'group',
    lastMessageAt: new Date('2026-09-07T01:05:00Z'),
  } });
  const messageA1 = await prisma.message.create({ data: {
    profileId: profileA1, conversationId: conversationA1.id,
    messageId: `provider-a1-${suffix}`, direction: 'incoming',
    senderJid: `synthetic-a1-${suffix}@s.whatsapp.net`, type: 'image',
    content: { url: 'data:image/png;base64,iVBORw0KGgo=', filename: 'synthetic-a1.png' },
    timestamp: new Date(0),
  } });
  const messageA1Outgoing = await prisma.message.create({ data: {
    profileId: profileA1, conversationId: conversationA1.id,
    messageId: `provider-a1-outgoing-${suffix}`, direction: 'outgoing',
    senderJid: `synthetic-a1-${suffix}@s.whatsapp.net`, type: 'text',
    content: { text: 'synthetic outgoing' }, timestamp: new Date('2026-09-07T01:01:00Z'),
  } });
  const messageA1Incoming = await prisma.message.create({ data: {
    profileId: profileA1, conversationId: conversationA1.id,
    messageId: `provider-a1-incoming-${suffix}`, direction: 'incoming',
    senderJid: `synthetic-a1-${suffix}@s.whatsapp.net`, type: 'text',
    content: { text: 'synthetic incoming' }, timestamp: new Date('2026-09-07T01:02:00Z'),
  } });
  const messageA1Latest = await prisma.message.create({ data: {
    profileId: profileA1, conversationId: conversationA1.id,
    messageId: `provider-a1-latest-${suffix}`, direction: 'incoming',
    senderJid: `synthetic-a1-${suffix}@s.whatsapp.net`, type: 'image',
    content: { url: 'data:image/png;base64,aGVsbG8=', filename: 'synthetic-latest.png' },
    timestamp: new Date('2026-09-07T01:03:00Z'),
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

  const inertProvider = await request('POST', `/api/v1/profiles/${profileA1}/connect`, jwtA, {});
  assert.equal(inertProvider.status, 201);
  await new Promise(resolve => setTimeout(resolve, 2100));

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

  const ownMessages = await request('GET',
    `/api/v1/messages/profile/${profileA1}?includeMedia=false`, jwtA);
  assert.equal(ownMessages.status, 200);
  const ownMessage = ownMessages.value.find(item => item.id === messageA1.id);
  assert.ok(ownMessage);
  assert.equal(Object.hasOwn(ownMessage.content, 'url'), false);
  assert.equal(typeof ownMessage.mediaFingerprint, 'string');
  report.observed.sameOrganizationMessages = ownMessages.status;

  const orderedMessages = await request('GET',
    `/api/v1/messages/profile/${profileA1}?limit=4&includeMedia=false`, jwtA);
  assert.equal(orderedMessages.status, 200);
  assert.deepEqual(orderedMessages.value.map(item => item.id),
    [messageA1Latest.id, messageA1Incoming.id, messageA1Outgoing.id, messageA1.id]);
  const sinceMessages = await request('GET',
    `/api/v1/messages/profile/${profileA1}?since=${encodeURIComponent('2026-09-07T01:01:30Z')}` +
    '&includeMedia=false', jwtA);
  assert.equal(sinceMessages.status, 200);
  assert.deepEqual(sinceMessages.value.map(item => item.id),
    [messageA1Latest.id, messageA1Incoming.id]);
  const typeMessages = await request('GET',
    `/api/v1/messages/profile/${profileA1}?type=text&includeMedia=false`, jwtA);
  assert.equal(typeMessages.status, 200);
  assert.deepEqual(typeMessages.value.map(item => item.id),
    [messageA1Incoming.id, messageA1Outgoing.id]);
  const directionMessages = await request('GET',
    `/api/v1/messages/profile/${profileA1}?direction=outgoing&includeMedia=false`, jwtA);
  assert.equal(directionMessages.status, 200);
  assert.deepEqual(directionMessages.value.map(item => item.id), [messageA1Outgoing.id]);
  const limitedMessages = await request('GET',
    `/api/v1/messages/profile/${profileA1}?limit=2&includeMedia=false`, jwtA);
  assert.equal(limitedMessages.status, 200);
  assert.deepEqual(limitedMessages.value.map(item => item.id),
    [messageA1Latest.id, messageA1Incoming.id]);
  const offsetMessages = await request('GET',
    `/api/v1/messages/profile/${profileA1}?limit=2&offset=1&includeMedia=false`, jwtA);
  assert.equal(offsetMessages.status, 200);
  assert.deepEqual(offsetMessages.value.map(item => item.id),
    [messageA1Incoming.id, messageA1Outgoing.id]);
  report.observed.messageFilteringAndPagination = 200;

  const ownMedia = await request('POST', `/api/v1/messages/profile/${profileA1}/media`,
    jwtA, { ids: [messageA1Latest.id, messageA1.id] });
  assert.equal(ownMedia.status, 201);
  assert.deepEqual(ownMedia.value.map(item => item.id), [messageA1Latest.id, messageA1.id]);
  assert.deepEqual(ownMedia.value.map(item => item.content.filename),
    ['synthetic-latest.png', 'synthetic-a1.png']);
  report.observed.sameOrganizationMedia = ownMedia.status;

  const boundaryMedia = await Promise.all(Array.from({ length: 48 }, async (_value, index) =>
    prisma.message.create({ data: {
      profileId: profileA1, conversationId: conversationA1.id,
      messageId: `provider-a1-boundary-${index}-${suffix}`, direction: 'incoming',
      senderJid: `synthetic-a1-${suffix}@s.whatsapp.net`, type: 'image',
      content: { url: 'data:image/png;base64,aGVsbG8=', filename: `boundary-${index}.png` },
      timestamp: new Date(-1000 - index),
    } })));
  const fiftyMediaIds = [messageA1Latest.id, ...boundaryMedia.map(item => item.id), messageA1.id];
  const boundaryMediaResponse = await request('POST',
    `/api/v1/messages/profile/${profileA1}/media`, jwtA, { ids: fiftyMediaIds });
  assert.equal(boundaryMediaResponse.status, 201);
  assert.deepEqual(boundaryMediaResponse.value.map(item => item.id), fiftyMediaIds);
  const overLimitMedia = await request('POST', `/api/v1/messages/profile/${profileA1}/media`,
    jwtA, { ids: [...fiftyMediaIds, messageA1.id] });
  assert.equal(overLimitMedia.status, 400);
  report.observed.mediaLimit = overLimitMedia.status;

  const foreignMessages = await request('GET',
    `/api/v1/messages/profile/${profileB}?includeMedia=false`, jwtA);
  assert.equal(foreignMessages.status, 404);
  report.observed.foreignProfileMessages = foreignMessages.status;
  report.protected.push('Message profile reads reject a foreign organization profile ID.');

  const foreignMedia = await request('POST', `/api/v1/messages/profile/${profileB}/media`,
    jwtA, { ids: [messageB.id] });
  assert.equal(foreignMedia.status, 404);
  report.observed.foreignProfileMedia = foreignMedia.status;
  report.protected.push('Bulk media retrieval rejects a foreign organization profile ID.');

  const mixedMedia = await request('POST', `/api/v1/messages/profile/${profileA1}/media`,
    jwtA, { ids: [messageA1.id, messageB.id] });
  assert.equal(mixedMedia.status, 404);
  report.observed.mixedProfileMedia = mixedMedia.status;
  report.protected.push('Media batches reject mixed-profile IDs without returning a partial result.');

  const sameOrganizationMixedMedia = await request('POST',
    `/api/v1/messages/profile/${profileA1}/media`, jwtA,
    { ids: [messageA1.id, messageA2.id] });
  assert.equal(sameOrganizationMixedMedia.status, 404);
  report.observed.sameOrganizationMixedMedia = sameOrganizationMixedMedia.status;

  const foreignResolution = await request('POST',
    `/api/v1/messages/profile/${profileB}/resolve-senders`, jwtA,
    { jids: ['900000000000001@lid'] });
  assert.equal(foreignResolution.status, 404);
  report.observed.foreignSenderResolution = foreignResolution.status;
  report.protected.push('Sender resolution rejects a foreign organization profile before service execution.');

  const foreignConversations = await request('GET',
    `/api/v1/conversations?profileId=${profileB}`, jwtA);
  assert.equal(foreignConversations.status, 404);
  report.observed.foreignConversationList = foreignConversations.status;
  report.protected.push('Conversation listing rejects a foreign organization profile ID.');

  const ownConversations = await request('GET',
    `/api/v1/conversations?profileId=${profileA1}&limit=2&offset=0`, jwtA);
  assert.equal(ownConversations.status, 200);
  assert.deepEqual(ownConversations.value.conversations.map(item => item.id),
    [conversationA1Group.id, conversationA1.id]);
  const offsetConversations = await request('GET',
    `/api/v1/conversations?profileId=${profileA1}&type=user&limit=1&offset=1`, jwtA);
  assert.equal(offsetConversations.status, 200);
  assert.deepEqual(offsetConversations.value.conversations.map(item => item.id),
    [conversationA1Older.id]);
  report.observed.sameOrganizationConversationList = ownConversations.status;

  const ownConversationMessages = await request('GET',
    `/api/v1/conversations/${conversationA1.id}/messages?limit=2`, jwtA);
  assert.equal(ownConversationMessages.status, 200);
  assert.deepEqual(ownConversationMessages.value.messages.map(item => item.id),
    [messageA1Incoming.id, messageA1Latest.id]);
  assert.equal(ownConversationMessages.value.hasMore, true);
  report.observed.sameOrganizationConversationMessages = ownConversationMessages.status;

  const validCursor = await request('GET',
    `/api/v1/conversations/${conversationA1.id}/messages?limit=2&before=${messageA1Incoming.id}`, jwtA);
  assert.equal(validCursor.status, 200);
  assert.deepEqual(validCursor.value.messages.map(item => item.id),
    [messageA1.id, messageA1Outgoing.id]);
  const sameOrganizationCursor = await request('GET',
    `/api/v1/conversations/${conversationA1.id}/messages?limit=2&before=${messageA2.id}`, jwtA);
  const foreignOrganizationCursor = await request('GET',
    `/api/v1/conversations/${conversationA1.id}/messages?limit=2&before=${messageB.id}`, jwtA);
  const missingCursor = await request('GET',
    `/api/v1/conversations/${conversationA1.id}/messages?limit=2&before=${crypto.randomUUID()}`, jwtA);
  assert.equal(sameOrganizationCursor.status, 404);
  assert.equal(foreignOrganizationCursor.status, 404);
  assert.equal(missingCursor.status, 404);
  report.observed.conversationCursorContainment = 404;

  const foreignConversationMessages = await request('GET',
    `/api/v1/conversations/${conversationB.id}/messages?limit=20`, jwtA);
  assert.equal(foreignConversationMessages.status, 404);
  report.observed.foreignConversationMessages = foreignConversationMessages.status;
  report.protected.push('Conversation message reads reject a foreign organization conversation ID.');

  const foreignGroups = await request('GET', `/api/v1/groups/profile/${profileB}`, jwtA);
  assert.equal(foreignGroups.status, 404);
  report.observed.foreignGroupList = foreignGroups.status;
  report.protected.push('Group listing rejects a foreign organization profile before provider access.');

  const ownGroups = await request('GET', `/api/v1/groups/profile/${profileA1}`, jwtA);
  assert.equal(ownGroups.status, 200);
  assert.deepEqual(ownGroups.value.map(item => item.id),
    ['mock-group-1@g.us', 'mock-group-2@g.us']);
  report.observed.sameOrganizationGroups = ownGroups.status;

  const ownResolution = await request('POST',
    `/api/v1/messages/profile/${profileA1}/resolve-senders`, jwtA,
    { jids: ['900000000000001@lid'] });
  assert.equal(ownResolution.status, 201);
  assert.deepEqual(ownResolution.value,
    { phones: { '900000000000001@lid': '6281234567890' } });
  report.observed.sameOrganizationSenderResolution = ownResolution.status;

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
  const apiKeyMessages = await request('GET',
    `/api/v1/messages/profile/${profileA1}?type=text&limit=1&offset=0`, readKey);
  const apiKeyMedia = await request('POST', `/api/v1/messages/profile/${profileA1}/media`,
    readKey, { ids: [messageA1Latest.id, messageA1.id] });
  const apiKeyResolution = await request('POST',
    `/api/v1/messages/profile/${profileA1}/resolve-senders`, readKey,
    { jids: ['900000000000001@lid'] });
  const apiKeyConversations = await request('GET',
    `/api/v1/conversations?profileId=${profileA1}&limit=10&offset=0`, readKey);
  const apiKeyConversationMessages = await request('GET',
    `/api/v1/conversations/${conversationA1.id}/messages?limit=2`, readKey);
  const apiKeyGroups = await request('GET', `/api/v1/groups/profile/${profileA1}`, readKey);
  assert.deepEqual([apiKeyMessages.status, apiKeyMedia.status, apiKeyResolution.status,
    apiKeyConversations.status, apiKeyConversationMessages.status, apiKeyGroups.status],
  [200, 201, 201, 200, 200, 200]);
  assert.deepEqual(apiKeyMedia.value.map(item => item.id), [messageA1Latest.id, messageA1.id]);
  assert.deepEqual(apiKeyResolution.value,
    { phones: { '900000000000001@lid': '6281234567890' } });
  assert.deepEqual(apiKeyGroups.value.map(item => item.id),
    ['mock-group-1@g.us', 'mock-group-2@g.us']);
  report.observed.apiKeyOwnPaymentReads = 200;
  for (const route of [
    `/api/v1/messages/profile/${profileB}?includeMedia=false`,
    `/api/v1/conversations?profileId=${profileB}`,
    `/api/v1/conversations/${conversationB.id}/messages?limit=20`,
    `/api/v1/groups/profile/${profileB}`,
  ]) {
    const response = await request('GET', route, readKey);
    assert.equal(response.status, 404);
  }
  const apiKeyForeignMedia = await request('POST', `/api/v1/messages/profile/${profileB}/media`,
    readKey, { ids: [messageB.id] });
  assert.equal(apiKeyForeignMedia.status, 404);
  const apiKeyForeignResolution = await request('POST',
    `/api/v1/messages/profile/${profileB}/resolve-senders`, readKey,
    { jids: ['900000000000001@lid'] });
  assert.equal(apiKeyForeignResolution.status, 404);
  const apiKeyCrossOrganizationMixedMedia = await request('POST',
    `/api/v1/messages/profile/${profileA1}/media`, readKey,
    { ids: [messageA1.id, messageB.id] });
  const apiKeySameOrganizationMixedMedia = await request('POST',
    `/api/v1/messages/profile/${profileA1}/media`, readKey,
    { ids: [messageA1.id, messageA2.id] });
  assert.equal(apiKeyCrossOrganizationMixedMedia.status, 404);
  assert.equal(apiKeySameOrganizationMixedMedia.status, 404);
  report.observed.apiKeyForeignPaymentReads = 404;
  report.protected.push('API-key Payment Monitor reads enforce the same organization boundaries as JWT reads.');
  report.decisions.push('Empty and wildcard permission sets currently retain full authenticated-key behavior.');

  const mutationCases = [
    { name: 'read', method: 'PUT', suffix: '/read' },
    { name: 'archive', method: 'PUT', suffix: '/archive' },
    { name: 'unarchive', method: 'PUT', suffix: '/unarchive' },
    { name: 'mute', method: 'PUT', suffix: '/mute', toggle: 'isMuted' },
    { name: 'pin', method: 'PUT', suffix: '/pin', toggle: 'isPinned' },
    { name: 'clear', method: 'DELETE', suffix: '/messages' },
    { name: 'delete', method: 'DELETE', suffix: '' },
  ];
  const mutationCredentials = [['jwt', jwtA], ['apiKey', readKey]];
  const mutationResults = {};

  for (const mutation of mutationCases) {
    const foreignFixture = await mutationFixture(profileB, `foreign-${mutation.name}`);
    const callerOrganizationFixture = await mutationFixture(profileA1,
      `denial-anchor-${mutation.name}`);
    const foreignPath = `/api/v1/conversations/${foreignFixture.conversation.id}${mutation.suffix}`;
    const foreignBefore = await mutationSnapshot(foreignFixture.conversation.id);
    const callerOrganizationBefore = await mutationSnapshot(
      callerOrganizationFixture.conversation.id);
    const denialBodies = [];

    for (const [credentialName, credential] of mutationCredentials) {
      const missingId = crypto.randomUUID();
      const directForeign = await request(mutation.method, foreignPath, credential);
      const missingConversation = await request(mutation.method,
        `/api/v1/conversations/${missingId}${mutation.suffix}`, credential);
      const forgedQuery = await request(mutation.method,
        routeWithForgedSelectors(foreignPath, profileA1, jwtA.organizationId), credential);
      const forgedBody = await request(mutation.method, foreignPath, credential,
        { profileId: profileA1, organizationId: jwtA.organizationId });
      for (const response of [directForeign, missingConversation, forgedQuery, forgedBody]) {
        assert.equal(response.status, 404, `${credentialName} ${mutation.name} foreign denial`);
      }
      assert.deepEqual(directForeign.value, missingConversation.value,
        `${credentialName} ${mutation.name} must not disclose foreign existence`);
      denialBodies.push(directForeign.value);
      assert.deepEqual(await mutationSnapshot(foreignFixture.conversation.id), foreignBefore,
        `${credentialName} ${mutation.name} denied requests must not write`);
      assert.deepEqual(await mutationSnapshot(callerOrganizationFixture.conversation.id),
        callerOrganizationBefore,
        `${credentialName} ${mutation.name} denied requests must not write to caller records`);
    }
    assert.deepEqual(denialBodies[0], denialBodies[1],
      `${mutation.name} JWT and API-key denial bodies must match`);

    const unauthenticatedFixture = await mutationFixture(profileA1, `unauthenticated-${mutation.name}`);
    const unauthenticatedPath = `/api/v1/conversations/${unauthenticatedFixture.conversation.id}${mutation.suffix}`;
    const unauthenticatedBefore = await mutationSnapshot(unauthenticatedFixture.conversation.id);
    const missingCredential = await request(mutation.method, unauthenticatedPath);
    const invalidCredential = await request(mutation.method, unauthenticatedPath,
      { type: 'jwt', value: 'invalid' });
    assert.equal(missingCredential.status, 401, `${mutation.name} missing credential`);
    assert.equal(invalidCredential.status, 401, `${mutation.name} invalid credential`);
    assert.deepEqual(await mutationSnapshot(unauthenticatedFixture.conversation.id),
      unauthenticatedBefore, `${mutation.name} authentication failures must not write`);

    for (const [credentialName, credential] of mutationCredentials) {
      const ownFixture = await mutationFixture(profileA2, `${credentialName}-${mutation.name}`);
      const neighborFixture = await mutationFixture(profileA2,
        `${credentialName}-${mutation.name}-neighbor`);
      const neighborBefore = await mutationSnapshot(neighborFixture.conversation.id);
      const ownPath = `/api/v1/conversations/${ownFixture.conversation.id}${mutation.suffix}`;
      const response = await request(mutation.method, ownPath, credential);
      assert.equal(response.status, 200, `${credentialName} ${mutation.name} success`);

      if (mutation.name === 'read') {
        assert.deepEqual(response.value, { success: true });
        const after = await mutationSnapshot(ownFixture.conversation.id);
        assert.equal(after.conversation.unreadCount, 0);
        assert.ok(after.messages.every(message => message.status === 'read'));
      } else if (mutation.name === 'archive' || mutation.name === 'unarchive') {
        assert.deepEqual(response.value, { success: true });
        const after = await mutationSnapshot(ownFixture.conversation.id);
        assert.deepEqual(after.conversation.metadata,
          { archived: mutation.name === 'archive' });
      } else if (mutation.toggle) {
        assert.deepEqual(response.value, { success: true, [mutation.toggle]: true });
        const secondResponse = await request(mutation.method, ownPath, credential);
        assert.equal(secondResponse.status, 200);
        assert.deepEqual(secondResponse.value, { success: true, [mutation.toggle]: false });
        const after = await mutationSnapshot(ownFixture.conversation.id);
        assert.equal(after.conversation.metadata[mutation.toggle], false);
      } else if (mutation.name === 'clear') {
        assert.deepEqual(response.value, { success: true });
        const after = await mutationSnapshot(ownFixture.conversation.id);
        assert.equal(after.conversation.unreadCount, 0);
        assert.equal(after.conversation.lastMessageAt, null);
        assert.deepEqual(after.messages, []);
      } else {
        assert.deepEqual(response.value, { success: true });
        const after = await mutationSnapshot(ownFixture.conversation.id);
        assert.deepEqual(after, { conversation: null, messages: [] });
      }
      assert.deepEqual(await mutationSnapshot(neighborFixture.conversation.id), neighborBefore,
        `${credentialName} ${mutation.name} must not change a neighboring conversation`);
    }
    mutationResults[mutation.name] = {
      jwtOwn: 200,
      apiKeyOwn: 200,
      foreign: 404,
      missing: 404,
      unauthenticated: 401,
      invalidCredential: 401,
      forgedSelectors: 404,
      deniedBusinessWrites: 0,
    };
  }
  report.observed.conversationMutations = mutationResults;
  report.protected.push('Seven conversation mutations enforce organization ownership for JWT and API-key callers.');
  report.decisions.push('API-key lastUsedAt bookkeeping is excluded from denied business-write counts.');

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

  assert.equal(report.knownGaps.length, process.env.AUTHZ_STATIC_FIXTURE === '1' ? 5 : 4);
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (organizations.length) {
    await prisma.organization.deleteMany({ where: { id: { in: organizations } } });
  }
  await prisma.$disconnect();
}
