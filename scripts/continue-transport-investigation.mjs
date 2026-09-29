import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

export function targetMatches(agent, binding) {
  return agent?.agent === 'codex' && agent.name === binding.name &&
    agent.terminal_id === binding.terminalId && agent.cwd === binding.cwd &&
    (!binding.sessionId || agent.agent_session?.value === binding.sessionId);
}

export function observationEvent({ latest, now, startedAt, captureStartedAt,
  captureRunning, captureStatus }) {
  if (latest?.replaced) return 'socket_identity_changed';
  if (latest?.readError) return 'socket_observation_failed';
  if (latest && (!latest.sample || latest.sample.state !== '01')) return 'socket_terminal_change';
  if (now - (latest ? Date.parse(latest.observedAt) : startedAt) > 90000) return 'metadata_observer_stale';
  if (captureStartedAt && /permission denied|not permitted|no such device|syntax error|cannot|no space left/i.test(captureStatus)) {
    return 'header_capture_failed';
  }
  if (captureStartedAt && !captureRunning && now - captureStartedAt > 15000) return 'header_capture_stopped';
  return null;
}

function latestSample(directory, generation) {
  const names = fs.readdirSync(directory).filter(name => /^\d{4}-.*\.jsonl\.gz$/.test(name)).sort();
  if (!names.length) return null;
  const text = gunzipSync(fs.readFileSync(path.join(directory, names.at(-1))),
    { maxOutputLength: 2 * 1024 ** 2 }).toString('utf8');
  return text.trim().split('\n').map(line => JSON.parse(line)).reverse()
    .find(value => value.generation === generation) || null;
}

function captureIsRunning(directory) {
  let pids;
  try { pids = execFileSync('pgrep', ['-u', String(process.getuid()), '-x', 'tcpdump'],
    { encoding: 'utf8', timeout: 3000 }).trim().split(/\s+/); }
  catch { return false; }
  return pids.some(pid => {
    try {
      const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      return args[args.indexOf('-w') + 1] === path.join(directory, 'mm-headers.pcap');
    } catch { return false; }
  });
}

export async function continueOnEvent(config) {
  // Inherit the real caller environment. Never manufacture a Herdr context.
  if (process.env.HERDR_ENV !== '1') throw Error('Not a Herdr-managed caller');
  if (!Number.isInteger(config.seconds) || config.seconds < 1 || config.seconds > 86400) {
    throw Error('Continuation duration must be bounded to one day');
  }
  process.umask(0o077);
  const startedAt = Date.now(), deadline = performance.now() + config.seconds * 1000;
  const statePath = path.join(config.controlDirectory, 'continuation-state.json');
  const write = value => {
    fs.writeFileSync(statePath + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(statePath + '.tmp', statePath);
  };
  let pending = null, stopped = false, captureStartedAt = null;
  process.once('SIGTERM', () => { stopped = true; });
  process.once('SIGINT', () => { stopped = true; });
  while (!stopped) {
    const now = Date.now();
    let latest = null, captureStatus = '';
    try {
      latest = latestSample(config.observationDirectory, config.generation);
      const statusFile = path.join(config.captureDirectory, 'capture-status.log');
      if (fs.existsSync(statusFile)) {
        captureStartedAt ??= fs.statSync(statusFile).mtimeMs;
        const fd = fs.openSync(statusFile, 'r');
        try { const buffer = Buffer.alloc(65536); captureStatus = buffer.subarray(0,
          fs.readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8'); }
        finally { fs.closeSync(fd); }
      }
      pending ??= observationEvent({ latest, now, startedAt, captureStartedAt,
        captureRunning: captureStartedAt ? captureIsRunning(config.captureDirectory) : false,
        captureStatus });
    } catch { pending ??= 'observation_read_failed'; }
    if (performance.now() >= deadline) pending ??= 'bounded_observation_expired';
    write({ status: pending ? 'event_pending' : 'armed', observedAt: new Date(now).toISOString(),
      event: pending, target: config.binding, generation: config.generation,
      lastSampleAt: latest?.observedAt || null, captureStartedAt });
    if (pending) {
      let agent;
      try { agent = JSON.parse(execFileSync('herdr', ['agent', 'get', config.binding.name],
        { encoding: 'utf8', timeout: 10000 })).result.agent; }
      catch { write({ status: 'identity_unavailable', event: pending }); return; }
      if (!targetMatches(agent, config.binding)) {
        write({ status: 'identity_mismatch_refused', event: pending }); return;
      }
      if (['idle', 'done', 'working'].includes(agent.agent_status)) {
        const prompt = 'MULTIWA NEXT-EVENT CONTINUATION, authorized ongoing cause investigation. ' +
          `Observed ${pending} at ${new Date(now).toISOString()} for generation ${config.generation}. ` +
          `Metadata: ${config.observationDirectory}. Header capture: ${config.captureDirectory}. ` +
          'Resume investigation now: inspect the latest exact-tuple samples and capture status, ' +
          'correlate any header-only FIN/RST/sequence evidence with real whatsapp_transport_close ' +
          'diagnostics for this generation, excluding all synthetic/archive_schema_probe events. ' +
          'Preserve evidence and report findings/limits directly to w9:p2 with herdr agent prompt ' +
          'without --wait. No reconnect, sends, scans, resets, re-pairing, live injection, or ' +
          'privilege bypass under this continuation. Do not infer application intent from FIN/IP. ' +
          'No acknowledgement loop; do not send repetitive stable-state reports.';
        try {
          execFileSync('herdr', ['agent', 'prompt', config.binding.name, prompt],
            { timeout: 10000, stdio: 'pipe' });
          write({ status: 'continuation_submitted', event: pending,
            submittedAt: new Date().toISOString(), target: config.binding });
          return;
        } catch (error) {
          let code;
          try { code = JSON.parse(String(error.stderr)).error.code; } catch {}
          if (code !== 'agent_blocked') {
            // A timeout is ambiguous. Never risk a duplicate submission.
            write({ status: 'submission_failed_no_retry', event: pending, code: code || 'unknown' });
            return;
          }
        }
      }
      // Do not answer approvals/questions. Keep pending only within the bounded run.
      if (performance.now() >= deadline) { write({ status: 'expired_while_target_blocked', event: pending }); return; }
    }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  write({ status: 'stopped' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  continueOnEvent(config).catch(() => { console.error('Bounded continuation stopped'); process.exitCode = 1; });
}
