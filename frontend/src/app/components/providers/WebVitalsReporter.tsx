"use client";

import { useEffect } from "react";
import { onCLS, onINP, onLCP, type Metric } from "web-vitals";

const VITALS_ENDPOINT = "/api/analytics/vitals";

function reportMetric(metric: Metric): void {
  const payload = JSON.stringify({
    name: metric.name,
    value: metric.value,
    rating: metric.rating,
    id: metric.id,
    path: window.location.pathname,
  });

  if (navigator.sendBeacon) {
    navigator.sendBeacon(VITALS_ENDPOINT, new Blob([payload], { type: "application/json" }));
    return;
  }

  void fetch(VITALS_ENDPOINT, {
    method: "POST",
    body: payload,
    headers: { "Content-Type": "application/json" },
    keepalive: true,
  });
}

export function WebVitalsReporter(): null {
  useEffect(() => {
    onCLS(reportMetric);
    onINP(reportMetric);
    onLCP(reportMetric);
  }, []);

  return null;
}
