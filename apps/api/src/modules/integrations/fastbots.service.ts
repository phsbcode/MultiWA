// MultiWA Gateway - FastBots Integration Service
// apps/api/src/modules/integrations/fastbots.service.ts
//
// Per-profile FastBots AI integration.
// Config stored in Profile.settings JSON under the 'fastbots' key:
//   { enabled: boolean, botApiKey: string, chatIds: { [senderJid]: string } }

import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { prisma } from '@multiwa/database';
import { MessagesService } from '../messages/messages.service';

const FASTBOTS_CHAT_API = 'https://app.fastbots.ai/api/public/chat';
const FASTBOTS_TIMEOUT_MS = 30_000;

export interface FastBotsProfileConfig {
  enabled: boolean;
  botApiKey: string;
  chatIds: Record<string, string>;
}

interface FastBotsApiResponse {
  success: boolean;
  chatId?: string;
  message?: string;
}

@Injectable()
export class FastBotsService {
  private readonly logger = new Logger(FastBotsService.name);

  constructor(
    @Inject(forwardRef(() => MessagesService))
    private readonly messagesService: MessagesService,
  ) {}

  /**
   * Extract FastBots config from a profile's settings JSON.
   */
  private getConfig(settings: any): FastBotsProfileConfig {
    return {
      enabled: false,
      botApiKey: '',
      chatIds: {},
      ...(settings?.fastbots || {}),
    };
  }

  /**
   * Check if FastBots is enabled and configured for a profile.
   */
  async isEnabled(profileId: string): Promise<boolean> {
    const profile = await prisma.profile.findUnique({ where: { id: profileId } });
    if (!profile) return false;
    const config = this.getConfig(profile.settings);
    return !!(config.enabled && config.botApiKey);
  }

  /**
   * Get full FastBots config for a profile.
   */
  async getProfileConfig(
    profileId: string,
  ): Promise<FastBotsProfileConfig & { exists: boolean }> {
    const profile = await prisma.profile.findUnique({ where: { id: profileId } });
    if (!profile) return { enabled: false, botApiKey: '', chatIds: {}, exists: false };
    const config = this.getConfig(profile.settings);
    return { ...config, exists: true };
  }

  /**
   * Update FastBots config (enabled toggle, bot API key) for a profile.
   */
  async updateProfileConfig(
    profileId: string,
    updates: { enabled?: boolean; botApiKey?: string },
  ): Promise<void> {
    const profile = await prisma.profile.findUnique({ where: { id: profileId } });
    if (!profile) throw new Error('Profile not found');

    const settings = (profile.settings as any) || {};
    const current = this.getConfig(settings);

    await prisma.profile.update({
      where: { id: profileId },
      data: {
        settings: {
          ...settings,
          fastbots: {
            ...current,
            ...updates,
          },
        },
      },
    });
  }

  /**
   * Handle an incoming WhatsApp message through FastBots.
   * Called from engine-manager after message is saved and hooks fired.
   */
  async handleIncomingMessage(
    profileId: string,
    senderJid: string,
    messageText: string,
  ): Promise<void> {
    const profile = await prisma.profile.findUnique({ where: { id: profileId } });
    if (!profile) return;

    const config = this.getConfig(profile.settings);
    if (!config.enabled || !config.botApiKey) return;

    // Only respond to non-empty text messages
    if (!messageText || messageText.trim().length === 0) return;

    try {
      // Look up existing chatId for conversation continuity
      const chatIds = config.chatIds || {};
      const chatId = chatIds[senderJid];

      // Call FastBots Chat API
      const response = await fetch(FASTBOTS_CHAT_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-BOT-API-KEY': config.botApiKey,
        },
        body: JSON.stringify({
          message: messageText,
          ...(chatId ? { chatId } : {}),
        }),
        signal: AbortSignal.timeout(FASTBOTS_TIMEOUT_MS),
      });

      if (!response.ok) {
        this.logger.error(
          `FastBots API error [${response.status}] for profile ${profileId}`,
        );
        return;
      }

      const data: FastBotsApiResponse = await response.json();
      this.logger.log(
        `FastBots response for ${senderJid} on profile ${profileId}: chatId=${data.chatId}`,
      );

      // Persist the chatId for conversation continuity
      if (data.chatId && data.chatId !== chatId) {
        chatIds[senderJid] = data.chatId;
        const settings = (profile.settings as any) || {};
        await prisma.profile.update({
          where: { id: profileId },
          data: {
            settings: {
              ...settings,
              fastbots: {
                ...config,
                chatIds,
              },
            },
          },
        });
      }

      // Send the AI reply back via MessagesService
      if (data.message) {
        await this.messagesService.sendText({
          profileId,
          to: senderJid,
          text: data.message,
        });
      }
    } catch (error: any) {
      const reason = error?.name === 'TimeoutError' ? 'timeout' : 'request failed';
      this.logger.error(`FastBots processing ${reason} for profile ${profileId}`);
    }
  }

  /**
   * Test FastBots connection with a profile's configured API key.
   */
  async testConnection(profileId: string): Promise<{ success: boolean; message: string }> {
    const profile = await prisma.profile.findUnique({ where: { id: profileId } });
    if (!profile) return { success: false, message: 'Profile not found' };

    const config = this.getConfig(profile.settings);
    if (!config.botApiKey) {
      return {
        success: false,
        message: 'FastBots Bot API Key is not configured for this profile.',
      };
    }

    try {
      const response = await fetch(FASTBOTS_CHAT_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-BOT-API-KEY': config.botApiKey,
        },
        body: JSON.stringify({ message: 'test' }),
        signal: AbortSignal.timeout(FASTBOTS_TIMEOUT_MS),
      });

      if (response.ok) {
        return { success: true, message: 'FastBots connection successful! Bot is reachable.' };
      }

      return {
        success: false,
        message: `FastBots connection failed with HTTP status ${response.status}.`,
      };
    } catch {
      return { success: false, message: 'FastBots connection failed. Please try again.' };
    }
  }

  /** Clear all persisted FastBots chat IDs for one profile in a single write. */
  async clearAllChatHistory(profileId: string): Promise<boolean> {
    const profile = await prisma.profile.findUnique({ where: { id: profileId } });
    if (!profile) return false;

    const settings = (profile.settings as any) || {};
    const config = this.getConfig(settings);
    await prisma.profile.update({
      where: { id: profileId },
      data: {
        settings: {
          ...settings,
          fastbots: { ...config, chatIds: {} },
        },
      },
    });
    return true;
  }

  /**
   * Clear conversation history for a sender on a specific profile.
   * Removes the stored chatId so the next message starts a fresh conversation.
   */
  async clearChatHistory(profileId: string, senderJid: string): Promise<void> {
    const profile = await prisma.profile.findUnique({ where: { id: profileId } });
    if (!profile) return;

    const settings = (profile.settings as any) || {};
    const config = this.getConfig(settings);
    const chatIds = config.chatIds || {};
    delete chatIds[senderJid];

    await prisma.profile.update({
      where: { id: profileId },
      data: {
        settings: {
          ...settings,
          fastbots: {
            ...config,
            chatIds,
          },
        },
      },
    });
  }
}
