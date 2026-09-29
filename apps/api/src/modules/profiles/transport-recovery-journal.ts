import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type RecoveryPause = 'MANUAL_PAUSE' | 'RETRIES_EXHAUSTED' | 'FORBIDDEN' | 'LOGGED_OUT' |
  'CONNECTION_REPLACED' | 'BAD_SESSION' | 'AUTH_STORAGE_UNAVAILABLE' | 'MULTIDEVICE_MISMATCH' |
  'REACHOUT_TIMELOCK' | 'UNKNOWN_FAILURE' | 'PAIRING_REQUIRED' | 'UNCLEAN_RESTART' | 'UNINITIALIZED' | 'FREQUENT_DISCONNECTS';
export interface RecoveryState {
  version: 1;
  revision: number;
  phase: 'paused' | 'retry_wait' | 'connecting' | 'stabilizing' | 'connected';
  pauseReason: RecoveryPause | null;
  attemptsUsed: number;
  disconnects: string[];
  nextRetryAt: string | null;
  attemptStartedAt: string | null;
  firstGapAt: string | null;
  gapAccuracy: 'observed' | 'conservative';
  lastDisconnectedAt: string | null;
  lastConnectedAt: string | null;
  settledAt: string | null;
  stableAt: string | null;
  pairingRestartUsed: boolean;
  qrIssued: boolean;
  resumeOnStartup: boolean;
}
export interface RecoveryJournal {
  read(): Promise<RecoveryState | null>;
  write(state: RecoveryState): Promise<void>;
}
export function initialRecoveryState(): RecoveryState {
  return { version: 1, revision: 1, phase: 'paused', pauseReason: 'UNINITIALIZED',
    attemptsUsed: 0, disconnects: [], nextRetryAt: null, attemptStartedAt: null, firstGapAt: null,
    gapAccuracy: 'observed', lastDisconnectedAt: null, lastConnectedAt: null,
    settledAt: null, stableAt: null, pairingRestartUsed: false, qrIssued: false, resumeOnStartup: false };
}
const pauses: RecoveryPause[] = ['MANUAL_PAUSE', 'RETRIES_EXHAUSTED', 'FORBIDDEN', 'LOGGED_OUT',
  'CONNECTION_REPLACED', 'BAD_SESSION', 'AUTH_STORAGE_UNAVAILABLE', 'MULTIDEVICE_MISMATCH',
  'REACHOUT_TIMELOCK', 'UNKNOWN_FAILURE', 'PAIRING_REQUIRED', 'UNCLEAN_RESTART', 'UNINITIALIZED', 'FREQUENT_DISCONNECTS'];
export function validateRecoveryState(value: unknown): RecoveryState {
  const s = value as RecoveryState;
  if (!s || s.version !== 1 || !Number.isSafeInteger(s.revision) || s.revision < 1 ||
      !['paused', 'retry_wait', 'connecting', 'stabilizing', 'connected'].includes(s.phase) ||
      (s.pauseReason !== null && !pauses.includes(s.pauseReason)) ||
      !Number.isInteger(s.attemptsUsed) || s.attemptsUsed < 0 || s.attemptsUsed > 3 ||
      !['observed', 'conservative'].includes(s.gapAccuracy)) throw Error('Invalid recovery journal');
  if (!Array.isArray(s.disconnects) || s.disconnects.length > 4 ||
      s.disconnects.some(at => typeof at !== 'string' || !Number.isFinite(Date.parse(at)))) {
    throw Error('Invalid recovery frequency history');
  }
  for (const key of ['nextRetryAt', 'attemptStartedAt', 'firstGapAt', 'lastDisconnectedAt',
    'lastConnectedAt', 'settledAt', 'stableAt'] as const) {
    if (s[key] !== null && (typeof s[key] !== 'string' || !Number.isFinite(Date.parse(s[key])))) {
      throw Error('Invalid recovery timestamp');
    }
  }
  for (const key of ['pairingRestartUsed', 'qrIssued', 'resumeOnStartup'] as const) {
    if (typeof s[key] !== 'boolean') throw Error('Invalid recovery flag');
  }
  if (s.phase === 'paused' && !s.pauseReason || s.phase !== 'paused' && s.pauseReason) {
    throw Error('Inconsistent recovery pause');
  }
  if (s.resumeOnStartup && s.phase !== 'retry_wait') throw Error('Invalid startup recovery intent');
  return s;
}

export class FileRecoveryJournal implements RecoveryJournal {
  private readonly directory: string;
  private readonly file: string;
  constructor(baseDirectory: string, profileId: string) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(profileId)) throw Error('Invalid recovery profile');
    this.directory = path.join(baseDirectory, '.connection-recovery');
    this.file = path.join(this.directory, `${profileId}.json`);
  }
  async read(): Promise<RecoveryState | null> {
    try {
      const stat = await fs.lstat(this.file);
      if (!stat.isFile() || stat.size > 16384) throw Error('Invalid recovery journal file');
      return validateRecoveryState(JSON.parse(await fs.readFile(this.file, 'utf8')));
    } catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async write(state: RecoveryState): Promise<void> {
    validateRecoveryState(state);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    const handle = await fs.open(temporary, 'w', 0o600);
    try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, this.file);
    const directory = await fs.open(this.directory, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
