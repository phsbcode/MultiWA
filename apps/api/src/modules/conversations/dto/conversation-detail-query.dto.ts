import { BadRequestException, Injectable, PipeTransform } from "@nestjs/common";

export class ConversationDetailQueryDto {
  messageLimit?: string;
}

@Injectable()
export class ConversationDetailQueryPipe implements PipeTransform<
  unknown,
  ConversationDetailQueryDto
> {
  transform(value: unknown): ConversationDetailQueryDto {
    const raw =
      value && typeof value === "object"
        ? (value as Record<string, unknown>).messageLimit
        : undefined;
    if (raw === undefined) return {};
    if (typeof raw !== "string" || !/^(?:[1-9]|[1-9]\d|100)$/.test(raw)) {
      throw new BadRequestException(
        "messageLimit must be a decimal integer from 1 through 100.",
      );
    }
    return { messageLimit: raw };
  }
}

export function conversationDetailLimit(
  query: ConversationDetailQueryDto,
): number {
  return query.messageLimit === undefined ? 50 : Number(query.messageLimit);
}
