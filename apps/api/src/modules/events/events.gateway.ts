// MultiWA Gateway - Events Gateway (WebSocket)
// apps/api/src/modules/events/events.gateway.ts

import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { prisma } from '@multiwa/database';
import { createHash } from 'crypto';
import { WsException } from '@nestjs/websockets';

@WebSocketGateway({
  namespace: '/ws',
  cors: {
    origin: (process.env.CORS_ORIGINS || 'http://localhost:3001,http://localhost:3000').split(',').map(o => o.trim()),
    credentials: true,
  },
  transports: ['websocket', 'polling'],
})
export class EventsGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(EventsGateway.name);

  @WebSocketServer()
  server: Server;

  // Track connected clients by profile ID
  private clients: Map<string, Set<string>> = new Map();

  // Cache the latest QR code per profile so newly-joining clients
  // don't miss it if the engine emitted the QR before the client joined.
  private latestQr: Map<string, string> = new Map();

  // Cache the latest connection status per profile for the same reason.
  private latestStatus: Map<string, { status: string; phoneNumber?: string }> = new Map();

  constructor(private readonly jwtService: JwtService) {}

  afterInit(server: Server) {
    server.use(async (client, next) => {
      try {
        client.data.principal = await this.authenticate(client);
        next();
      } catch {
        next(new Error('Unauthorized'));
      }
    });
  }

  private async authenticate(client: Socket) {
    const authorization = client.handshake.headers.authorization;
    const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
    const token = client.handshake.auth?.token || bearer;
    if (token) {
      const payload = await this.jwtService.verifyAsync<{ sub: string }>(token);
      const user = await prisma.user.findUnique({ where: { id: payload.sub } });
      if (!user?.isActive) throw new Error('Inactive user');
      return { id: user.id, organizationId: user.organizationId };
    }

    const apiKey = client.handshake.auth?.apiKey || client.handshake.headers['x-api-key'] || client.handshake.query.apiKey;
    if (typeof apiKey !== 'string' || !apiKey) throw new Error('Missing credentials');
    const keyHash = createHash('sha256').update(apiKey).digest('hex');
    const key = await prisma.apiKey.findUnique({ where: { keyHash }, include: { user: true } });
    if (!key || !key.user.isActive || (key.expiresAt && key.expiresAt < new Date())) throw new Error('Invalid API key');
    await prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
    return { id: key.user.id, organizationId: key.user.organizationId, apiKeyId: key.id };
  }

  handleConnection(client: Socket) {
    this.logger.log(`Client connected to /ws namespace: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
    // Clean up client from all profile rooms
    this.clients.forEach((clientSet, profileId) => {
      clientSet.delete(client.id);
      if (clientSet.size === 0) {
        this.clients.delete(profileId);
      }
    });
  }

  // Handle 'join' event from frontend (matches frontend: socket.emit('join', { profileId }))
  @SubscribeMessage('join')
  async handleJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { profileId: string },
  ) {
    const profileId = data?.profileId?.trim();
    const principal = client.data.principal;
    if (!profileId || !principal?.organizationId) throw new WsException('Profile access denied');
    const profile = await prisma.profile.findFirst({
      where: { id: profileId, workspace: { organizationId: principal.organizationId } },
      select: { id: true },
    });
    if (!profile) throw new WsException('Profile access denied');
    this.logger.log(`Client ${client.id} joining profile room: ${profileId}`);
    
    client.join(`profile:${profileId}`);
    
    if (!this.clients.has(profileId)) {
      this.clients.set(profileId, new Set());
    }
    this.clients.get(profileId)!.add(client.id);

    // Catch-up: if there's a recent QR code the client may have missed,
    // re-emit it directly to this client (not to the whole room).
    const pendingQr = this.latestQr.get(profileId);
    if (pendingQr) {
      this.logger.log(`Re-emitting pending QR for profile ${profileId} to newly-joined client ${client.id}`);
      client.emit('qr:update', { profileId, qrCode: pendingQr });
    }

    // Catch-up: re-emit latest connection status if any
    const pendingStatus = this.latestStatus.get(profileId);
    if (pendingStatus) {
      client.emit('connection:status', { profileId, ...pendingStatus });
    }
    
    return { success: true, profileId };
  }

  @SubscribeMessage('subscribe:profile')
  async handleSubscribeProfile(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { profileId: string },
  ) {
    return this.handleJoin(client, data);
  }

  @SubscribeMessage('unsubscribe:profile')
  handleUnsubscribeProfile(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { profileId: string },
  ) {
    const { profileId } = data;
    this.logger.log(`Client ${client.id} leaving profile room: ${profileId}`);
    
    client.leave(`profile:${profileId}`);
    
    const clientSet = this.clients.get(profileId);
    if (clientSet) {
      clientSet.delete(client.id);
      if (clientSet.size === 0) {
        this.clients.delete(profileId);
      }
    }
    
    return { success: true, profileId };
  }

  // Emit QR code update (matches frontend: socket.on('qr:update', data))
  emitQrUpdate(profileId: string, qrCode: string) {
    this.logger.log(`Emitting qr:update for profile: ${profileId}`);
    // Cache so late-joining clients can catch up
    this.latestQr.set(profileId, qrCode);
    this.server.to(`profile:${profileId}`).emit('qr:update', { profileId, qrCode });
  }

  // Emit connection status (matches frontend: socket.on('connection:status', data))
  emitConnectionStatus(profileId: string, status: string, phoneNumber?: string) {
    this.logger.log(`Emitting connection:status '${status}' for profile: ${profileId}`);
    // Cache so late-joining clients can catch up
    this.latestStatus.set(profileId, { status, phoneNumber });
    // QR is no longer valid once connected or disconnected — clear it
    // so the catch-up mechanism doesn't send a stale QR to late joiners.
    if (status === 'connected' || status === 'disconnected') {
      this.latestQr.delete(profileId);
    }
    this.server.to(`profile:${profileId}`).emit('connection:status', { 
      profileId, 
      status,
      phoneNumber,
    });
  }

  // Legacy emit methods for compatibility
  emitQr(profileId: string, qrData: { qr: string; status: string }) {
    this.emitQrUpdate(profileId, qrData.qr);
  }

  // Get cached QR code for a profile
  getCachedQr(profileId: string): string | undefined {
    return this.latestQr.get(profileId);
  }

  emitStatus(profileId: string, status: string, data?: any) {
    this.emitConnectionStatus(profileId, status, data?.phoneNumber);
  }

  // Emit message event
  emitMessage(profileId: string, message: any) {
    this.server.to(`profile:${profileId}`).emit('message', message);
  }

  emitMessageUpdate(profileId: string, message: any) {
    this.server.to(`profile:${profileId}`).emit('message:update', { profileId, message });
  }

  emitPresence(profileId: string, presence: any) {
    this.server.to(`profile:${profileId}`).emit('presence:update', presence);
  }

  // Emit connection success with phone info
  emitConnected(profileId: string, data: { phone: string; pushName?: string }) {
    this.logger.log(`Profile ${profileId} connected: ${data.phone}`);
    this.emitConnectionStatus(profileId, 'connected', data.phone);
  }

  // Emit disconnection
  emitDisconnected(profileId: string, reason?: string) {
    this.logger.log(`Profile ${profileId} disconnected: ${reason}`);
    this.emitConnectionStatus(profileId, 'disconnected');
  }

  // Emit message acknowledgment (sent/delivered/read)
  emitMessageAck(profileId: string, messageId: string, status: string) {
    this.server.to(`profile:${profileId}`).emit('message:ack', { profileId, messageId, status });
  }
}
