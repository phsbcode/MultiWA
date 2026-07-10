// MultiWA Gateway - FastBots Integration Controller
// apps/api/src/modules/integrations/fastbots.controller.ts
//
// Per-profile FastBots AI configuration endpoints.
// Used by the admin integrations page to toggle and configure FastBots per profile.

import {
  Controller, Get, Put, Post, Param, Body,
  UseGuards, Logger, Request, NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { FastBotsService } from './fastbots.service';
import { prisma } from '@multiwa/database';

class UpdateFastBotsDto {
  enabled?: boolean;
  botApiKey?: string;
}

@ApiTags('Integrations / FastBots')
@Controller('integrations/fastbots')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class FastBotsController {
  private readonly logger = new Logger(FastBotsController.name);

  constructor(private readonly fastBotsService: FastBotsService) {}

  private async assertProfileAccess(profileId: string, organizationId: string) {
    const profile = await prisma.profile.findFirst({
      where: {
        id: profileId,
        workspace: { organizationId },
      },
      select: { id: true },
    });
    if (!profile) throw new NotFoundException('Profile not found');
  }

  /**
   * GET /integrations/fastbots
   * Returns all profiles with their FastBots configuration.
   */
  @Get()
  @ApiOperation({ summary: 'Get FastBots config for all profiles' })
  @ApiResponse({ status: 200, description: 'List of profiles with FastBots config' })
  async getAllConfigs(@Request() req: any) {
    const profiles = await prisma.profile.findMany({
      where: { workspace: { organizationId: req.user.organizationId } },
      select: { id: true, displayName: true, phoneNumber: true },
      orderBy: { createdAt: 'desc' },
    });

    const results = await Promise.all(
      profiles.map(async (p) => {
        const config = await this.fastBotsService.getProfileConfig(p.id);
        return {
          profileId: p.id,
          displayName: p.displayName,
          phoneNumber: p.phoneNumber,
          enabled: config.enabled,
          hasBotKey: !!config.botApiKey,
          // Don't expose the actual API key
        };
      }),
    );

    return { success: true, data: results };
  }

  /**
   * GET /integrations/fastbots/:profileId
   * Returns FastBots config for a specific profile.
   */
  @Get(':profileId')
  @ApiOperation({ summary: 'Get FastBots config for a specific profile' })
  @ApiResponse({ status: 200, description: 'FastBots config for the profile' })
  async getProfileConfig(@Param('profileId') profileId: string, @Request() req: any) {
    await this.assertProfileAccess(profileId, req.user.organizationId);
    const config = await this.fastBotsService.getProfileConfig(profileId);
    if (!config.exists) {
      return { success: false, message: 'Profile not found' };
    }
    return {
      success: true,
      data: {
        enabled: config.enabled,
        hasBotKey: !!config.botApiKey,
        totalChatSessions: Object.keys(config.chatIds || {}).length,
      },
    };
  }

  /**
   * PUT /integrations/fastbots/:profileId
   * Update FastBots config for a profile (toggle enable/disable, set bot API key).
   */
  @Put(':profileId')
  @ApiOperation({ summary: 'Update FastBots config for a profile' })
  @ApiResponse({ status: 200, description: 'Config updated' })
  async updateProfileConfig(
    @Param('profileId') profileId: string,
    @Body() body: UpdateFastBotsDto,
    @Request() req: any,
  ) {
    await this.assertProfileAccess(profileId, req.user.organizationId);
    try {
      const updates: UpdateFastBotsDto = {};
      if (typeof body.enabled === 'boolean') updates.enabled = body.enabled;
      if (typeof body.botApiKey === 'string' && body.botApiKey.trim()) {
        updates.botApiKey = body.botApiKey.trim();
      }
      await this.fastBotsService.updateProfileConfig(profileId, updates);
      return { success: true, message: 'FastBots configuration updated' };
    } catch {
      this.logger.error(`Failed to update FastBots configuration for profile ${profileId}`);
      return { success: false, message: 'Failed to update FastBots configuration.' };
    }
  }

  /**
   * POST /integrations/fastbots/:profileId/test
   * Test FastBots connection for a profile.
   */
  @Post(':profileId/test')
  @ApiOperation({ summary: 'Test FastBots connection for a profile' })
  @ApiResponse({ status: 200, description: 'Connection test result' })
  async testConnection(@Param('profileId') profileId: string, @Request() req: any) {
    await this.assertProfileAccess(profileId, req.user.organizationId);
    return this.fastBotsService.testConnection(profileId);
  }

  /**
   * POST /integrations/fastbots/:profileId/reset-chats
   * Clear all stored chat IDs for a profile (starts fresh conversations).
   */
  @Post(':profileId/reset-chats')
  @ApiOperation({ summary: 'Reset FastBots conversation history for a profile' })
  @ApiResponse({ status: 200, description: 'Chat history reset' })
  async resetChatHistory(@Param('profileId') profileId: string, @Request() req: any) {
    await this.assertProfileAccess(profileId, req.user.organizationId);
    try {
      const reset = await this.fastBotsService.clearAllChatHistory(profileId);
      if (!reset) {
        throw new NotFoundException('Profile not found');
      }
      return { success: true, message: 'FastBots conversation history reset for all contacts' };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error(`Failed to reset FastBots chat history for profile ${profileId}`);
      return { success: false, message: 'Failed to reset FastBots conversation history.' };
    }
  }
}
