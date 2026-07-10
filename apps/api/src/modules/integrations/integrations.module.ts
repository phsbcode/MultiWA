// MultiWA Gateway - Integrations Module
// apps/api/src/modules/integrations/integrations.module.ts

import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeBotService } from './typebot.service';
import { ChatwootService } from './chatwoot.service';
import { FastBotsService } from './fastbots.service';
import { FastBotsController } from './fastbots.controller';
import { IntegrationsController } from './integrations.controller';
import { MessagesModule } from '../messages/messages.module';

@Global()
@Module({
  imports: [ConfigModule, MessagesModule],
  controllers: [IntegrationsController, FastBotsController],
  providers: [TypeBotService, ChatwootService, FastBotsService],
  exports: [TypeBotService, ChatwootService, FastBotsService],
})
export class IntegrationsModule {}
