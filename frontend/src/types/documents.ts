/**
 * Document upload domain types.
 *
 * These types describe the supported upload lifecycle, consent gating, and
 * user-visible status/rejection states for accessible document upload.
 */

/**
 * Supported upload lifecycle states.
 *
 * - `idle`: no file selected / awaiting consent.
 * - `uploading`: transfer in progress (progress 0-100).
 * - `success`: upload completed and accepted.
 * - `rejected`: upload refused; `rejectionReason` is user-visible.
 * - `error`: transient failure that may be retried.
 * - `removed`: file data discarded (removal or revoked consent).
 */
export type DocumentUploadState =
  | 'idle'
  | 'uploading'
  | 'success'
  | 'rejected'
  | 'error'
  | 'removed';

/**
 * Explicit consent status for handling a document.
 * Uploads MUST NOT proceed unless consent is `granted`.
 */
export type DocumentConsentStatus = 'pending' | 'granted' | 'revoked';

/**
 * User-visible rejection reasons. Kept as a closed set so the UI can render
 * a stable, accessible message for each case.
 */
export type DocumentRejectionReason =
  | 'file-too-large'
  | 'unsupported-type'
  | 'consent-required'
  | 'consent-revoked'
  | 'upload-failed';

/**
 * Input constraints applied before an upload is attempted.
 */
export interface DocumentUploadConstraints {
  /** Maximum accepted file size in bytes. */
  maxSizeBytes: number;
  /** Accepted MIME types (e.g. `application/pdf`). */
  acceptedTypes: string[];
}

/**
 * Snapshot of the upload flow state consumed by the UI.
 *
 * When `state` is `removed` or consent is `revoked`, `fileName` and
 * `sizeBytes` MUST be cleared so no file data is retained.
 */
export interface DocumentUploadStatus {
  state: DocumentUploadState;
  /** Upload progress 0-100; only meaningful while `uploading`. */
  progress: number;
  consent: DocumentConsentStatus;
  /** Selected file name; cleared on removal or revoked consent. */
  fileName: string | null;
  /** Selected file size in bytes; cleared on removal or revoked consent. */
  sizeBytes: number | null;
  /** Present when `state` is `rejected`. */
  rejectionReason: DocumentRejectionReason | null;
  /** Whether a retry action is available for the current state. */
  canRetry: boolean;
  /** Whether a remove action is available for the current state. */
  canRemove: boolean;
}

/**
 * Initial upload status before any file is selected.
 */
export const INITIAL_DOCUMENT_UPLOAD_STATUS: DocumentUploadStatus = {
  state: 'idle',
  progress: 0,
  consent: 'pending',
  fileName: null,
  sizeBytes: null,
  rejectionReason: null,
  canRetry: false,
  canRemove: false,
};

/**
 * Politeness for the aria-live region based on the current state.
 * Progress updates are polite; rejections and errors are assertive.
 */
export function getStatusAnnouncementPoliteness(
  state: DocumentUploadState,
): 'polite' | 'assertive' {
  return state === 'rejected' || state === 'error' ? 'assertive' : 'polite';
}
