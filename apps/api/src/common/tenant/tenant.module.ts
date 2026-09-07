import { Global, Module } from '@nestjs/common';
import { TenantGuard } from './tenant.guard';

@Global()
@Module({ providers: [TenantGuard], exports: [TenantGuard] })
export class TenantModule {}
