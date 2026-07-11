
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { SettingsProvider } from "@/contexts/SettingsContext";
import { Capacitor } from "@capacitor/core";
import { applyBookParserLibraryReset } from "@/lib/import/bookParserLibraryReset";

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

function BookParserResetGate(props: { children: ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void applyBookParserLibraryReset()
      .catch((error) => {
        // Do not leave the entire app blank if a local storage implementation
        // temporarily fails; the next launch will retry the one-time reset.
        console.warn("Could not prepare the new book library:", error);
      })
      .finally(() => setReady(true));
  }, []);

  if (!ready) {
    return <div className="flex min-h-screen items-center justify-center bg-neutral-950 text-sm text-neutral-400">Preparing your new library…</div>;
  }
  return <>{props.children}</>;
}

export default function AppProviders(props: { children: ReactNode }) {
  return (
    <SettingsProvider>
      <ServiceWorkerRegistrar />
      <BookParserResetGate>{props.children}</BookParserResetGate>
    </SettingsProvider>
  );
}
