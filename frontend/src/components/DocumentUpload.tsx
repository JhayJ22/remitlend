import { useCallback, useEffect, useId, useRef, useState } from 'react';

export type UploadStatus = 'idle' | 'uploading' | 'success' | 'rejected' | 'error';

export interface DocumentUploadProps {
  /** Called with the selected file once consent is granted and upload starts. */
  onUpload?: (file: File, onProgress: (percent: number) => void) => Promise<void>;
  /** Called when the user removes a file or revokes consent. */
  onRemove?: () => void;
  /** Optional accept attribute forwarded to the file input. */
  accept?: string;
  /** Optional max size in bytes; larger files are rejected client-side. */
  maxSizeBytes?: number;
}

const DEFAULT_MAX_SIZE = 10 * 1024 * 1024;

export default function DocumentUpload({
  onUpload,
  onRemove,
  accept,
  maxSizeBytes = DEFAULT_MAX_SIZE,
}: DocumentUploadProps) {
  const inputId = useId();
  const consentId = useId();
  const statusId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [status, setStatus] = useState<UploadStatus>('idle');
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState('');

  const resetFileData = useCallback(() => {
    setFile(null);
    setProgress(0);
    setStatus('idle');
    setMessage('');
    if (inputRef.current) {
      inputRef.current.value = '';
    }
  }, []);

  // Discard retained file data whenever consent is not granted.
  useEffect(() => {
    if (!consent && file) {
      resetFileData();
      onRemove?.();
    }
  }, [consent, file, resetFileData, onRemove]);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0] ?? null;
    setProgress(0);
    setMessage('');
    if (!selected) {
      setFile(null);
      setStatus('idle');
      return;
    }
    if (selected.size > maxSizeBytes) {
      setFile(null);
      setStatus('rejected');
      setMessage(
        `File is too large. Maximum size is ${Math.round(maxSizeBytes / (1024 * 1024))} MB.`,
      );
      if (inputRef.current) {
        inputRef.current.value = '';
      }
      return;
    }
    setFile(selected);
    setStatus('idle');
  };

  const startUpload = async () => {
    if (!file || !consent) {
      return;
    }
    setStatus('uploading');
    setProgress(0);
    setMessage('');
    try {
      await onUpload?.(file, (percent) => {
        setProgress(Math.max(0, Math.min(100, Math.round(percent))));
      });
      setProgress(100);
      setStatus('success');
      setMessage('Upload complete.');
    } catch (err) {
      setStatus('error');
      setMessage(
        err instanceof Error && err.message
          ? `Upload failed: ${err.message}`
          : 'Upload failed. Please retry.',
      );
    }
  };

  const handleRemove = () => {
    resetFileData();
    onRemove?.();
  };

  const handleConsentChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setConsent(event.target.checked);
  };

  const isBusy = status === 'uploading';
  const canUpload = Boolean(file) && consent && !isBusy;
  const liveMode = status === 'rejected' || status === 'error' ? 'assertive' : 'polite';

  return (
    <div className="document-upload">
      <label htmlFor={inputId} className="document-upload__label">
        Upload document
      </label>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept={accept}
        onChange={handleFileChange}
        disabled={isBusy}
        aria-describedby={statusId}
        className="document-upload__input"
      />

      <div className="document-upload__consent">
        <input
          id={consentId}
          type="checkbox"
          checked={consent}
          onChange={handleConsentChange}
          disabled={isBusy}
        />
        <label htmlFor={consentId}>
          I consent to uploading this document for processing.
        </label>
      </div>

      {file && (
        <p className="document-upload__filename">
          Selected: <strong>{file.name}</strong>
        </p>
      )}

      {status === 'uploading' && (
        <div
          className="document-upload__progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
          aria-label="Upload progress"
        >
          <div
            className="document-upload__progress-bar"
            style={{ width: `${progress}%` }}
          />
          <span>{progress}%</span>
        </div>
      )}

      <div
        id={statusId}
        className="document-upload__status"
        role="status"
        aria-live={liveMode}
        aria-atomic="true"
      >
        {status === 'uploading' && `Uploading… ${progress}%`}
        {status === 'success' && message}
        {status === 'rejected' && message}
        {status === 'error' && message}
      </div>

      <div className="document-upload__actions">
        <button
          type="button"
          onClick={startUpload}
          disabled={!canUpload}
          className="document-upload__button"
        >
          {status === 'error' ? 'Retry upload' : 'Upload'}
        </button>
        <button
          type="button"
          onClick={handleRemove}
          disabled={!file && status === 'idle'}
          className="document-upload__button document-upload__button--secondary"
        >
          Remove
        </button>
      </div>
    </div>
  );
}
