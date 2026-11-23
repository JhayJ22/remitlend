'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useNotifications } from '@/hooks/useNotifications';
import Button from '@/components/atoms/Button';
import Toggle from '@/components/atoms/Toggle';
import Card from '@/components/molecules/Card';
import ConfirmDialog from '@/components/molecules/ConfirmDialog';
import { apiFetch } from '@/lib/api';

type LinkedWallet = {
  id: string;
  address: string;
  chain: string;
  linkedAt: string;
};

type Session = {
  id: string;
  device: string;
  ip: string;
  createdAt: string;
  lastActiveAt: string;
};

type NotificationPreferences = {
  email: boolean;
  push: boolean;
  liquidations: boolean;
  priceAlerts: boolean;
};

const DEFAULT_PREFERENCES: NotificationPreferences = {
  email: true,
  push: true,
  liquidations: true,
  priceAlerts: false,
};

export default function SettingsPage() {
  const { user } = useAuth();
  const { refresh: refreshNotifications } = useNotifications();

  const [wallets, setWallets] = useState<LinkedWallet[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [preferences, setPreferences] = useState<NotificationPreferences>(DEFAULT_PREFERENCES);
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(false);
  const [newAddress, setNewAddress] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingDisconnect, setPendingDisconnect] = useState<LinkedWallet | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<Session | null>(null);

  const loadSettings = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      const [walletRes, sessionRes, prefRes] = await Promise.all([
        apiFetch<{ wallets: LinkedWallet[] }>('/users/me/wallets'),
        apiFetch<{ sessions: Session[] }>('/auth/sessions'),
        apiFetch<{ preferences: NotificationPreferences; twoFactorEnabled: boolean }>(
          `/users/${user.id}/notification-preferences`,
        ),
      ]);
      setWallets(walletRes.wallets ?? []);
      setSessions(sessionRes.sessions ?? []);
      setPreferences(prefRes.preferences ?? DEFAULT_PREFERENCES);
      setTwoFactorEnabled(Boolean(prefRes.twoFactorEnabled));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const handleAddWallet = async () => {
    if (!newAddress.trim()) return;
    try {
      const res = await apiFetch<{ wallet: LinkedWallet }>('/users/me/wallets', {
        method: 'POST',
        body: JSON.stringify({ address: newAddress.trim() }),
      });
      setWallets((prev) => [...prev, res.wallet]);
      setNewAddress('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add wallet');
    }
  };

  const handleDisconnectWallet = async () => {
    if (!pendingDisconnect) return;
    const target = pendingDisconnect;
    setPendingDisconnect(null);
    try {
      await apiFetch(`/users/me/wallets/${target.id}`, { method: 'DELETE' });
      setWallets((prev) => prev.filter((w) => w.id !== target.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect wallet');
    }
  };

  const handleRevokeSession = async () => {
    if (!pendingRevoke) return;
    const target = pendingRevoke;
    setPendingRevoke(null);
    try {
      await apiFetch(`/auth/sessions/${target.id}`, { method: 'DELETE' });
      setSessions((prev) => prev.filter((s) => s.id !== target.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke session');
    }
  };

  const handlePreferenceChange = async (key: keyof NotificationPreferences, value: boolean) => {
    if (!user) return;
    const next = { ...preferences, [key]: value };
    setPreferences(next);
    try {
      await apiFetch(`/users/${user.id}/notification-preferences`, {
        method: 'PUT',
        body: JSON.stringify({ preferences: next }),
      });
      refreshNotifications?.();
    } catch (err) {
      setPreferences(preferences);
      setError(err instanceof Error ? err.message : 'Failed to update preferences');
    }
  };

  const handleTwoFactorToggle = async (value: boolean) => {
    if (!user) return;
    setTwoFactorEnabled(value);
    try {
      await apiFetch(`/users/${user.id}/notification-preferences`, {
        method: 'PUT',
        body: JSON.stringify({ twoFactorEnabled: value }),
      });
    } catch (err) {
      setTwoFactorEnabled(!value);
      setError(err instanceof Error ? err.message : 'Failed to update 2FA preference');
    }
  };

  if (loading) {
    return <div className="p-6 text-sm text-gray-400">Loading settings…</div>;
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      {error && <p className="text-sm text-red-500">{error}</p>}

      <Card title="Wallet">
        <ul className="flex flex-col gap-2">
          {wallets.length === 0 && <li className="text-sm text-gray-400">No linked addresses.</li>}
          {wallets.map((wallet) => (
            <li key={wallet.id} className="flex items-center justify-between gap-4">
              <span className="font-mono text-sm">
                {wallet.address} <span className="text-gray-400">({wallet.chain})</span>
              </span>
              <Button variant="danger" onClick={() => setPendingDisconnect(wallet)}>
                Disconnect
              </Button>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex gap-2">
          <input
            className="flex-1 rounded border border-gray-700 bg-transparent px-3 py-2 text-sm"
            placeholder="0x…"
            value={newAddress}
            onChange={(e) => setNewAddress(e.target.value)}
          />
          <Button onClick={handleAddWallet} disabled={!newAddress.trim()}>
            Add address
          </Button>
        </div>
      </Card>

      <Card title="Sessions">
        <ul className="flex flex-col gap-2">
          {sessions.length === 0 && <li className="text-sm text-gray-400">No active sessions.</li>}
          {sessions.map((session) => (
            <li key={session.id} className="flex items-center justify-between gap-4">
              <span className="text-sm">
                {session.device} · {session.ip}
                <span className="block text-xs text-gray-400">
                  Last active {new Date(session.lastActiveAt).toLocaleString()}
                </span>
              </span>
              <Button variant="danger" onClick={() => setPendingRevoke(session)}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Notifications">
        <div className="flex flex-col gap-3">
          {(['email', 'push', 'liquidations', 'priceAlerts'] as const).map((key) => (
            <label key={key} className="flex items-center justify-between text-sm capitalize">
              {key}
              <Toggle
                checked={preferences[key]}
                onChange={(value) => handlePreferenceChange(key, value)}
              />
            </label>
          ))}
        </div>
      </Card>

      <Card title="Security">
        <label className="flex items-center justify-between text-sm">
          Challenge-nonce based 2FA
          <Toggle checked={twoFactorEnabled} onChange={handleTwoFactorToggle} />
        </label>
      </Card>

      <ConfirmDialog
        open={pendingDisconnect !== null}
        title="Disconnect wallet"
        description={`Disconnect ${pendingDisconnect?.address ?? ''}?`}
        confirmLabel="Disconnect"
        onConfirm={handleDisconnectWallet}
        onCancel={() => setPendingDisconnect(null)}
      />

      <ConfirmDialog
        open={pendingRevoke !== null}
        title="Revoke session"
        description={`Revoke session on ${pendingRevoke?.device ?? ''}?`}
        confirmLabel="Revoke"
        onConfirm={handleRevokeSession}
        onCancel={() => setPendingRevoke(null)}
      />
    </div>
  );
}
