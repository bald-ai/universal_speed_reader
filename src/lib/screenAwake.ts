import { Capacitor, registerPlugin } from "@capacitor/core";

type SetKeepScreenOnOptions = {
  enabled: boolean;
};

type ScreenControlPlugin = {
  setKeepScreenOn(options: SetKeepScreenOnOptions): Promise<void>;
};

type WakeLockSentinelLike = {
  released: boolean;
  release: () => Promise<void>;
  addEventListener?: (type: "release", listener: () => void) => void;
};

type NavigatorWithWakeLock = Navigator & {
  wakeLock?: {
    request: (type: "screen") => Promise<WakeLockSentinelLike>;
  };
};

export const ScreenControl = registerPlugin<ScreenControlPlugin>("ScreenControl");
let nativeKeepAwakeUsers = 0;
let nativeToggleQueue: Promise<void> = Promise.resolve();

function isNativeAndroid(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

async function setNativeKeepScreenOn(enabled: boolean): Promise<void> {
  if (!isNativeAndroid()) return;
  try {
    await ScreenControl.setKeepScreenOn({ enabled });
  } catch (error) {
    console.warn("Failed to toggle native keep-screen-on:", error);
  }
}

function getWakeLockApi(): NavigatorWithWakeLock["wakeLock"] | null {
  if (typeof navigator === "undefined") return null;
  const nav = navigator as NavigatorWithWakeLock;
  return nav.wakeLock ?? null;
}

function queueNativeKeepScreenOn(enabled: boolean): void {
  nativeToggleQueue = nativeToggleQueue
    .then(() => setNativeKeepScreenOn(enabled))
    .catch(() => undefined);
}

function retainNativeKeepAwake(): () => void {
  nativeKeepAwakeUsers += 1;
  if (nativeKeepAwakeUsers === 1) {
    queueNativeKeepScreenOn(true);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    nativeKeepAwakeUsers = Math.max(0, nativeKeepAwakeUsers - 1);
    if (nativeKeepAwakeUsers === 0) {
      queueNativeKeepScreenOn(false);
    }
  };
}

export function startSpeedModeKeepAwake(): () => void {
  const nativeAndroid = isNativeAndroid();
  const releaseNativeKeepAwake = nativeAndroid ? retainNativeKeepAwake() : null;
  let isDisposed = false;
  let wakeLock: WakeLockSentinelLike | null = null;
  let detachVisibilityListener: (() => void) | null = null;
  let acquireInFlight = false;
  let acquireRetryRequested = false;
  let acquireGeneration = 0;

  const releaseWebWakeLock = async (): Promise<void> => {
    const activeWakeLock = wakeLock;
    wakeLock = null;
    if (!activeWakeLock) return;

    try {
      if (!activeWakeLock.released) {
        await activeWakeLock.release();
      }
    } catch {
      // best effort
    }
  };

  const requestAcquireWebWakeLock = (): void => {
    if (isDisposed || nativeAndroid) return;
    if (acquireInFlight) {
      acquireRetryRequested = true;
      return;
    }
    void acquireWebWakeLock();
  };

  const acquireWebWakeLock = async (): Promise<void> => {
    if (isDisposed || nativeAndroid) return;

    if (typeof document !== "undefined" && document.visibilityState !== "visible") {
      return;
    }

    if (wakeLock && !wakeLock.released) {
      return;
    }

    const wakeLockApi = getWakeLockApi();
    if (!wakeLockApi) return;

    acquireInFlight = true;
    const generation = ++acquireGeneration;
    try {
      const requestedWakeLock = await wakeLockApi.request("screen");

      if (isDisposed || generation !== acquireGeneration) {
        try {
          if (!requestedWakeLock.released) {
            await requestedWakeLock.release();
          }
        } catch {
          // best effort
        }
        return;
      }

      const previousWakeLock = wakeLock;
      wakeLock = requestedWakeLock;

      if (previousWakeLock && previousWakeLock !== requestedWakeLock) {
        try {
          if (!previousWakeLock.released) {
            await previousWakeLock.release();
          }
        } catch {
          // best effort
        }
      }

      requestedWakeLock.addEventListener?.("release", () => {
        if (isDisposed) return;
        if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
        requestAcquireWebWakeLock();
      });
    } catch {
      // best effort
    } finally {
      acquireInFlight = false;
      if (acquireRetryRequested) {
        acquireRetryRequested = false;
        requestAcquireWebWakeLock();
      }
    }
  };

  if (!nativeAndroid) {
    requestAcquireWebWakeLock();

    if (typeof document !== "undefined") {
      const onVisibilityChange = () => {
        if (isDisposed) return;

        if (document.visibilityState === "visible") {
          if (!wakeLock || wakeLock.released) {
            requestAcquireWebWakeLock();
          }
          return;
        }

        void releaseWebWakeLock();
      };

      document.addEventListener("visibilitychange", onVisibilityChange);
      detachVisibilityListener = () => {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      };
    }
  }

  return () => {
    isDisposed = true;
    detachVisibilityListener?.();
    detachVisibilityListener = null;

    if (nativeAndroid) {
      releaseNativeKeepAwake?.();
    } else {
      void releaseWebWakeLock();
    }
  };
}
