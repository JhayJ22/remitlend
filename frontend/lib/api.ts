// API client for the backend. All requests are authenticated via the JWT
// stored in localStorage (see AuthContext).

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

export interface LinkedWallet {
  id: string;
  address: string;
  chain: string;
  isPrimary: boolean;
  linkedAt: string;
}

export interface AuthSession {
  id: string;
  device: string;
  ipAddress: string;
  userAgent: string;
  createdAt: string;
  lastActiveAt: string;
  current: boolean;
}

export interface NotificationPreferences {
  email: boolean;
  push: boolean;
  liquidations: boolean;
  priceAlerts: boolean;
}

export interface SecurityPreferences {
  twoFactorEnabled: boolean;
}

function getAuthToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("auth_token");
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getAuthToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const message = await res.text().catch(() => res.statusText);
    throw new Error(message || `Request failed with status ${res.status}`);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body ?? {}) }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

// --- Settings: linked wallets ---------------------------------------------

export function getLinkedWallets(userId: string): Promise<LinkedWallet[]> {
  return api.get<LinkedWallet[]>(`/users/${userId}/wallets`);
}

export function addLinkedWallet(
  userId: string,
  address: string,
  chain: string,
): Promise<LinkedWallet> {
  return api.post<LinkedWallet>(`/users/${userId}/wallets`, { address, chain });
}

export function disconnectLinkedWallet(
  userId: string,
  walletId: string,
): Promise<void> {
  return api.delete<void>(`/users/${userId}/wallets/${walletId}`);
}

// --- Settings: sessions ----------------------------------------------------

export function getAuthSessions(): Promise<AuthSession[]> {
  return api.get<AuthSession[]>("/auth/sessions");
}

export function revokeAuthSession(sessionId: string): Promise<void> {
  return api.delete<void>(`/auth/sessions/${sessionId}`);
}

// --- Settings: notification preferences -----------------------------------

export function getNotificationPreferences(
  userId: string,
): Promise<NotificationPreferences> {
  return api.get<NotificationPreferences>(
    `/users/${userId}/notification-preferences`,
  );
}

export function updateNotificationPreferences(
  userId: string,
  prefs: NotificationPreferences,
): Promise<NotificationPreferences> {
  return api.put<NotificationPreferences>(
    `/users/${userId}/notification-preferences`,
    prefs,
  );
}

// --- Settings: security / 2FA ---------------------------------------------

export function getSecurityPreferences(): Promise<SecurityPreferences> {
  return api.get<SecurityPreferences>("/auth/security-preferences");
}

export function updateSecurityPreferences(
  prefs: SecurityPreferences,
): Promise<SecurityPreferences> {
  return api.put<SecurityPreferences>("/auth/security-preferences", prefs);
}
