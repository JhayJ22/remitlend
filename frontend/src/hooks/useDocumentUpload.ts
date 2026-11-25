import { useCallback, useEffect, useRef, useState } from 'react';

export type DocumentUploadStatus =
  | 'idle'
  | 'uploading'
  | 'success'
  | 'rejected'
  | 'error';

export interface DocumentUploadState {
  status: DocumentUploadStatus;
  progress: number;
  fileName: string | null;
  rejectionReason: string | null;
  errorMessage: string | null;
  consentGranted: boolean;
  /** Polite announcement for progress/success transitions. */
  announcement: string;
  /** Assertive announcement for rejection/error transitions. */
  alert: string;
}

export interface UploadResult {
  ok: boolean;
  reason?: string;
}

export type UploadFn = (
  file: File,
  onProgress: (percent: number) => void,
  signal: AbortSignal,
) => Promise<UploadResult>;

export interface UseDocumentUploadOptions {
  upload: UploadFn;
  /** Maximum accepted file size in bytes. */
  maxBytes?: number;
  /** Accepted MIME types; empty means accept all. */
  acceptedTypes?: string[];
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

const initialState: DocumentUploadState = {
  status: 'idle',
  progress: 0,
  fileName: null,
  rejectionReason: null,
  errorMessage: null,
  consentGranted: false,
  announcement: '',
  alert: '',
};

function validateFile(
  file: File,
  maxBytes: number,
  acceptedTypes: string[],
): string | null {
  if (file.size > maxBytes) {
    return `File is too large. Maximum size is ${Math.round(maxBytes / (1024 * 1024))} MB.`;
  }
  if (acceptedTypes.length > 0 && !acceptedTypes.includes(file.type)) {
    return `Unsupported file type. Accepted types: ${acceptedTypes.join(', ')}.`;
  }
  return null;
}

export function useDocumentUpload(options: UseDocumentUploadOptions) {
  const { upload, maxBytes = DEFAULT_MAX_BYTES, acceptedTypes = [] } = options;

  const [state, setState] = useState<DocumentUploadState>(initialState);
  const fileRef = useRef<File | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const discardFile = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    fileRef.current = null;
  }, []);

  const reset = useCallback(() => {
    discardFile();
    setState(initialState);
  }, [discardFile]);

  const setConsent = useCallback(
    (granted: boolean) => {
      if (!granted) {
        // Revoked consent: discard any retained file data and reset state.
        discardFile();
        setState({
          ...initialState,
          consentGranted: false,
          announcement: 'Consent revoked. Uploaded file data has been discarded.',
        });
        return;
      }
      setState((prev) => ({ ...prev, consentGranted: true }));
    },
    [discardFile],
  );

  const selectFile = useCallback(
    (file: File | null) => {
      if (!file) {
        return;
      }
      if (!state.consentGranted) {
        setState((prev) => ({
          ...prev,
          status: 'rejected',
          rejectionReason: 'Consent is required before uploading a document.',
          alert: 'Upload rejected. Consent is required before uploading a document.',
        }));
        return;
      }
      const validationError = validateFile(file, maxBytes, acceptedTypes);
      if (validationError) {
        fileRef.current = null;
        setState((prev) => ({
          ...prev,
          status: 'rejected',
          progress: 0,
          fileName: file.name,
          rejectionReason: validationError,
          errorMessage: null,
          alert: `Upload rejected. ${validationError}`,
        }));
        return;
      }
      fileRef.current = file;
      setState((prev) => ({
        ...prev,
        status: 'idle',
        progress: 0,
        fileName: file.name,
        rejectionReason: null,
        errorMessage: null,
        announcement: `Selected ${file.name}. Ready to upload.`,
        alert: '',
      }));
    },
    [acceptedTypes, maxBytes, state.consentGranted],
  );

  const startUpload = useCallback(async () => {
    const file = fileRef.current;
    if (!file) {
      return;
    }
    if (!state.consentGranted) {
      setState((prev) => ({
        ...prev,
        status: 'rejected',
        rejectionReason: 'Consent is required before uploading a document.',
        alert: 'Upload rejected. Consent is required before uploading a document.',
      }));
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState((prev) => ({
      ...prev,
      status: 'uploading',
      progress: 0,
      rejectionReason: null,
      errorMessage: null,
      announcement: `Uploading ${file.name}.`,
      alert: '',
    }));

    try {
      const result = await upload(file, (percent) => {
        const clamped = Math.max(0, Math.min(100, Math.round(percent)));
        setState((prev) =>
          prev.status === 'uploading'
            ? {
                ...prev,
                progress: clamped,
                announcement: `Uploading ${file.name}: ${clamped} percent.`,
              }
            : prev,
        );
      }, controller.signal);

      if (controller.signal.aborted) {
        return;
      }

      if (result.ok) {
        fileRef.current = null;
        setState((prev) => ({
          ...prev,
          status: 'success',
          progress: 100,
          announcement: `${file.name} uploaded successfully.`,
          alert: '',
        }));
      } else {
        const reason = result.reason ?? 'The document was rejected.';
        fileRef.current = null;
        setState((prev) => ({
          ...prev,
          status: 'rejected',
          progress: 0,
          rejectionReason: reason,
          announcement: '',
          alert: `Upload rejected. ${reason}`,
        }));
      }
    } catch (err) {
      if (controller.signal.aborted) {
        return;
      }
      const message =
        err instanceof Error ? err.message : 'Upload failed. Please try again.';
      setState((prev) => ({
        ...prev,
        status: 'error',
        progress: 0,
        errorMessage: message,
        announcement: '',
        alert: `Upload failed. ${message}`,
      }));
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  }, [state.consentGranted, upload]);

  const retry = useCallback(async () => {
    if (!fileRef.current) {
      return;
    }
    await startUpload();
  }, [startUpload]);

  const remove = useCallback(() => {
    discardFile();
    setState((prev) => ({
      ...prev,
      status: 'idle',
      progress: 0,
      fileName: null,
      rejectionReason: null,
      errorMessage: null,
      announcement: 'Document removed.',
      alert: '',
    }));
  }, [discardFile]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
      fileRef.current = null;
    };
  }, []);

  return {
    ...state,
    canUpload:
      state.consentGranted &&
      state.status !== 'uploading' &&
      fileRef.current !== null,
    canRetry:
      state.consentGranted &&
      (state.status === 'error' || state.status === 'rejected') &&
      fileRef.current !== null,
    canRemove: state.status !== 'idle' || fileRef.current !== null,
    selectFile,
    startUpload,
    retry,
    remove,
    reset,
    setConsent,
  };
}
