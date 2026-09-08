import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { prisma } from '@multiwa/database';
import { TENANT_CHECKS, TenantCheck, TenantResource } from './require-tenant.decorator';

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const checks = this.reflector.getAllAndOverride<TenantCheck[]>(TENANT_CHECKS, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!checks?.length) return true;

    const request = context.switchToHttp().getRequest();
    const organizationId = request.user?.organizationId;
    if (typeof organizationId !== 'string' || !organizationId.trim()) {
      throw new ForbiddenException('Organization context is required.');
    }

    for (const check of checks) {
      const source = check.from === 'param' ? request.params :
        check.from === 'query' ? request.query : request.body;
      const value = source?.[check.key];
      if (value === undefined || value === null || value === '') {
        if (check.optional) continue;
        throw new BadRequestException(`Missing ${check.key}.`);
      }
      if (typeof value !== 'string') {
        throw new BadRequestException(`Invalid ${check.key}.`);
      }
      if (!await this.belongsToOrganization(check.resource, value, organizationId)) {
        throw new NotFoundException('Resource not found.');
      }
    }
    return true;
  }

  private async belongsToOrganization(
    resource: TenantResource,
    id: string,
    organizationId: string,
  ): Promise<boolean> {
    const select = { id: true } as const;
    if (resource === 'profile') {
      return Boolean(await prisma.profile.findFirst({
        where: { id, workspace: { organizationId } },
        select,
      }));
    }
    if (resource === 'conversation') {
      return Boolean(await prisma.conversation.findFirst({
        where: { id, profile: { workspace: { organizationId } } },
        select,
      }));
    }
    if (resource === 'message') {
      const message = await prisma.message.findFirst({
        where: { id, profile: { workspace: { organizationId } } },
        select: { id: true, profileId: true,
          conversation: { select: { profileId: true } } },
      });
      return Boolean(message && message.profileId === message.conversation.profileId);
    }
    return false;
  }
}
