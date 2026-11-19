import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useNotificationStream } from './useNotificationStream';

export interface Notification {
  id: string;
  title: string;
  message: string;
  type?: string;
  read_at: string | null;
  created_at: string;
}

interface NotificationsResponse {
  data: Notification[];
  total: number;
}

interface UnreadCountResponse {
  count: number;
}

const NOTIFICATIONS_KEY = ['notifications'] as const;
const UNREAD_COUNT_KEY = ['notifications', 'unread-count'] as const;

export function useNotifications() {
  const queryClient = useQueryClient();
  const streamRef = useRef<ReturnType<typeof useNotificationStream> | null>(null);

  const notificationsQuery = useQuery<NotificationsResponse>({
    queryKey: NOTIFICATIONS_KEY,
    queryFn: async () => {
      const { data } = await api.get<NotificationsResponse>('/notifications');
      return data;
    },
  });

  const unreadCountQuery = useQuery<UnreadCountResponse>({
    queryKey: UNREAD_COUNT_KEY,
    queryFn: async () => {
      const { data } = await api.get<UnreadCountResponse>('/notifications/unread-count');
      return data;
    },
  });

  const invalidateNotifications = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
    queryClient.invalidateQueries({ queryKey: UNREAD_COUNT_KEY });
  }, [queryClient]);

  const stream = useNotificationStream({
    onNotification: () => {
      invalidateNotifications();
    },
  });
  streamRef.current = stream;

  const markAsRead = useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.put<Notification>(`/notifications/${id}/read`);
      return data;
    },
    onSuccess: () => {
      invalidateNotifications();
    },
  });

  const markAllAsRead = useMutation({
    mutationFn: async () => {
      const { data } = await api.put<{ updated: number }>('/notifications/read-all');
      return data;
    },
    onSuccess: () => {
      invalidateNotifications();
    },
  });

  const notifications = notificationsQuery.data?.data ?? [];
  const unreadCount = unreadCountQuery.data?.count ?? 0;

  const unreadNotifications = useMemo(
    () => notifications.filter((n) => n.read_at === null),
    [notifications],
  );

  useEffect(() => {
    return () => {
      streamRef.current = null;
    };
  }, []);

  return {
    notifications,
    unreadNotifications,
    unreadCount,
    isLoading: notificationsQuery.isLoading,
    isError: notificationsQuery.isError,
    markAsRead: markAsRead.mutate,
    markAllAsRead: markAllAsRead.mutate,
    isMarkingAsRead: markAsRead.isPending,
    isMarkingAllAsRead: markAllAsRead.isPending,
    refetch: invalidateNotifications,
  };
}
