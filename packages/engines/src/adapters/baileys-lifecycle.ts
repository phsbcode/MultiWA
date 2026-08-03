export function shouldHandleBaileysDisconnect(isDestroying: boolean): boolean {
  return !isDestroying;
}
