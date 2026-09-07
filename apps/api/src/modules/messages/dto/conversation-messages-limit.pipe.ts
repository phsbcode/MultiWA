import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

@Injectable()
export class ConversationMessagesLimitPipe implements PipeTransform<unknown, number | undefined> {
  transform(value: unknown): number | undefined {
    if (value === undefined || value === null || value === '' ||
        (typeof value === 'number' && Number.isNaN(value))) return undefined;
    if ((typeof value !== 'string' && typeof value !== 'number') ||
        !/^-?\d+$/.test(String(value))) {
      throw new BadRequestException('limit must be an integer.');
    }
    const limit = Number(value);
    if (!Number.isSafeInteger(limit)) {
      throw new BadRequestException('limit must be an integer.');
    }
    return limit;
  }
}
