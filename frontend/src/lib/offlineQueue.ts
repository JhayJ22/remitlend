export interface QueuedAction {
  id: string;
  type: string;
  payload: any;
  timestamp: number;
}

export class OfflineActionQueue {
  private queue: QueuedAction[] = [];

  enqueue(type: string, payload: any): QueuedAction {
    const action: QueuedAction = {
      id: Math.random().toString(36).substring(2, 9),
      type,
      payload,
      timestamp: Date.now()
    };
    this.queue.push(action);
    return action;
  }

  drain(): QueuedAction[] {
    const actions = [...this.queue];
    this.queue = [];
    return actions;
  }

  size(): number {
    return this.queue.length;
  }
}
