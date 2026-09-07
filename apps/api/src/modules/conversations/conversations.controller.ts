// MultiWA Gateway - Conversations Controller
// apps/api/src/modules/conversations/conversations.controller.ts

import { Controller, Get, Put, Delete, Param, Query, Body, UseGuards, Request, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiSecurity, ApiQuery } from '@nestjs/swagger';
import { ConversationsService } from './conversations.service';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-auth.guard';
import { prisma } from '@multiwa/database';
import { MessageContextQueryDto, SearchMessagesQueryDto } from './dto/message-history-query.dto';
import {
  ConversationDetailQueryDto,
  ConversationDetailQueryPipe,
  conversationDetailLimit,
} from './dto/conversation-detail-query.dto';
import { TenantGuard } from '../../common/tenant/tenant.guard';
import { RequireTenant } from '../../common/tenant/require-tenant.decorator';

@ApiTags('Conversations')
@Controller('conversations')
@UseGuards(JwtOrApiKeyGuard, TenantGuard)
@ApiBearerAuth()
@ApiSecurity('api-key')
export class ConversationsController {
  constructor(private readonly service: ConversationsService) {}

  private async assertProfileAccess(profileId: string, organizationId: string) {
    const profile = await prisma.profile.findFirst({
      where: { id: profileId, workspace: { organizationId } },
      select: { id: true },
    });
    if (!profile) throw new NotFoundException('Profile not found');
  }

  @Get()
  @RequireTenant({ resource: 'profile', from: 'query', key: 'profileId' })
  @ApiOperation({ summary: 'List conversations' })
  @ApiQuery({ name: 'profileId', required: true })
  @ApiQuery({ name: 'type', required: false, enum: ['user', 'group', 'broadcast'] })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  async findAll(
    @Query('profileId') profileId: string,
    @Query('type') type?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    return this.service.findAll(profileId, { type, limit, offset });
  }

  @Get(':id')
  @RequireTenant({ resource: 'conversation', from: 'param', key: 'id' })
  @ApiOperation({ summary: 'Get conversation with messages' })
  @ApiQuery({ name: 'messageLimit', required: false })
  async findOne(
    @Param('id') id: string,
    @Query(ConversationDetailQueryPipe) query: ConversationDetailQueryDto,
  ) {
    return this.service.findOne(id, conversationDetailLimit(query));
  }

  @Put(':id/read')
  @RequireTenant({ resource: 'conversation', from: 'param', key: 'id' })
  @ApiOperation({ summary: 'Mark conversation as read' })
  async markAsRead(@Param('id') id: string) {
    return this.service.markAsRead(id);
  }

  @Put(':id/archive')
  @RequireTenant({ resource: 'conversation', from: 'param', key: 'id' })
  @ApiOperation({ summary: 'Archive conversation' })
  async archive(@Param('id') id: string) {
    return this.service.archive(id);
  }

  @Put(':id/unarchive')
  @RequireTenant({ resource: 'conversation', from: 'param', key: 'id' })
  @ApiOperation({ summary: 'Unarchive conversation' })
  async unarchive(@Param('id') id: string) {
    return this.service.unarchive(id);
  }

  @Put(':id/mute')
  @RequireTenant({ resource: 'conversation', from: 'param', key: 'id' })
  @ApiOperation({ summary: 'Toggle mute conversation' })
  async toggleMute(@Param('id') id: string) {
    return this.service.toggleMute(id);
  }

  @Put(':id/pin')
  @RequireTenant({ resource: 'conversation', from: 'param', key: 'id' })
  @ApiOperation({ summary: 'Toggle pin conversation' })
  async togglePin(@Param('id') id: string) {
    return this.service.togglePin(id);
  }

  @Delete(':id/messages')
  @RequireTenant({ resource: 'conversation', from: 'param', key: 'id' })
  @ApiOperation({ summary: 'Clear all messages in conversation' })
  async clearMessages(@Param('id') id: string) {
    return this.service.clearMessages(id);
  }

  @Delete(':id')
  @RequireTenant({ resource: 'conversation', from: 'param', key: 'id' })
  @ApiOperation({ summary: 'Delete conversation and messages' })
  async delete(@Param('id') id: string) {
    return this.service.delete(id);
  }

  @Get(':id/messages/search')
  @ApiOperation({ summary: 'Search the full message history of a conversation' })
  @ApiQuery({ name: 'profileId', required: true })
  @ApiQuery({ name: 'q', required: true })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  async searchMessages(
    @Param('id') id: string,
    @Request() req: any,
    @Query() query: SearchMessagesQueryDto,
  ) {
    await this.assertProfileAccess(query.profileId, req.user.organizationId);
    return this.service.searchMessages(id, query.profileId, {
      query: query.q,
      limit: query.limit,
      cursor: query.cursor,
    });
  }

  @Get(':id/messages/:messageId/context')
  @ApiOperation({ summary: 'Get a message with chronological surrounding context' })
  @ApiQuery({ name: 'profileId', required: true })
  @ApiQuery({ name: 'before', required: false })
  @ApiQuery({ name: 'after', required: false })
  async getMessageContext(
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @Request() req: any,
    @Query() query: MessageContextQueryDto,
  ) {
    await this.assertProfileAccess(query.profileId, req.user.organizationId);
    return this.service.getMessageContext(id, messageId, query.profileId, {
      before: query.before,
      after: query.after,
    });
  }

  @Get(':id/messages')
  @RequireTenant({ resource: 'conversation', from: 'param', key: 'id' })
  @ApiOperation({ summary: 'Get messages in conversation' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'before', required: false, description: 'Get messages before this ID' })
  async getMessages(
    @Param('id') id: string,
    @Query('limit') limit?: number,
    @Query('before') before?: string,
  ) {
    return this.service.getMessages(id, { limit, before });
  }
}
