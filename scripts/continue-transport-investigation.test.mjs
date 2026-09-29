import test from 'node:test';
import assert from 'node:assert/strict';
import { targetMatches, observationEvent } from './continue-transport-investigation.mjs';

const binding = { name: 'owned-investigator', terminalId: 'owned-terminal', cwd: '/project' };
test('refuses another occupant, terminal, working directory or session', () => {
  const agent = { agent: 'codex', name: binding.name, terminal_id: binding.terminalId, cwd: binding.cwd };
  assert.equal(targetMatches(agent, binding), true);
  for (const key of ['name', 'terminal_id', 'cwd', 'agent']) {
    assert.equal(targetMatches({ ...agent, [key]: 'unrelated' }, binding), false);
  }
  assert.equal(targetMatches(agent, { ...binding, sessionId: 'required' }), false);
  assert.equal(targetMatches(null, binding), false);
});
const observation = { latest: { observedAt: new Date(100000).toISOString(), sample: { state: '01' } },
  now: 110000, startedAt: 100000, captureStartedAt: null, captureRunning: false, captureStatus: '' };
test('does not trigger stable reports or a pending not-yet-started capture', () => {
  assert.equal(observationEvent(observation), null);
  assert.equal(observationEvent({ ...observation, captureStartedAt: 109000 }), null);
  assert.equal(observationEvent({ ...observation, captureStartedAt: 100000, captureRunning: true }), null);
});
test('triggers socket terminal/loss/replacement, stale observation and capture failures', () => {
  assert.equal(observationEvent({ ...observation, latest: { ...observation.latest, sample: null } }), 'socket_terminal_change');
  assert.equal(observationEvent({ ...observation, latest: { ...observation.latest, sample: { state: '08' } } }), 'socket_terminal_change');
  assert.equal(observationEvent({ ...observation, latest: { replaced: true } }), 'socket_identity_changed');
  assert.equal(observationEvent({ ...observation, now: 200001 }), 'metadata_observer_stale');
  assert.equal(observationEvent({ ...observation, captureStartedAt: 100000, now: 120000 }), 'header_capture_stopped');
  assert.equal(observationEvent({ ...observation, captureStartedAt: 100000, captureStatus: 'Operation not permitted' }), 'header_capture_failed');
});
