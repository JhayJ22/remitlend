'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useNotificationContext } from '@/context/NotificationContext';
import type { Notification } from '@/types/notification';

const MAX_UNREAD = 5;

function formatRelativeTime(value: string): string {
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return '';
  const diffSeconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diffSeconds < 60) return 'just now';
  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function NotificationDropdown() {
  const {
    notifications,
    unreadCount,
    markAsRead,
    markAllAsRead,
    loading,
  } = useNotificationContext();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(event: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const unreadNotifications: Notification[] = notifications
    .filter((notification) => !notification.read_at)
    .slice(0, MAX_UNREAD);

  const badgeLabel =
    unreadCount > 0
      ? `${unreadCount} unread notification${unreadCount === 1 ? '' : 's'}`
      : 'No unread notifications';

  return (
    <div className="notification-dropdown" ref={containerRef}>
      <button
        type="button"
        className="notification-dropdown__trigger"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={badgeLabel}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span aria-hidden="true">🔔</span>
        {unreadCount > 0 && (
          <span
            className="notification-dropdown__badge"
            aria-label={badgeLabel}
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="notification-dropdown__panel" role="menu">
          <div className="notification-dropdown__header">
            <span>Notifications</span>
            {unreadCount > 0 && (
              <button
                type="button"
                className="notification-dropdown__mark-all"
                onClick={() => void markAllAsRead()}
              >
                Mark all as read
              </button>
            )}
          </div>

          {loading && unreadNotifications.length === 0 ? (
            <p className="notification-dropdown__empty">Loading…</p>
          ) : unreadNotifications.length === 0 ? (
            <p className="notification-dropdown__empty">You&apos;re all caught up.</p>
          ) : (
            <ul className="notification-dropdown__list">
              {unreadNotifications.map((notification) => (
                <li key={notification.id} className="notification-dropdown__item">
                  <button
                    type="button"
                    className="notification-dropdown__item-button"
                    onClick={() => void markAsRead(notification.id)}
                  >
                    <span className="notification-dropdown__item-title">
                      {notification.title}
                    </span>
                    {notification.message && (
                      <span className="notification-dropdown__item-message">
                        {notification.message}
                      </span>
                    )}
                    <span className="notification-dropdown__item-time">
                      {formatRelativeTime(notification.created_at)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <Link
            href="/notifications"
            className="notification-dropdown__see-all"
            onClick={() => setOpen(false)}
          >
            See all
          </Link>
        </div>
      )}
    </div>
  );
}
