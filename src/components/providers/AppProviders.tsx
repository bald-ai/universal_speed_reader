"use client";

import type { ReactNode } from "react";
import { useEffect } from "react";
import { SettingsProvider } from "@/contexts/SettingsContext";
import { Capacitor } from "@capacitor/core";

function ServiceWorkerRegistrar() {
  useEffect(() => {
    // Defer to after hydration using setTimeout
    const timeoutId = setTimeout(() => {
      if (typeof window === "undefined") return;
      if (Capacitor.isNativePlatform()) return;
      if (!("serviceWorker" in navigator)) return;

      navigator.serviceWorker
        .register("/sw.js", {
          scope: "/",
          updateViaCache: "none"
        })
        .catch(() => {
          // ignore registration errors for MVP
        });
    }, 100);

    return () => clearTimeout(timeoutId);
  }, []);

  return null;
}

export default function AppProviders(props: { children: ReactNode }) {
  return (
    <SettingsProvider>
      <ServiceWorkerRegistrar />
      {props.children}
    </SettingsProvider>
  );
}
