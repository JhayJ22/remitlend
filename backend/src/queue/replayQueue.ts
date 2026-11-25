export interface ReplayOperation {
  id: string;
  txXdr: string;
  attempts: number;
  maxAttempts: number;
}

export function calculateBackoffWithJitter(attempt: number, baseMs = 1000, capMs = 30000): number {
  const exp = Math.min(capMs, baseMs * Math.pow(2, attempt));
  const jitter = Math.random() * 0.5 + 0.75; // 75% to 125% jitter
  return Math.floor(exp * jitter);
}
