'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useNotificationStream } from '../hooks/useNotificationStream';
import { apiClient } from '../lib/apiClient';

export interface Notification {
  id: string;
  title: string;
  message: string;
  read_at: string | null;
  created_at: string;
  [key: string]: unknown;
}

interface NotificationContextValue {
  notifications: Notification[];
  unreadCount: number;
  loading: boolean;
  markAsRead: (id: string) => Promise<void>;
  markAllAsRead: () => Promise<void>;
  refresh: () => Promise<void>;
}

const NotificationContext = createContext<NotificationContextValue | undefined>(
  undefined,
);

export function NotificationProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchUnreadCount = useCallback(async () => {
    try {
      const { data } = await apiClient.get<{ count: number }>(
        '/notifications/unread-count',
      );
      if (mountedRef.current) {
        setUnreadCount(typeof data?.count === 'number' ? data.count : 0);
      }
    } catch {
      // Keep the last known count on transient failures.
    }
  }, []);

  const fetchNotifications = useCallback(async () => {
    try {
      const { data } = await apiClient.get<Notification[]>('/notifications');
      if (mountedRef.current) {
        setNotifications(Array.isArray(data) ? data : []);
      }
    } catch {
      if (mountedRef.current) {
        setNotifications([]);
      }
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    await Promise.all([fetchNotifications(), fetchUnreadCount()]);
    if (mountedRef.current) {
      setLoading(false);
    }
  }, [fetchNotifications, fetchUnreadCount]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const markAsRead = useCallback(
    async (id: string) => {
      // Optimistic update; persisted via PUT /notifications/:id/read.
      setNotifications((prev) =>
        prev.map((n) =>
          n.id === id && !n.read_at
            ? { ...n, read_at: new Date().toISOString() }
            : n,
        ),
      );
      setUnreadCount((prev) => Math.max(0, prev - 1));

      try {
        await apiClient.put(`/notifications/${id}/read`);
      } catch {
        // Re-sync from the server if persistence failed.
      } finally {
        await Promise.all([fetchNotifications(), fetchUnreadCount()]);
      }
    },
    [fetchNotifications, fetchUnreadCount],
  );

  const markAllAsRead = useCallback(async () => {
    const now = new Date().toISOString();
    setNotifications((prev) =>
      prev.map((n) => (n.read_at ? n : { ...n, read_at: now })),
    );
    setUnreadCount(0);

    try {
      await apiClient.put('/notifications/read-all');
    } catch {
      // Re-sync from the server if persistence failed.
    } finally {
      await Promise.all([fetchNotifications(), fetchUnreadCount()]);
    }
  }, [fetchNotifications, fetchUnreadCount]);

  const handleStreamNotification = useCallback(
    (notification: Notification) => {
      setNotifications((prev) => {
        if (prev.some((n) => n.id === notification.id)) {
          return prev;
        }
        return [notification, ...prev];
      });
      if (!notification.read_at) {
        setUnreadCount((prev) => prev + 1);
      }
      // Invalidate the list cache so the next read reflects server truth.
      void fetchNotifications();
      void fetchUnreadCount();
    },
    [fetchNotifications, fetchUnreadCount],
  );

  useNotificationStream({ onNotification: handleStreamNotification });

  const value = useMemo<NotificationContextValue>(
    () => ({
      notifications,
      unreadCount,
      loading,
      markAsRead,
      markAllAsRead,
      refresh,
    }),
    [notifications, unreadCount, loading, markAsRead, markAllAsRead, refresh],
  );

  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications(): NotificationContextValue {
  const ctx = useContext(NotificationContext);
  if (!ctx) {
    throw new Error('useNotifications must be used within a NotificationProvider');
  }
  return ctx;
}
