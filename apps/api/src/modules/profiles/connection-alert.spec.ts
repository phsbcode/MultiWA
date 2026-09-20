import { expect, it, vi } from 'vitest';
vi.mock('@multiwa/database', () => ({ prisma: { $executeRaw: vi.fn().mockResolvedValue(1) } }));
import { connectionAlertCode, readConnectionAlert, recordConnectionAlert } from './connection-alert';
import { prisma } from '@multiwa/database';
it('classifies restrictions separately from exhausted transport retries',()=>{
 expect(connectionAlertCode('Forbidden',false)).toBe('FORBIDDEN');
 expect(connectionAlertCode('Connection Failure',false)).toBeNull();
 expect(connectionAlertCode('Connection Failure',true)).toBe('RETRIES_EXHAUSTED');
 expect(connectionAlertCode('Logged Out',false)).toBe('LOGGED_OUT');
});
it('returns only safe known codes and timestamps, excluding raw details',()=>{
 const value=readConnectionAlert({connectionAlert:{code:'FORBIDDEN',occurredAt:'2026-09-20T01:00:00Z',raw:'SECRET'}});
 expect(value).toEqual({code:'FORBIDDEN',occurredAt:'2026-09-20T01:00:00Z',active:true});
 expect(readConnectionAlert({connectionAlert:{code:'SECRET',occurredAt:'2026-09-20'}})).toBeNull();
 expect(readConnectionAlert({connectionAlert:{code:'MANUAL_PAUSE',occurredAt:'2026-09-20'}})?.active).toBe(false);
});
it('persists only the alert JSON field with parameterized profile identity',async()=>{
 await recordConnectionAlert('synthetic-profile','FORBIDDEN');
 const [sql,value,id]=vi.mocked(prisma.$executeRaw).mock.calls.at(-1)!;
 expect(String(sql)).toContain('jsonb_set');expect(JSON.parse(String(value)).code).toBe('FORBIDDEN');expect(id).toBe('synthetic-profile');
});
