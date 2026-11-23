"use client";

import { useEffect, useRef, useState } from "react";
import { parseStellarQrPayload } from "../../utils/stellarQr";

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}
type BarcodeDetectorCtor = new (opts: { formats: string[] }) => BarcodeDetectorLike;

interface QrScannerProps {
  onScan: (address: string) => void;
  onClose: () => void;
}

/**
 * Camera QR scanner using the MediaDevices API and the browser BarcodeDetector.
 * Decodes raw Stellar G-addresses and SEP-7 payment URIs.
 */
export function QrScanner({ onScan, onClose }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    async function start() {
      const Detector = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor })
        .BarcodeDetector;
      if (!navigator.mediaDevices?.getUserMedia || !Detector) {
        setError("QR scanning is not supported in this browser. Paste the address instead.");
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
        if (cancelled) return;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => undefined);
        }
        const detector = new Detector({ formats: ["qr_code"] });
        timer = setInterval(async () => {
          if (!videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            for (const code of codes) {
              const address = parseStellarQrPayload(code.rawValue);
              if (address) {
                onScan(address);
                return;
              }
              setError("That QR code does not contain a valid Stellar address.");
            }
          } catch {
            // transient detection failure; try again on the next tick
          }
        }, 300);
      } catch {
        setError("Camera access was denied or is unavailable.");
      }
    }

    void start();
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onScan]);

  return (
    <div
      role="dialog"
      aria-label="Scan recipient QR code"
      className="space-y-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
    >
      <video ref={videoRef} muted playsInline className="w-full rounded-md bg-black" />
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={onClose}
        className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700"
      >
        Close scanner
      </button>
    </div>
  );
}
