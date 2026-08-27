// MultiWA Gateway - Hooks Controller
// apps/api/src/modules/hooks/hooks.controller.ts

import { Controller, Get, Post, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiSecurity } from '@nestjs/swagger';
import { HooksService } from './hooks.service';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-auth.guard';
import { IsString, IsArray, IsBoolean, IsInt, Max, Min, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

class RegisterHookDto {
  @ApiProperty({ description: 'Webhook URL to call', example: 'https://example.com/webhook' })
  @IsString()
  url: string;

  @ApiProperty({
    description: 'Events to subscribe to. Use ["*"] for all events.',
    example: ['message.received', 'profile.connected'],
    type: [String],
  })
  @IsArray()
  @IsString({ each: true })
  events: string[];

  @ApiProperty({ description: 'HMAC secret for signing payloads', required: false })
  @IsOptional()
  @IsString()
  secret?: string;

  @ApiProperty({ description: 'Mirror the HMAC proof into the JSON body for receivers without header access', required: false })
  @IsOptional()
  @IsBoolean()
  signatureInBody?: boolean;

  @ApiProperty({ description: 'Delivery timeout in milliseconds', required: false, minimum: 1000, maximum: 60000 })
  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(60000)
  timeoutMs?: number;
}

@ApiTags('Hooks')
@Controller('hooks')
@UseGuards(JwtOrApiKeyGuard)
@ApiBearerAuth()
@ApiSecurity('api-key')
export class HooksController {
  constructor(private readonly hooksService: HooksService) {}

  @Get()
  @ApiOperation({ summary: 'List all registered webhook hooks' })
  async listHooks() {
    const hooks = this.hooksService.getHooks();
    return {
      success: true,
      data: hooks.map((h) => ({
        id: h.id,
        url: h.url,
        events: h.events,
        active: h.active,
        createdAt: h.createdAt,
      })),
    };
  }

  @Post()
  @ApiOperation({
    summary: 'Register a new webhook hook',
    description: 'Register a URL to receive POST callbacks for specific events. Events: message.received, message.edited, message.sent, profile.connected, profile.disconnected, broadcast.completed, etc. Use ["*"] for all events.',
  })
  async registerHook(@Body() dto: RegisterHookDto) {
    const hook = await this.hooksService.registerHook(
      dto.url, dto.events, dto.secret, dto.signatureInBody === true, dto.timeoutMs || 10000);
    return {
      success: true,
      data: {
        id: hook.id,
        url: hook.url,
        events: hook.events,
        active: hook.active,
        signatureInBody: hook.signatureInBody === true,
        timeoutMs: hook.timeoutMs || 10000,
      },
    };
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remove a webhook hook' })
  async removeHook(@Param('id') id: string) {
    const removed = await this.hooksService.removeHook(id);
    return { success: removed };
  }
}
