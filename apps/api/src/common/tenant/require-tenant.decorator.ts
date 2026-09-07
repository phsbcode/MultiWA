import { SetMetadata } from '@nestjs/common';

export const TENANT_CHECKS = 'multiwa:tenant-checks';

export type TenantResource = 'profile' | 'conversation';
export type TenantSelectorLocation = 'param' | 'query' | 'body';

export interface TenantCheck {
  resource: TenantResource;
  from: TenantSelectorLocation;
  key: string;
  optional?: boolean;
}

export const RequireTenant = (...checks: TenantCheck[]) => SetMetadata(TENANT_CHECKS, checks);
