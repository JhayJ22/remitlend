import Image, { type ImageProps } from "next/image";

export type OptimizedImageProps = Omit<ImageProps, "placeholder"> & {
  priority?: boolean;
  placeholder?: "blur" | "empty";
  blurDataURL?: string;
};

function createBlurDataURL(width: number, height: number) {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs>
        <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stop-color="#eef2ff" />
          <stop offset="100%" stop-color="#c7d2fe" />
        </linearGradient>
      </defs>
      <rect width="${width}" height="${height}" rx="12" fill="url(#g)"/>
      <circle cx="${Math.round(width * 0.32)}" cy="${Math.round(height * 0.35)}" r="${Math.round(Math.min(width, height) * 0.18)}" fill="rgba(79,70,229,0.25)"/>
      <path d="M${Math.round(width * 0.22)} ${Math.round(height * 0.72)} L${Math.round(width * 0.44)} ${Math.round(height * 0.46)} L${Math.round(width * 0.64)} ${Math.round(height * 0.72)} L${Math.round(width * 0.8)} ${Math.round(height * 0.38)}" stroke="rgba(79,70,229,0.45)" stroke-width="${Math.max(3, Math.round(Math.min(width, height) * 0.08))}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    </svg>
  `;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function OptimizedImage({
  priority = false,
  placeholder = "blur",
  blurDataURL,
  loading,
  fetchPriority,
  sizes,
  ...props
}: OptimizedImageProps) {
  const resolvedLoading = loading ?? (priority ? "eager" : "lazy");
  const resolvedBlurDataURL = blurDataURL ?? createBlurDataURL(Number(props.width ?? 64), Number(props.height ?? 64));

  return (
    <Image
      {...props}
      priority={priority}
      loading={resolvedLoading}
      placeholder={placeholder}
      blurDataURL={resolvedBlurDataURL}
      fetchPriority={fetchPriority ?? (priority ? "high" : undefined)}
      sizes={sizes ?? "(max-width: 768px) 100vw, 32px"}
    />
  );
}
