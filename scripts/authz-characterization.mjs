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
    conversation: await prisma.conversation.findUnique({ where: { id: conversationId } }),
    messages: await prisma.message.findMany({ where: { conversationId },
      orderBy: { id: 'asc' } }),
  };
}

async function expectedConversationDetail(conversationId, messageLimit = 50) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      messages: { take: messageLimit, orderBy: { timestamp: 'desc' } },
      contact: true,
    },
  });
  conversation.messages.reverse();
  return JSON.parse(JSON.stringify(conversation));
}

async function expectedMessageDetail(messageId) {
  const message = await prisma.message.findUnique({
    where: { id: messageId }, include: { conversation: true },
  });
  return JSON.parse(JSON.stringify(message));
}

async function requestWithoutConversationWrites({
  method, route, credential, body, expectedStatus, label, conversationIds,
}) {
  const before = await Promise.all(conversationIds.map(mutationSnapshot));
  const response = await request(method, route, credential, body);
  assert.equal(response.status, expectedStatus, label);
  const after = await Promise.all(conversationIds.map(mutationSnapshot));
  assert.deepEqual(after, before, `${label} must not change either organization's records`);
  return response;
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

  const detailContact = await prisma.contact.create({ data: {
    profileId: profileA1, phone: `6011000${suffix}`, name: 'Synthetic detail contact',
    whatsappName: 'Synthetic detail contact', metadata: { fixture: 'detail' },
  } });
  const detailConversationA1 = await prisma.conversation.create({ data: {
    profileId: profileA1, contactId: detailContact.id,
    jid: `synthetic-detail-a1-${suffix}@s.whatsapp.net`, name: 'Synthetic detail A1',
    type: 'user', unreadCount: 3, metadata: { fixture: 'detail-a1' },
    lastMessageAt: new Date(-1000),
  } });
  const detailMessagesA1 = await Promise.all(Array.from({ length: 101 }, (_value, index) =>
    prisma.message.create({ data: {
      profileId: profileA1, conversationId: detailConversationA1.id,
      messageId: `provider-detail-a1-${String(index).padStart(3, '0')}-${suffix}`,
      direction: 'detail-fixture',
      senderJid: `synthetic-detail-a1-${suffix}@s.whatsapp.net`, type: 'detail-fixture',
      content: { text: `synthetic detail message ${index}` },
      status: index % 2 ? 'sent' : 'delivered', metadata: { index: index },
      timestamp: new Date(-101000 + index * 1000),
    } })));
  const detailConversationA2 = await prisma.conversation.create({ data: {
    profileId: profileA2, jid: `synthetic-detail-a2-${suffix}@s.whatsapp.net`,
    name: 'Synthetic empty detail A2', type: 'user', metadata: { fixture: 'detail-a2' },
  } });
  const detailConversationB = await prisma.conversation.create({ data: {
    profileId: profileB, jid: `synthetic-detail-b-${suffix}@s.whatsapp.net`,
    name: 'Synthetic detail B', type: 'user', metadata: { fixture: 'detail-b' },
  } });
  await prisma.message.create({ data: {
    profileId: profileB, conversationId: detailConversationB.id,
    messageId: `provider-detail-b-${suffix}`, direction: 'detail-fixture',
    senderJid: `synthetic-detail-b-${suffix}@s.whatsapp.net`, type: 'detail-fixture',
    content: { text: 'synthetic foreign detail' }, status: 'delivered',
    metadata: { fixture: 'detail-b' }, timestamp: new Date('2026-09-07T03:00:00Z'),
  } });

  const accessConversationA1 = await prisma.conversation.create({ data: {
    profileId: profileA1, jid: `synthetic-access-a1-${suffix}@s.whatsapp.net`,
    name: 'Synthetic access A1', type: 'user', metadata: { fixture: 'access-a1' },
    lastMessageAt: new Date(-200000),
  } });
  const accessMessagesA1 = await Promise.all(Array.from({ length: 4 }, (_value, index) =>
    prisma.message.create({ data: {
      profileId: profileA1, conversationId: accessConversationA1.id,
      messageId: `provider-access-a1-${index}-${suffix}`, direction: 'access-fixture',
      senderJid: `synthetic-access-a1-${suffix}@s.whatsapp.net`, type: 'access-fixture',
      content: { text: `synthetic access A1 ${index}` }, status: 'delivered',
      metadata: { fixture: 'access-a1', index: index },
      timestamp: new Date(-500000 + index * 1000),
    } })));
  const accessConversationA2 = await prisma.conversation.create({ data: {
    profileId: profileA2, jid: `synthetic-access-a2-${suffix}@s.whatsapp.net`,
    name: 'Synthetic access A2', type: 'user', metadata: { fixture: 'access-a2' },
    lastMessageAt: new Date(-300000),
  } });
  const accessMessageA2 = await prisma.message.create({ data: {
    profileId: profileA2, conversationId: accessConversationA2.id,
    messageId: `provider-access-a2-${suffix}`, direction: 'access-fixture',
    senderJid: `synthetic-access-a2-${suffix}@s.whatsapp.net`, type: 'access-fixture',
    content: { text: 'synthetic access A2' }, status: 'delivered',
    metadata: { fixture: 'access-a2' }, timestamp: new Date(-600000),
  } });
  const accessEmptyA2 = await prisma.conversation.create({ data: {
    profileId: profileA2, jid: `synthetic-access-empty-a2-${suffix}@s.whatsapp.net`,
    name: 'Synthetic empty access A2', type: 'user',
    metadata: { fixture: 'access-empty-a2' },
  } });
  const accessConversationB = await prisma.conversation.create({ data: {
    profileId: profileB, jid: `synthetic-access-b-${suffix}@s.whatsapp.net`,
    name: 'Synthetic access B', type: 'user', metadata: { fixture: 'access-b' },
    lastMessageAt: new Date(-400000),
  } });
  const accessMessagesB = await Promise.all(Array.from({ length: 2 }, (_value, index) =>
    prisma.message.create({ data: {
      profileId: profileB, conversationId: accessConversationB.id,
      messageId: `provider-access-b-${index}-${suffix}`, direction: 'access-fixture',
      senderJid: `synthetic-access-b-${suffix}@s.whatsapp.net`, type: 'access-fixture',
      content: { text: `synthetic access B ${index}` }, status: 'delivered',
      metadata: { fixture: 'access-b', index: index },
      timestamp: new Date(-700000 + index * 1000),
    } })));
  const inconsistentMessage = await prisma.message.create({ data: {
    profileId: profileA1, conversationId: accessConversationB.id,
    messageId: `provider-access-inconsistent-${suffix}`, direction: 'access-fixture',
    senderJid: `synthetic-access-inconsistent-${suffix}@s.whatsapp.net`,
    type: 'access-fixture', content: { text: 'synthetic inconsistent parent' },
    status: 'delivered', metadata: { fixture: 'access-inconsistent' },
    timestamp: new Date(-800000),
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

  const detailCredentials = [['jwt', jwtA], ['apiKey', readKey]];
  const detailSnapshotIds = [detailConversationA1.id, detailConversationB.id];
  const detailLimits = [[null, 50], ['1', 1], ['2', 2], ['100', 100]];
  const invalidDetailLimits = ['', '%20', '0', '-1', '1.5', 'word', 'Infinity',
    '101', '0x10', '1e2', '1&messageLimit=2'];
  const detailDenialBodies = [];

  for (const [credentialName, credential] of detailCredentials) {
    for (const [queryLimit, expectedLimit] of detailLimits) {
      const suffix = queryLimit === null ? '' : `?messageLimit=${queryLimit}`;
      const response = await requestWithoutConversationWrites({
        method: 'GET', route: `/api/v1/conversations/${detailConversationA1.id}${suffix}`,
        credential, expectedStatus: 200,
        label: `${credentialName} owned detail limit ${expectedLimit}`,
        conversationIds: detailSnapshotIds,
      });
      assert.deepEqual(response.value,
        await expectedConversationDetail(detailConversationA1.id, expectedLimit));
      assert.deepEqual(response.value.messages.map(message => message.id),
        detailMessagesA1.slice(-expectedLimit).map(message => message.id));
    }

    const emptyDetail = await requestWithoutConversationWrites({
      method: 'GET', route: `/api/v1/conversations/${detailConversationA2.id}`,
      credential, expectedStatus: 200, label: `${credentialName} empty A2 detail`,
      conversationIds: [detailConversationA2.id, detailConversationB.id],
    });
    assert.deepEqual(emptyDetail.value,
      await expectedConversationDetail(detailConversationA2.id, 50));
    assert.equal(emptyDetail.value.contact, null);
    assert.deepEqual(emptyDetail.value.messages, []);

    for (const invalidLimit of invalidDetailLimits) {
      await requestWithoutConversationWrites({
        method: 'GET',
        route: `/api/v1/conversations/${detailConversationA1.id}?messageLimit=${invalidLimit}`,
        credential, expectedStatus: 400,
        label: `${credentialName} invalid detail limit ${invalidLimit}`,
        conversationIds: detailSnapshotIds,
      });
    }

    const missingId = crypto.randomUUID();
    const foreignDetail = await requestWithoutConversationWrites({
      method: 'GET', route: `/api/v1/conversations/${detailConversationB.id}`,
      credential, expectedStatus: 404, label: `${credentialName} foreign detail`,
      conversationIds: detailSnapshotIds,
    });
    const missingDetail = await requestWithoutConversationWrites({
      method: 'GET', route: `/api/v1/conversations/${missingId}`,
      credential, expectedStatus: 404, label: `${credentialName} missing detail`,
      conversationIds: detailSnapshotIds,
    });
    const invalidForeignDetail = await requestWithoutConversationWrites({
      method: 'GET',
      route: `/api/v1/conversations/${detailConversationB.id}?messageLimit=invalid`,
      credential, expectedStatus: 404,
      label: `${credentialName} invalid foreign detail`,
      conversationIds: detailSnapshotIds,
    });
    const invalidMissingDetail = await requestWithoutConversationWrites({
      method: 'GET', route: `/api/v1/conversations/${missingId}?messageLimit=invalid`,
      credential, expectedStatus: 404,
      label: `${credentialName} invalid missing detail`,
      conversationIds: detailSnapshotIds,
    });
    const forgedDetail = await requestWithoutConversationWrites({
      method: 'GET',
      route: routeWithForgedSelectors(`/api/v1/conversations/${detailConversationB.id}`,
        profileA1, jwtA.organizationId),
      credential, expectedStatus: 404, label: `${credentialName} forged detail selectors`,
      conversationIds: detailSnapshotIds,
    });
    assert.deepEqual(foreignDetail.value, missingDetail.value);
    assert.deepEqual(invalidForeignDetail.value, foreignDetail.value);
    assert.deepEqual(invalidMissingDetail.value, foreignDetail.value);
    assert.deepEqual(forgedDetail.value, foreignDetail.value);
    detailDenialBodies.push(foreignDetail.value);
  }
  assert.deepEqual(detailDenialBodies[0], detailDenialBodies[1]);

  for (const [label, credential] of [
    ['missing credential', null],
    ['invalid JWT', { type: 'jwt', value: 'invalid' }],
    ['invalid API key', { type: 'api-key', value: 'invalid' }],
  ]) {
    await requestWithoutConversationWrites({
      method: 'GET', route: `/api/v1/conversations/${detailConversationA1.id}`,
      credential, expectedStatus: 401, label: `detail ${label}`,
      conversationIds: detailSnapshotIds,
    });
  }
  report.observed.conversationDetail = {
    jwtOwn: 200, apiKeyOwn: 200, defaultLimit: 50, maximumLimit: 100,
    invalidLimit: 400, foreign: 404, missing: 404, forgedSelectors: 404,
    unauthenticated: 401, deniedBusinessWrites: 0, providerCalls: 0,
  };
  report.protected.push('Conversation detail enforces organization ownership before strict message-limit validation.');
  report.decisions.push('Conversation detail accepts only canonical decimal limits from 1 through 100 and defaults to 50.');

  const messageAccessCredentials = [['jwt', jwtA], ['apiKey', readKey]];
  const accessSnapshotIds = [accessConversationA1.id, accessConversationB.id];
  const expectedAccessMessages = messages => JSON.parse(JSON.stringify(messages));

  for (const [credentialName, credential] of messageAccessCredentials) {
    const defaultConversationMessages = await requestWithoutConversationWrites({
      method: 'GET', route: `/api/v1/messages/conversation/${accessConversationA1.id}`,
      credential, expectedStatus: 200,
      label: `${credentialName} conversation messages default`,
      conversationIds: accessSnapshotIds,
    });
    assert.deepEqual(defaultConversationMessages.value,
      { messages: expectedAccessMessages(accessMessagesA1), hasMore: false });

    const limitedConversationMessages = await requestWithoutConversationWrites({
      method: 'GET',
      route: `/api/v1/messages/conversation/${accessConversationA1.id}?limit=2`,
      credential, expectedStatus: 200,
      label: `${credentialName} conversation messages limit`,
      conversationIds: accessSnapshotIds,
    });
    assert.deepEqual(limitedConversationMessages.value,
      { messages: expectedAccessMessages(accessMessagesA1.slice(-2)), hasMore: true });

    const cursorConversationMessages = await requestWithoutConversationWrites({
      method: 'GET', route: `/api/v1/messages/conversation/${accessConversationA1.id}` +
        `?limit=2&before=${accessMessagesA1[2].id}`,
      credential, expectedStatus: 200,
      label: `${credentialName} conversation messages cursor`,
      conversationIds: accessSnapshotIds,
    });
    assert.deepEqual(cursorConversationMessages.value,
      { messages: expectedAccessMessages(accessMessagesA1.slice(0, 2)), hasMore: true });

    const emptyConversationMessages = await requestWithoutConversationWrites({
      method: 'GET', route: `/api/v1/messages/conversation/${accessEmptyA2.id}`,
      credential, expectedStatus: 200,
      label: `${credentialName} empty A2 conversation messages`,
      conversationIds: [accessEmptyA2.id, accessConversationB.id],
    });
    assert.deepEqual(emptyConversationMessages.value, { messages: [], hasMore: false });

    const cursorDenialBodies = [];
    for (const [label, cursor] of [
      ['missing', crypto.randomUUID()],
      ['same organization', accessMessageA2.id],
      ['foreign organization', accessMessagesB[0].id],
    ]) {
      const response = await requestWithoutConversationWrites({
        method: 'GET', route: `/api/v1/messages/conversation/${accessConversationA1.id}` +
          `?limit=2&before=${cursor}`,
        credential, expectedStatus: 404,
        label: `${credentialName} ${label} conversation cursor`,
        conversationIds: accessSnapshotIds,
      });
      cursorDenialBodies.push(response.value);
    }
    assert.deepEqual(cursorDenialBodies[0], cursorDenialBodies[1]);
    assert.deepEqual(cursorDenialBodies[0], cursorDenialBodies[2]);

    const missingConversationId = crypto.randomUUID();
    const foreignConversationMessages = await requestWithoutConversationWrites({
      method: 'GET', route: `/api/v1/messages/conversation/${accessConversationB.id}`,
      credential, expectedStatus: 404,
      label: `${credentialName} foreign conversation messages`,
      conversationIds: accessSnapshotIds,
    });
    const missingConversationMessages = await requestWithoutConversationWrites({
      method: 'GET', route: `/api/v1/messages/conversation/${missingConversationId}`,
      credential, expectedStatus: 404,
      label: `${credentialName} missing conversation messages`,
      conversationIds: accessSnapshotIds,
    });
    const invalidCursorForeignConversation = await requestWithoutConversationWrites({
      method: 'GET', route: `/api/v1/messages/conversation/${accessConversationB.id}` +
        `?before=${crypto.randomUUID()}`,
      credential, expectedStatus: 404,
      label: `${credentialName} foreign conversation before cursor validation`,
      conversationIds: accessSnapshotIds,
    });
    const forgedConversationMessages = await requestWithoutConversationWrites({
      method: 'GET', route: routeWithForgedSelectors(
        `/api/v1/messages/conversation/${accessConversationB.id}`, profileA1,
        jwtA.organizationId), credential, expectedStatus: 404,
      label: `${credentialName} forged conversation message selectors`,
      conversationIds: accessSnapshotIds,
    });
    assert.deepEqual(foreignConversationMessages.value, missingConversationMessages.value);
    assert.deepEqual(invalidCursorForeignConversation.value, foreignConversationMessages.value);
    assert.deepEqual(forgedConversationMessages.value, foreignConversationMessages.value);

    for (const ownedMessage of [accessMessagesA1[0], accessMessageA2]) {
      const conversationId = ownedMessage.conversationId;
      const messageDetail = await requestWithoutConversationWrites({
        method: 'GET', route: `/api/v1/messages/${ownedMessage.id}`,
        credential, expectedStatus: 200,
        label: `${credentialName} owned message detail`,
        conversationIds: [conversationId, accessConversationB.id],
      });
      assert.deepEqual(messageDetail.value, await expectedMessageDetail(ownedMessage.id));
    }

    const missingMessageId = crypto.randomUUID();
    const foreignMessage = await requestWithoutConversationWrites({
      method: 'GET', route: `/api/v1/messages/${accessMessagesB[0].id}`,
      credential, expectedStatus: 404, label: `${credentialName} foreign message detail`,
      conversationIds: accessSnapshotIds,
    });
    const missingMessage = await requestWithoutConversationWrites({
      method: 'GET', route: `/api/v1/messages/${missingMessageId}`,
      credential, expectedStatus: 404, label: `${credentialName} missing message detail`,
      conversationIds: accessSnapshotIds,
    });
    const inconsistentMessageDetail = await requestWithoutConversationWrites({
      method: 'GET', route: `/api/v1/messages/${inconsistentMessage.id}`,
      credential, expectedStatus: 404,
      label: `${credentialName} inconsistent message detail`,
      conversationIds: accessSnapshotIds,
    });
    const forgedMessage = await requestWithoutConversationWrites({
      method: 'GET', route: routeWithForgedSelectors(
        `/api/v1/messages/${accessMessagesB[0].id}`, profileA1, jwtA.organizationId),
      credential, expectedStatus: 404,
      label: `${credentialName} forged message selectors`,
      conversationIds: accessSnapshotIds,
    });
    assert.deepEqual(foreignMessage.value, missingMessage.value);
    assert.deepEqual(inconsistentMessageDetail.value, foreignMessage.value);
    assert.deepEqual(forgedMessage.value, foreignMessage.value);

    for (const [profileLabel, deleteProfileId, deleteConversation] of [
      ['A1', profileA1, accessConversationA1],
      ['A2', profileA2, accessConversationA2],
    ]) {
      const deleteTarget = await prisma.message.create({ data: {
        profileId: deleteProfileId, conversationId: deleteConversation.id,
        messageId: `provider-access-delete-${credentialName}-${profileLabel}-${suffix}`,
        direction: 'access-fixture', senderJid: `synthetic-delete-${suffix}@s.whatsapp.net`,
        type: 'access-fixture', content: { text: 'synthetic local delete target' },
        status: 'delivered', metadata: { fixture: 'delete-target' },
        timestamp: new Date(-900000),
      } });
      const deleteBefore = await mutationSnapshot(deleteConversation.id);
      const foreignBefore = await mutationSnapshot(accessConversationB.id);
      const deleteResponse = await request('DELETE', `/api/v1/messages/${deleteTarget.id}`,
        credential);
      assert.equal(deleteResponse.status, 200);
      assert.deepEqual(deleteResponse.value, { success: true });
      assert.equal(await prisma.message.findUnique({ where: { id: deleteTarget.id } }), null);
      const deleteAfter = await mutationSnapshot(deleteConversation.id);
      assert.deepEqual(deleteAfter.conversation, deleteBefore.conversation);
      assert.deepEqual(deleteAfter.messages,
        deleteBefore.messages.filter(message => message.id !== deleteTarget.id));
      assert.deepEqual(await mutationSnapshot(accessConversationB.id), foreignBefore);

      const repeatedDelete = await requestWithoutConversationWrites({
        method: 'DELETE', route: `/api/v1/messages/${deleteTarget.id}`,
        credential, expectedStatus: 404,
        label: `${credentialName} repeated ${profileLabel} local delete`,
        conversationIds: [deleteConversation.id, accessConversationB.id],
      });
      assert.deepEqual(repeatedDelete.value, foreignMessage.value);
    }
    for (const [label, messageId] of [
      ['foreign', accessMessagesB[1].id],
      ['missing', crypto.randomUUID()],
      ['inconsistent', inconsistentMessage.id],
    ]) {
      const response = await requestWithoutConversationWrites({
        method: 'DELETE', route: `/api/v1/messages/${messageId}`,
        credential, expectedStatus: 404, label: `${credentialName} ${label} local delete`,
        conversationIds: accessSnapshotIds,
      });
      assert.deepEqual(response.value, foreignMessage.value);
    }
    const forgedDelete = await requestWithoutConversationWrites({
      method: 'DELETE', route: routeWithForgedSelectors(
        `/api/v1/messages/${accessMessagesB[1].id}`, profileA1, jwtA.organizationId),
      credential, expectedStatus: 404, label: `${credentialName} forged local delete`,
      conversationIds: accessSnapshotIds,
    });
    assert.deepEqual(forgedDelete.value, foreignMessage.value);
    const forgedBodyDelete = await requestWithoutConversationWrites({
      method: 'DELETE', route: `/api/v1/messages/${accessMessagesB[1].id}`,
      credential, body: { profileId: profileA1, organizationId: jwtA.organizationId },
      expectedStatus: 404, label: `${credentialName} forged body local delete`,
      conversationIds: accessSnapshotIds,
    });
    assert.deepEqual(forgedBodyDelete.value, foreignMessage.value);
  }

  for (const [routeName, method, route] of [
    ['conversation messages', 'GET', `/api/v1/messages/conversation/${accessConversationA1.id}`],
    ['message detail', 'GET', `/api/v1/messages/${accessMessagesA1[0].id}`],
    ['local delete', 'DELETE', `/api/v1/messages/${accessMessagesA1[0].id}`],
  ]) {
    for (const [credentialName, credential] of [
      ['missing credential', null],
      ['invalid JWT', { type: 'jwt', value: 'invalid' }],
      ['invalid API key', { type: 'api-key', value: 'invalid' }],
    ]) {
      await requestWithoutConversationWrites({ method, route, credential,
        expectedStatus: 401, label: `${routeName} ${credentialName}`,
        conversationIds: accessSnapshotIds });
    }
  }
  report.observed.messageAccess = {
    jwtOwn: 200, apiKeyOwn: 200, foreign: 404, missing: 404,
    invalidCursor: 404, localDelete: 200, repeatedDelete: 404,
    inconsistentParent: 404, unauthenticated: 401, deniedBusinessWrites: 0,
  };
  report.protected.push('Conversation message reads, message detail and local deletion enforce organization ownership.');
  report.decisions.push('Message conversation cursors must belong to the selected authorized conversation.');

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
    const deniedConversationIds = [
      foreignFixture.conversation.id,
      callerOrganizationFixture.conversation.id,
    ];
    const denialBodies = [];

    for (const [credentialName, credential] of mutationCredentials) {
      const missingId = crypto.randomUUID();
      const directForeign = await requestWithoutConversationWrites({
        method: mutation.method, route: foreignPath, credential, expectedStatus: 404,
        label: `${credentialName} ${mutation.name} foreign denial`,
        conversationIds: deniedConversationIds,
      });
      const missingConversation = await requestWithoutConversationWrites({
        method: mutation.method,
        route: `/api/v1/conversations/${missingId}${mutation.suffix}`,
        credential, expectedStatus: 404,
        label: `${credentialName} ${mutation.name} missing denial`,
        conversationIds: deniedConversationIds,
      });
      const forgedQuery = await requestWithoutConversationWrites({
        method: mutation.method,
        route: routeWithForgedSelectors(foreignPath, profileA1, jwtA.organizationId),
        credential, expectedStatus: 404,
        label: `${credentialName} ${mutation.name} forged query denial`,
        conversationIds: deniedConversationIds,
      });
      const forgedBody = await requestWithoutConversationWrites({
        method: mutation.method, route: foreignPath, credential,
        body: { profileId: profileA1, organizationId: jwtA.organizationId },
        expectedStatus: 404,
        label: `${credentialName} ${mutation.name} forged body denial`,
        conversationIds: deniedConversationIds,
      });
      assert.deepEqual(directForeign.value, missingConversation.value,
        `${credentialName} ${mutation.name} must not disclose foreign existence`);
      denialBodies.push(directForeign.value);
      assert.deepEqual(forgedQuery.value, directForeign.value);
      assert.deepEqual(forgedBody.value, directForeign.value);
    }
    assert.deepEqual(denialBodies[0], denialBodies[1],
      `${mutation.name} JWT and API-key denial bodies must match`);

    const unauthenticatedFixture = await mutationFixture(profileA1, `unauthenticated-${mutation.name}`);
    const unauthenticatedPath = `/api/v1/conversations/${unauthenticatedFixture.conversation.id}${mutation.suffix}`;
    const authenticationDenialIds = [
      unauthenticatedFixture.conversation.id,
      foreignFixture.conversation.id,
    ];
    await requestWithoutConversationWrites({
      method: mutation.method, route: unauthenticatedPath, expectedStatus: 401,
      label: `${mutation.name} missing credential`,
      conversationIds: authenticationDenialIds,
    });
    await requestWithoutConversationWrites({
      method: mutation.method, route: unauthenticatedPath,
      credential: { type: 'jwt', value: 'invalid' }, expectedStatus: 401,
      label: `${mutation.name} invalid credential`,
      conversationIds: authenticationDenialIds,
    });

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

  assert.equal(report.knownGaps.length, process.env.AUTHZ_STATIC_FIXTURE === '1' ? 4 : 3);
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (organizations.length) {
    await prisma.organization.deleteMany({ where: { id: { in: organizations } } });
  }
  await prisma.$disconnect();
}
