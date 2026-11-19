import type { Response } from 'express';
import logger from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LoanEventPayload {
  eventId: string;
  eventType: string;
  loanId?: number | undefined;
  address?: string | undefined;
  /** Exact stroop amount, as decoded from the chain — never a float. */
  amount?: string | undefined;
  /**
   * Display-precision string derived from `amount` via the shared money
   * policy (`backend/src/money/decimal.ts`'s `fromStroops`). Consumers
   * should render this for display and never re-derive one themselves from
   * `amount` with ad-hoc float math.
   */
  amountDisplay?: string | undefined;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
}

type SseClient = Response;

interface ClientInfo {
  res: SseClient;
  userKey: string;
  /** Topics this connection subscribed to. Empty set means "all topics". */
  topics: Set<string>;
  /** Events buffered while the socket is backpressured. */
  pending: PendingEvent[];
  /** True while we are waiting for the socket to drain. */
  draining: boolean;
}

interface PendingEvent {
  event: LoanEventPayload;
  enqueuedAt: number;
}

const MAX_CONNECTIONS_PER_USER = 3;

/** Events older than this are dropped when a client is backpressured. */
const BACKPRESSURE_MAX_AGE_MS = 30_000;

/** Max buffered events per slow client before we start dropping oldest. */
const MAX_PENDING_EVENTS = 100;

/** Borrower-specific SSE clients: borrowerPublicKey → Set<ClientInfo> */
const borrowerClients = new Map<string, Set<ClientInfo>>();

/** Admin SSE clients listening to all events */
const adminClients = new Set<ClientInfo>();

/** All SSE clients grouped by authenticated user key for connection limiting */
const userClients = new Map<string, Set<SseClient>>();

/** Prometheus gauge: number of currently connected SSE clients. */
let sseConnectedClientsTotal = 0;

// ─── Event Stream Service ─────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 30_000;

class EventStreamService {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  closeAll: (reason: string) => void = this.closeAllConnections;

  startHeartbeat(): void {
    if (this.heartbeatTimer) {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      const allClients = this.collectAllClients();
      for (const clientInfo of allClients) {
        try {
          clientInfo.res.write(': ping\n\n');
        } catch {
          this.removeClient(clientInfo);
        }
      }

      const counts = this.getConnectionCount();
      logger.withContext().info('SSE heartbeat', {
        borrower: counts.borrower,
        admin: counts.admin,
        total: counts.total,
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private stopHeartbeatIfEmpty(): void {
    if (this.getConnectionCount().total === 0) {
      this.stopHeartbeat();
    }
  }

  private collectAllClients(): ClientInfo[] {
    const all: ClientInfo[] = [];
    for (const clients of borrowerClients.values()) {
      for (const client of clients) {
        all.push(client);
      }
    }
    for (const client of adminClients) {
      all.push(client);
    }
    return all;
  }

  private removeClient(clientInfo: ClientInfo): void {
    for (const [borrower, clients] of borrowerClients) {
      clients.delete(clientInfo);
      if (clients.size === 0) {
        borrowerClients.delete(borrower);
      }
    }
    adminClients.delete(clientInfo);
    const userSet = userClients.get(clientInfo.userKey);
    if (userSet) {
      userSet.delete(clientInfo.res);
      if (userSet.size === 0) {
        userClients.delete(clientInfo.userKey);
      }
    }
    clientInfo.pending.length = 0;
    this.updateGauge();
  }

  /**
   * Returns the current value of the `sse_connected_clients_total` gauge.
   * Exposed so the metrics registry can scrape it.
   */
  getConnectedClientsGauge(): number {
    return sseConnectedClientsTotal;
  }

  private updateGauge(): void {
    sseConnectedClientsTotal = this.getConnectionCount().total;
  }

  private clientMatchesTopic(clientInfo: ClientInfo, event: LoanEventPayload): boolean {
    if (clientInfo.topics.size === 0) {
      return true;
    }
    return clientInfo.topics.has(event.eventType);
  }

  sendEvent(res: SseClient, event: LoanEventPayload): void {
    const masked = this.maskEventPayload(event);
    const payload =
      `id: ${event.eventId}\n` + `event: loan-event\n` + `data: ${JSON.stringify(masked)}\n\n`;

    res.write(payload);
  }

  /**
   * Writes an event to a client, honoring backpressure. If the socket buffer
   * is full, the event is queued and flushed once the socket drains. Events
   * older than BACKPRESSURE_MAX_AGE_MS are dropped and a synthetic
   * `missed_events` event is emitted so the client knows to refetch.
   */
  private dispatch(clientInfo: ClientInfo, event: LoanEventPayload): void {
    if (clientInfo.draining) {
      this.enqueue(clientInfo, event);
      return;
    }

    const ok = this.writeEvent(clientInfo, event);
    if (!ok) {
      clientInfo.draining = true;
      this.enqueue(clientInfo, event);
      clientInfo.res.once('drain', () => {
        clientInfo.draining = false;
        this.flush(clientInfo);
      });
    }
  }

  private writeEvent(clientInfo: ClientInfo, event: LoanEventPayload): boolean {
    try {
      this.sendEvent(clientInfo.res, event);
      return clientInfo.res.writableLength === 0;
    } catch (err) {
      logger.withContext().error('SSE write error', {
        userKey: clientInfo.userKey,
        err,
      });
      this.removeClient(clientInfo);
      return true;
    }
  }

  private enqueue(clientInfo: ClientInfo, event: LoanEventPayload): void {
    clientInfo.pending.push({ event, enqueuedAt: Date.now() });
    if (clientInfo.pending.length > MAX_PENDING_EVENTS) {
      clientInfo.pending.shift();
    }
  }

  private flush(clientInfo: ClientInfo): void {
    const now = Date.now();
    let dropped = 0;

    while (clientInfo.pending.length > 0) {
      const next = clientInfo.pending[0]!;
      if (now - next.enqueuedAt > BACKPRESSURE_MAX_AGE_MS) {
        clientInfo.pending.shift();
        dropped += 1;
        continue;
      }

      const ok = this.writeEvent(clientInfo, next.event);
      clientInfo.pending.shift();
      if (!ok) {
        clientInfo.draining = true;
        clientInfo.res.once('drain', () => {
          clientInfo.draining = false;
          this.flush(clientInfo);
        });
        break;
      }
    }

    if (dropped > 0) {
      this.sendMissedEvents(clientInfo, dropped);
    }
  }

  private sendMissedEvents(clientInfo: ClientInfo, droppedCount: number): void {
    const payload =
      `event: missed_events\n` +
      `data: ${JSON.stringify({ droppedCount, reason: 'backpressure' })}\n\n`;
    try {
      clientInfo.res.write(payload);
    } catch {
      this.removeClient(clientInfo);
    }
  }

  private maskEventPayload(event: LoanEventPayload): Record<string, unknown> {
    const masked: Record<string, unknown> = { ...event };
    const piiFields = [
      'recipient_email',
      'recipient_phone',
      'recipient_name',
      'email',
      'phone',
      'legalName',
    ];
    for (const field of piiFields) {
      if (field in masked) {
        (masked as Record<string, unknown>)[field] = '[REDACTED]';
      }
    }
    return masked;
  }

  private registerUserClient(userKey: string, res: SseClient): void {
    if (!userClients.has(userKey)) {
      userClients.set(userKey, new Set());
    }
    userClients.get(userKey)!.add(res);
  }

  private unregisterUserClient(userKey: string, res: SseClient): void {
    const clients = userClients.get(userKey);
    if (!clients) {
      return;
    }

    clients.delete(res);
    if (clients.size === 0) {
      userClients.delete(userKey);
    }
  }

  canOpenConnection(userKey: string): boolean {
    return (userClients.get(userKey)?.size ?? 0) < MAX_CONNECTIONS_PER_USER;
  }

  getUserConnectionCount(userKey: string): number {
    return userClients.get(userKey)?.size ?? 0;
  }

  getMaxConnectionsPerUser(): number {
    return MAX_CONNECTIONS_PER_USER;
  }

  /**
   * Registers an SSE client for a specific borrower's events.
   * `topics` filters which event types are dispatched to this connection;
   * an empty set means "all topics".
   * Returns an unsubscribe function for cleanup on disconnect.
   */
  subscribeAddress(
    userKey: string,
    address: string,
    res: SseClient,
    topics: string[] = [],
  ): () => void {
    if (!borrowerClients.has(address)) {
      borrowerClients.set(address, new Set());
    }
    const clientInfo: ClientInfo = {
      res,
      userKey,
      topics: new Set(topics),
      pending: [],
      draining: false,
    };
    borrowerClients.get(address)!.add(clientInfo);
    this.registerUserClient(userKey, res);
    this.startHeartbeat();
    this.updateGauge();

    logger.withContext().info('SSE client subscribed to borrower events', {
      address,
      userKey,
      topics,
      activeConnections: this.getUserConnectionCount(userKey),
    });

    return () => {
      borrowerClients.get(address)?.delete(clientInfo);
      if (borrowerClients.get(address)?.size === 0) {
        borrowerClients.delete(address);
      }
      this.unregisterUserClient(userKey, res);
      clientInfo.pending.length = 0;
      this.stopHeartbeatIfEmpty();
      this.updateGauge();
      logger.withContext().info('SSE client unsubscribed from address events', {
        address,
        userKey,
        activeConnections: this.getUserConnectionCount(userKey),
      });
    };
  }

  /**
   * Registers an SSE client for all events (admin stream).
   * `topics` filters which event types are dispatched to this connection;
   * an empty set means "all topics".
   * Returns an unsubscribe function for cleanup on disconnect.
   */
  subscribeAll(userKey: string, res: SseClient, topics: string[] = []): () => void {
    const clientInfo: ClientInfo = {
      res,
      userKey,
      topics: new Set(topics),
      pending: [],
      draining: false,
    };
    adminClients.add(clientInfo);
    this.registerUserClient(userKey, res);
    this.startHeartbeat();
    this.updateGauge();

    logger.withContext().info('SSE admin client subscribed to all events', {
      userKey,
      topics,
      activeConnections: this.getUserConnectionCount(userKey),
    });

    return () => {
      adminClients.delete(clientInfo);
      this.unregisterUserClient(userKey, res);
      clientInfo.pending.length = 0;
      this.stopHeartbeatIfEmpty();
      this.updateGauge();
      logger.withContext().info('SSE admin client unsubscribed from all events', {
        userKey,
        activeConnections: this.getUserConnectionCount(userKey),
      });
    };
  }

  /**
   * Broadcasts a loan event to relevant SSE clients:
   * - Borrower-specific clients for that borrower (with user identity verification)
   * - All admin clients
   * Each connection only receives events matching its subscribed topics.
   */
  broadcast(event: LoanEventPayload): void {
    // Push to address-specific clients with user identity verification
    if (event.address) {
      const clients = borrowerClients.get(event.address);
      if (clients?.size) {
        for (const clientInfo of clients) {
          if (!this.clientMatchesTopic(clientInfo, event)) {
            continue;
          }
          this.dispatch(clientInfo, event);
        }
      }
    }

    // Push to admin clients
    for (const clientInfo of adminClients) {
      if (!this.clientMatchesTopic(clientInfo, event)) {
        continue;
      }
      this.dispatch(clientInfo, event);
    }
  }

  getConnectionCount(): { borrower: number; admin: number; total: number } {
    let borrower = 0;
    for (const clients of borrowerClients.values()) {
      borrower += clients.size;
    }
    const admin = adminClients.size;
    return { borrower, admin, total: borrower + admin };
  }

  closeAllConnections(reason: string): void {
    const allClients = this.collectAllClients();
    for (const clientInfo of allClients) {
      try {
        clientInfo.res.end();
      } catch {
        // ignore
      }
      this.removeClient(clientInfo);
    }
    this.stopHeartbeat();
    this.updateGauge();
    logger.withContext().info('SSE all connections closed', { reason });
  }
}

export const eventStreamService = new EventStreamService();
export default eventStreamService;
