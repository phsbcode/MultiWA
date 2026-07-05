export interface SenderIdentityInput {
  from?: string;
  author?: string;
  contactPhone?: string;
  contactJid?: string;
}

export interface SenderIdentity {
  senderJid: string;
  senderPhone?: string;
  originalSenderJid: string;
  isGroup: boolean;
}

function isGroupJid(value?: string): boolean {
  return /@g\.us$/i.test(value || '');
}

function isLidJid(value?: string): boolean {
  return /@lid$/i.test(value || '');
}

function digitsOnly(value?: string): string | undefined {
  const digits = (value || '').replace(/\D/g, '');
  return digits || undefined;
}

function phoneJidFromPhone(phone?: string): string | undefined {
  const digits = digitsOnly(phone);
  return digits ? `${digits}@s.whatsapp.net` : undefined;
}

function phoneFromPhoneJid(jid?: string): string | undefined {
  if (!jid || isGroupJid(jid) || isLidJid(jid)) return undefined;
  if (!/@(?:c\.us|s\.whatsapp\.net)$/i.test(jid)) return undefined;
  return digitsOnly(jid);
}

export function resolveSenderIdentity(message: SenderIdentityInput): SenderIdentity {
  const isGroup = isGroupJid(message.from);
  const originalSenderJid = (isGroup ? message.author : message.from) || message.author || message.from || '';

  const resolvedContactPhone = isLidJid(message.contactJid) ? undefined : digitsOnly(message.contactPhone);
  const resolvedPhone =
    resolvedContactPhone ||
    phoneFromPhoneJid(message.contactJid) ||
    phoneFromPhoneJid(originalSenderJid);

  const resolvedPhoneJid = phoneJidFromPhone(resolvedPhone);
  const senderJid = resolvedPhoneJid || (isGroup ? originalSenderJid : originalSenderJid.replace(/@c\.us$/i, '@s.whatsapp.net'));

  return {
    senderJid,
    senderPhone: resolvedPhone,
    originalSenderJid,
    isGroup,
  };
}
