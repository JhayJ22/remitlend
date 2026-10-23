import { query } from '../db/connection.js';
import logger from '../utils/logger.js';
import type { Response } from 'express';

// ─── Types ────────────────────────────────────────────────────────────────────

export type NotificationType =
  | 'loan_approved'
  | 'repayment_due'
  | 'repayment_confirmed'
  | 'loan_defaulted'
  | 'loan_liquidated'
  | 'score_changed';

export type NotificationStatus = 'unread' | 'read' | 'archived';

export type NotificationChannel = 'email' | 'sms' | 'in_app';

export const SUPPORTED_CHANNELS: readonly NotificationChannel[] = ['email', 'sms', 'in_app'];

/**
 * Category model:
 *  - 'loan_activity' and 'score' are user-governed (opt-out allowed).
 *  - 'security' and 'legal' are MANDATORY: they are always delivered on every
 *    channel the user has a contact for, ignoring channel opt-outs, quiet hours
 *    and per-type overrides. They cannot be disabled through preferences.
 */
export type NotificationCategory = 'loan_activity' | 'score' | 'security' | 'legal';

export const SUPPORTED_CATEGORIES: readonly NotificationCategory[] = [
  'loan_activity',
  'score',
  'security',
  'legal',
];

export const MANDATORY_CATEGORIES: readonly NotificationCategory[] = ['security', 'legal'];

export const MANDATORY_NOTIFICATION_POLICY = `
Mandatory notifications (categories: ${MANDATORY_CATEGORIES.join(', ')}) are always delivered.
Users cannot opt out of them, and quiet hours do not suppress them. They are delivered
to every contact channel the user has on file (email and/or SMS).
`.trim();

const TYPE_CATEGORY: Record<NotificationType, NotificationCategory> = {
  loan_approved: 'loan_activity',
  repayment_due: 'loan_activity',
  repayment_confirmed: 'loan_activity',
  loan_defaulted: 'legal',
  loan_liquidated: 'legal',
  score_changed: 'score',
};

export function categoryForType(type: NotificationType): NotificationCategory {
  return TYPE_CATEGORY[type];
}

export interface Notification {
  id: number;
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  loanId?: number | undefined;
  actionUrl?: string | null;
  read: boolean;
  status: NotificationStatus;
  createdAt: Date;
}

interface CreateNotificationParams {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  loanId?: number | undefined;
  actionUrl?: string | undefined | null;
}

export interface QuietHours {
  enabled: boolean;
  /** Local start hour (0-23), inclusive. */
  startHour: number;
  /** Local end hour (0-23), exclusive. May be less than startHour (overnight window). */
  endHour: number;
}

export interface NotificationPreferences {
  /** Channels the user has opted into for non-mandatory categories. */
  channels: NotificationChannel[];
  /** Non-mandatory categories the user has enabled. */
  categories: NotificationCategory[];
  locale: string;
  timezone: string;
  quietHours: QuietHours;
  emailEnabled: boolean;
  smsEnabled: boolean;
  phone: string | null;
  perTypeOverrides: Record<string, boolean>;
  digestFrequency?: 'off' | 'daily' | 'weekly';
}

export interface NotificationPreferencesUpdate {
  emailEnabled: boolean;
  smsEnabled: boolean;
  phone: string | null;
  channels?: NotificationChannel[];
  categories?: NotificationCategory[];
  locale?: string;
  timezone?: string;
  quietHours?: QuietHours;
}

export const DEFAULT_PREFERENCES: Omit<
  NotificationPreferences,
  'emailEnabled' | 'smsEnabled' | 'phone' | 'perTypeOverrides'
> = {
  channels: ['email', 'in_app'],
  categories: ['loan_activity', 'score'],
  locale: 'en-US',
  timezone: 'UTC',
  quietHours: { enabled: false, startHour: 22, endHour: 7 },
};

/**
 * Cutoff policy: preference changes apply to messages whose delivery decision
 * has not yet been made. A decision is made at queue-dispatch time, so any
 * change saved before dispatch takes effect; changes saved after dispatch do
 * not retroactively affect that message.
 */
export const PREFERENCE_CUTOFF_POLICY =
  'Preference changes apply to any notification not yet dispatched at the time the change is saved.';

// ─── Validation ───────────────────────────────────────────────────────────────

const LOCALE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const PHONE_RE = /^\+[1-9]\d{6,14}$/;

export function isValidTimezone(tz: string): boolean {
  if (typeof tz !== 'string' || tz.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function validatePreferencesUpdate(input: NotificationPreferencesUpdate): void {
  if (input.channels !== undefined) {
    if (!Array.isArray(input.channels)) throw new Error('channels must be an array');
    for (const c of input.channels) {
      if (!SUPPORTED_CHANNELS.includes(c)) throw new Error(`Unsupported channel: ${c}`);
    }
  }
  if (input.categories !== undefined) {
    if (!Array.isArray(input.categories)) throw new Error('categories must be an array');
    for (const c of input.categories) {
      if (!SUPPORTED_CATEGORIES.includes(c)) throw new Error(`Unsupported category: ${c}`);
      if (MANDATORY_CATEGORIES.includes(c)) {
        throw new Error(`Category '${c}' is mandatory and cannot be configured`);
      }
    }
  }
  if (input.locale !== undefined && !LOCALE_RE.test(input.locale)) {
    throw new Error('Invalid locale');
  }
  if (input.timezone !== undefined && !isValidTimezone(input.timezone)) {
    throw new Error('Invalid timezone');
  }
  if (input.quietHours !== undefined) {
    const q = input.quietHours;
    if (typeof q.enabled !== 'boolean') throw new Error('quietHours.enabled must be boolean');
    for (const h of [q.startHour, q.endHour]) {
      if (!Number.isInteger(h) || h < 0 || h > 23) {
        throw new Error('quietHours hours must be integers 0-23');
      }
    }
    if (q.enabled && q.startHour === q.endHour) {
      throw new Error('quietHours start and end must differ when enabled');
    }
  }
  if (input.phone !== null && input.phone !== undefined && !PHONE_RE.test(input.phone)) {
    throw new Error('Invalid phone number (E.164 expected)');
  }
}

// ─── Quiet hours (timezone-aware, DST-safe) ──────────────────────────────────

/**
 * Returns the local hour (0-23) of `instant` in `timezone`. Uses Intl, which
 * applies the correct DST offset for that instant.
 */
export function localHourAt(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const hour = parts.find((p) => p.type === 'hour');
  return hour ? Number(hour.value) % 24 : 0;
}

/**
 * Determines whether `instant` falls inside the quiet window in the user's
 * timezone. Resolution is hour-granular and evaluated on the real instant, so
 * on a fall-back transition the repeated hour is treated consistently (both
 * occurrences are evaluated by their actual local hour), and on a spring-forward
 * gap no instant maps to the skipped local hour, so there is no ambiguity.
 * Mandatory categories bypass this check entirely.
 */
export function isInQuietHours(instant: Date, quiet: QuietHours, timezone: string): boolean {
  if (!quiet.enabled) return false;
  const h = localHourAt(instant, timezone);
  const { startHour: s, endHour: e } = quiet;
  return s < e ? h >= s && h < e : h >= s || h < e;
}

/**
 * Returns the next instant (UTC) at which the quiet window ends, searching
 * forward hour by hour. Deterministic: depends only on the inputs.
 */
export function nextQuietEnd(instant: Date, quiet: QuietHours, timezone: string): Date {
  let t = instant.getTime();
  const limit = t + 48 * 3600_000;
  while (t <= limit) {
    const candidate = new Date(t);
    if (!isInQuietHours(candidate, quiet, timezone)) return candidate;
    t += 3600_000;
  }
  return instant;
}

// ─── Delivery decision ───────────────────────────────────────────────────────

export interface DeliveryDecision {
  email: boolean;
  sms: boolean;
  reason: 'mandatory' | 'delivered' | 'opted_out' | 'quiet_hours' | 'no_contact';
  deliverAt: Date;
}

export function decideDelivery(
  type: NotificationType,
  prefs: NotificationPreferences,
  now: Date,
  hasEmail: boolean,
  hasPhone: boolean,
): DeliveryDecision {
  const category = categoryForType(type);

  if (MANDATORY_CATEGORIES.includes(category)) {
    return {
      email: hasEmail,
      sms: hasPhone,
      reason: hasEmail || hasPhone ? 'mandatory' : 'no_contact',
      deliverAt: now,
    };
  }

  if (!prefs.categories.includes(category)) {
    return { email: false, sms: false, reason: 'opted_out', deliverAt: now };
  }

  if (prefs.perTypeOverrides[type] === false) {
    return { email: false, sms: false, reason: 'opted_out', deliverAt: now };
  }

  if (isInQuietHours(now, prefs.quietHours, prefs.timezone)) {
    return {
      email: false,
      sms: false,
      reason: 'quiet_hours',
      deliverAt: nextQuietEnd(now, prefs.quietHours, prefs.timezone),
    };
  }

  const emailOk = hasEmail && prefs.emailEnabled && prefs.channels.includes('email');
  const smsOk = hasPhone && prefs.smsEnabled && prefs.channels.includes('sms');
  const smsEligibleType = type === 'repayment_due' || type === 'loan_defaulted' || type === 'loan_liquidated';

  return {
    email: emailOk,
    sms: smsOk && smsEligibleType,
    reason: emailOk || smsOk ? 'delivered' : 'no_contact',
    deliverAt: now,
  };
}

// ─── SSE subscriber registry ──────────────────────────────────────────────────
// Maps userId → set of SSE response streams currently listening.
// No persistence needed — streams are in-process only.

type SseClient = Response;
const sseClients = new Map<string, Set<SseClient>>();

// Lazy-init Twilio client — dynamic import avoids ESM/CJS interop issues in tests
async function getTwilioClient() {
  if (
    !process.env.TWILIO_ACCOUNT_SID ||
    !process.env.TWILIO_AUTH_TOKEN ||
    !process.env.TWILIO_PHONE_NUMBER
  ) {
    return null;
  }
  const { default: twilio } = await import('twilio');
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

// Lazy-init SendGrid — called once on first sendEmail
let _sgInitialized = false;
async function ensureSendGrid() {
  if (_sgInitialized) return;
  _sgInitialized = true;
  if (process.env.SENDGRID_API_KEY) {
    const sgMail = await import('@sendgrid/mail');
    sgMail.default.setApiKey(process.env.SENDGRID_API_KEY);
  }
}

function buildEmailTemplate(
  type: NotificationType,
  message: string,
): { subject: string; html: string } {
  const templates: Record<NotificationType, { subject: string; html: string }> = {
    loan_approved: {
      subject: 'Your loan has been approved — RemitLend',
      html: `<h2>Loan Approved</h2><p>${message}</p><p>Log in to view your loan details and repayment schedule.</p>`,
    },
    repayment_due: {
      subject: 'Repayment reminder — RemitLend',
      html: `<h2>Repayment Due Soon</h2><p>${message}</p><p>Please ensure funds are available to avoid a default.</p>`,
    },
    repayment_confirmed: {
      subject: 'Repayment confirmed — RemitLend',
      html: `<h2>Repayment Confirmed</h2><p>${message}</p><p>Thank you for your payment.</p>`,
    },
    loan_defaulted: {
      subject: 'Loan default notice — RemitLend',
      html: `<h2>Loan Defaulted</h2><p>${message}</p><p>Contact support immediately if you believe this is an error.</p>`,
    },
    loan_liquidated: {
      subject: 'Your loan has been liquidated — RemitLend',
      html: `<h2>Loan Liquidated</h2><p>${message}</p><p>Contact support if you have questions about the outcome.</p>`,
    },
    score_changed: {
      subject: 'Your credit score has changed — RemitLend',
      html: `<h2>Credit Score Update</h2><p>${message}</p><p>Log in to see your updated score and history.</p>`,
    },
  };

  return templates[type];
}

// NOTE: sendEmail / SMS dispatch / SSE broadcast / persistence functions were
// truncated in the submitted source and must be restored from the original
// file before this change is merged. They are intentionally not reconstructed here.
