// MultiWA Gateway API - Profiles Controller
// apps/api/src/modules/profiles/profiles.controller.ts

import { Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiSecurity } from '@nestjs/swagger';
import { ProfilesService } from './profiles.service';
import { CreateDntOperationsProfileDto, CreateProfileDto, UpdateProfileDto } from './dto';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('Profiles')
@Controller('profiles')
@UseGuards(JwtOrApiKeyGuard)
@ApiBearerAuth()
@ApiSecurity('api-key')
export class ProfilesController {
  constructor(private readonly profilesService: ProfilesService) {}

  @Get()
  @ApiOperation({ summary: 'List all profiles in workspace' })
  @ApiResponse({ status: 200, description: 'List of profiles' })
  async findAll(@Request() req: any, @Query('workspaceId') workspaceId?: string) {
    return this.profilesService.findAll(req.user.organizationId, workspaceId);
  }

  @Get('dnt-operations')
  @ApiOperation({ summary: 'List profiles explicitly allowed for DNT Operations' })
  async findDntOperations(@Request() req: any) {
    return this.profilesService.findDntOperationsProfiles(req.user.organizationId);
  }

  @Post('dnt-operations')
  @ApiOperation({ summary: 'Create a profile explicitly allowed for DNT Operations' })
  async createDntOperations(@Body() dto: CreateDntOperationsProfileDto, @Request() req: any) {
    return this.profilesService.createForDntOperations(dto, req.user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get profile by ID' })
  @ApiResponse({ status: 200, description: 'Profile details' })
  async findOne(@Param('id') id: string, @Request() req: any) {
    return this.profilesService.findOne(id, req.user.organizationId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new WhatsApp profile' })
  @ApiResponse({ status: 201, description: 'Profile created' })
  async create(@Body() dto: CreateProfileDto, @Request() req: any) {
    return this.profilesService.create(dto, req.user);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update profile' })
  @ApiResponse({ status: 200, description: 'Profile updated' })
  async update(@Param('id') id: string, @Body() dto: UpdateProfileDto, @Request() req: any) {
    return this.profilesService.update(id, dto, req.user.organizationId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete profile' })
  @ApiResponse({ status: 200, description: 'Profile deleted' })
  async delete(@Param('id') id: string, @Request() req: any) {
    return this.profilesService.delete(id, req.user.organizationId);
  }

  // WhatsApp Connection
  @Post(':id/connect')
  @ApiOperation({ summary: 'Connect WhatsApp profile (QR code sent via WebSocket)' })
  @ApiResponse({ status: 200, description: 'Connection initiated - listen on WebSocket /ws namespace for qr:update event' })
  async connect(@Param('id') id: string, @Request() req: any) {
    return this.profilesService.connect(id, req.user.organizationId);
  }

  @Post(':id/disconnect')
  @ApiOperation({ summary: 'Disconnect WhatsApp profile' })
  @ApiResponse({ status: 200, description: 'Disconnected' })
  async disconnect(@Param('id') id: string, @Request() req: any) {
    return this.profilesService.disconnect(id, req.user.organizationId);
  }

  // Note: QR code is now delivered via WebSocket (/ws namespace, 'qr:update' event)
  // SSE endpoint removed in favor of WebSocket for real-time updates

  @Get(':id/status')
  @ApiOperation({ summary: 'Get connection status' })
  @ApiResponse({ status: 200, description: 'Connection status' })
  async status(@Param('id') id: string, @Request() req: any) {
    return this.profilesService.getStatus(id, req.user.organizationId);
  }

  @Get(':id/dnt-operations/status')
  @ApiOperation({ summary: 'Get DNT Operations connection status for an allowed profile' })
  async dntOperationsStatus(@Param('id') id: string, @Request() req: any) {
    return this.profilesService.getDntOperationsStatus(id, req.user.organizationId);
  }

  @Post(':id/dnt-operations/connect')
  @ApiOperation({ summary: 'Start or resume connection for a DNT Operations profile' })
  async dntOperationsConnect(@Param('id') id: string, @Request() req: any) {
    return this.profilesService.connectDntOperations(id, req.user.organizationId);
  }

  @Get(':id/dnt-operations/qr')
  @ApiOperation({ summary: 'Get the short-lived QR code for a DNT Operations profile' })
  async dntOperationsQr(@Param('id') id: string, @Request() req: any) {
    return this.profilesService.getDntOperationsQr(id, req.user.organizationId);
  }

  @Post(':id/dnt-operations/cancel-pairing')
  @ApiOperation({ summary: 'Cancel an in-progress DNT Operations pairing attempt' })
  async dntOperationsCancelPairing(@Param('id') id: string, @Request() req: any) {
    return this.profilesService.cancelDntOperationsPairing(id, req.user.organizationId);
  }

  @Delete(':id/dnt-operations')
  @ApiOperation({ summary: 'Permanently delete a profile allowed for DNT Operations' })
  async deleteDntOperations(@Param('id') id: string, @Request() req: any) {
    return this.profilesService.deleteDntOperations(id, req.user.organizationId);
  }
}
