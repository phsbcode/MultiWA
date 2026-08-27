// MultiWA Gateway API - Profiles Service
// apps/api/src/modules/profiles/profiles.service.ts

import { Injectable, NotFoundException, BadRequestException, Inject, forwardRef } from '@nestjs/common';
import { prisma } from '@multiwa/database';
import { CreateDntOperationsProfileDto, CreateProfileDto, UpdateProfileDto } from './dto';
import { EngineManagerService } from './engine-manager.service';
import {
  profileAllowsDntOperations,
  profileSettingsWithDntOperationsAccess,
  profileSettingsWithEngine,
  resolveProfileEngineType,
} from './profile-engine';

@Injectable()
export class ProfilesService {
  constructor(
    @Inject(forwardRef(() => EngineManagerService))
    private readonly engineManager: EngineManagerService,
  ) {}

  async findAll(organizationId: string, workspaceId?: string) {
    const workspaces = await prisma.workspace.findMany({
      where: { organizationId },
      select: { id: true },
    });

    const workspaceIds = workspaceId 
      ? [workspaceId] 
      : workspaces.map(w => w.id);

    const profiles = await prisma.profile.findMany({
      where: { workspaceId: { in: workspaceIds } },
      include: { 
        workspace: true,
        _count: { select: { messages: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Map fields for frontend compatibility
    return profiles.map(({ _count, ...profile }) => {
      let parsedSessionData = null;
      try {
        if (profile.sessionData) {
          parsedSessionData = typeof profile.sessionData === 'string' 
            ? JSON.parse(profile.sessionData) 
            : profile.sessionData;
        }
      } catch {}

      return {
        ...profile,
        engine: resolveProfileEngineType(profile.settings),
        name: profile.displayName,
        phone: profile.phoneNumber,
        sessionData: parsedSessionData,
        messageCount: _count?.messages || 0,
      };
    });
  }

  async findOne(id: string, organizationId: string) {
    const profile = await prisma.profile.findFirst({
      where: { id, workspace: { organizationId } },
      include: { workspace: true },
    });

    if (!profile) {
      throw new NotFoundException('Profile not found');
    }

    return {
      ...profile,
      engine: resolveProfileEngineType(profile.settings),
      dntOperationsAccess: profileAllowsDntOperations(profile.settings),
    };
  }

  async create(dto: CreateProfileDto, user: any) {
    // Verify workspace belongs to user's organization
    const workspace = await prisma.workspace.findFirst({
      where: {
        id: dto.workspaceId,
        organizationId: user.organizationId,
      },
    });

    if (!workspace) {
      throw new BadRequestException('Workspace not found');
    }

    return prisma.profile.create({
      data: {
        workspaceId: dto.workspaceId,
        displayName: dto.name,
        webhookUrl: dto.webhookUrl,
        webhookSecret: dto.webhookSecret,
        settings: profileSettingsWithEngine({}, dto.engine),
      },
    });
  }

  async createForDntOperations(dto: CreateDntOperationsProfileDto, user: any) {
    const workspace = await prisma.workspace.findFirst({
      where: { organizationId: user.organizationId },
      orderBy: { createdAt: 'asc' },
    });
    if (!workspace) throw new BadRequestException('Workspace not found');
    return prisma.profile.create({
      data: {
        workspaceId: workspace.id,
        displayName: dto.name,
        settings: profileSettingsWithDntOperationsAccess(
          profileSettingsWithEngine({}, dto.engine),
          true,
        ),
      },
    });
  }

  async update(id: string, dto: UpdateProfileDto, organizationId: string) {
    const profile = await this.findOne(id, organizationId);
    let settings: Record<string, any> | undefined;
    if (dto.engine) settings = profileSettingsWithEngine(profile.settings, dto.engine);
    if (dto.dntOperationsAccess !== undefined) {
      settings = profileSettingsWithDntOperationsAccess(settings || profile.settings, dto.dntOperationsAccess);
    }

    return prisma.profile.update({
      where: { id },
      data: {
        displayName: dto.name,
        webhookUrl: dto.webhookUrl,
        webhookSecret: dto.webhookSecret,
        settings,
      },
    });
  }

  async delete(id: string, organizationId: string) {
    await this.findOne(id, organizationId);
    
    // Disconnect if connected
    await this.disconnect(id, organizationId).catch(() => {});
    
    await prisma.profile.delete({ where: { id } });
    return { success: true };
  }

  async connect(id: string, organizationId: string) {
    const profile = await this.findOne(id, organizationId);

    if (profile.status === 'connected') {
      return { status: 'already_connected', phone: profile.phoneNumber };
    }

    // Use EngineManager to handle connection
    // This will initialize the engine and emit QR code via WebSocket
    const result = await this.engineManager.connectProfile(id);
    
    return { 
      status: result.status,
      message: result.message,
    };
  }

  async disconnect(id: string, organizationId: string) {
    await this.findOne(id, organizationId);

    // Use EngineManager to handle disconnection
    const result = await this.engineManager.disconnectProfile(id);

    return { status: result.status };
  }

  async getStatus(id: string, organizationId: string) {
    const profile = await this.findOne(id, organizationId);
    const engineStatus = this.engineManager.getEngineStatus(id);
    
    return {
      id: profile.id,
      name: profile.displayName,
      status: profile.status,
      phone: profile.phoneNumber,
      lastConnectedAt: profile.lastConnectedAt,
      engineConnected: engineStatus.isConnected,
      engine: resolveProfileEngineType(profile.settings),
      dntOperationsAccess: profile.dntOperationsAccess,
    };
  }

  async findDntOperationsProfiles(organizationId: string) {
    const profiles = await prisma.profile.findMany({
      where: { workspace: { organizationId } },
      select: {
        id: true,
        displayName: true,
        phoneNumber: true,
        status: true,
        lastConnectedAt: true,
        settings: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    return profiles
      .filter(profile => profileAllowsDntOperations(profile.settings))
      .map(profile => ({
        id: profile.id,
        name: profile.displayName,
        phone: profile.phoneNumber,
        status: profile.status,
        lastConnectedAt: profile.lastConnectedAt,
        engineConnected: this.engineManager.getEngineStatus(profile.id).isConnected,
        engine: resolveProfileEngineType(profile.settings),
      }));
  }

  private async requireDntOperationsProfile(id: string, organizationId: string) {
    const profile = await this.findOne(id, organizationId);
    if (!profile.dntOperationsAccess) throw new NotFoundException('Profile not found');
    return profile;
  }

  async getDntOperationsStatus(id: string, organizationId: string) {
    const profile = await this.requireDntOperationsProfile(id, organizationId);
    const engineStatus = this.engineManager.getEngineStatus(id);
    return {
      id: profile.id,
      name: profile.displayName,
      phone: profile.phoneNumber,
      status: profile.status,
      lastConnectedAt: profile.lastConnectedAt,
      engineConnected: engineStatus.isConnected,
      engine: resolveProfileEngineType(profile.settings),
    };
  }

  async connectDntOperations(id: string, organizationId: string) {
    const profile = await this.requireDntOperationsProfile(id, organizationId);
    if (this.engineManager.getEngineStatus(id).isConnected) {
      return { status: 'already_connected', phone: profile.phoneNumber };
    }
    return this.engineManager.connectProfile(id);
  }

  async getDntOperationsQr(id: string, organizationId: string) {
    const profile = await this.requireDntOperationsProfile(id, organizationId);
    const engineStatus = this.engineManager.getEngineStatus(id);
    const qrCode = this.engineManager.getCachedQrCode(id);
    return {
      qrCode: qrCode || null,
      status: engineStatus.isConnected ? 'connected' : profile.status,
      engineConnected: engineStatus.isConnected,
      expiresInSeconds: qrCode ? 120 : 0,
    };
  }

  async cancelDntOperationsPairing(id: string, organizationId: string) {
    const profile = await this.requireDntOperationsProfile(id, organizationId);
    const engineStatus = this.engineManager.getEngineStatus(id);
    if (engineStatus.isConnected) return { status: 'connected', cancelled: false };
    if (String(profile.status).toLowerCase() !== 'connecting') {
      return { status: profile.status, cancelled: false };
    }
    const result = await this.engineManager.disconnectProfile(id);
    return { status: result.status, cancelled: true };
  }

  async deleteDntOperations(id: string, organizationId: string) {
    await this.requireDntOperationsProfile(id, organizationId);
    return this.delete(id, organizationId);
  }
}
