import { useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";

const LONG_PRESS_MS = 450;
const MOVE_CANCEL_PX = 10;

type UseLibraryLongPressOptions = {
  disabled?: boolean;
  onLongPress: () => void;
};

/**
 * Long-press (or right-click) to enter library multi-select.
 * Cancels if the pointer moves more than MOVE_CANCEL_PX.
 */
export function useLibraryLongPress(options: UseLibraryLongPressOptions) {
  const { disabled, onLongPress } = options;
  const timerRef = useRef<number>(0);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const firedRef = useRef(false);

  const clear = () => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = 0;
    }
    startRef.current = null;
  };

  return {
    onPointerDown: (event: ReactPointerEvent) => {
      if (disabled || event.button !== 0) return;
      firedRef.current = false;
      startRef.current = { x: event.clientX, y: event.clientY };
      clear();
      timerRef.current = window.setTimeout(() => {
        firedRef.current = true;
        startRef.current = null;
        timerRef.current = 0;
        onLongPress();
      }, LONG_PRESS_MS);
    },
    onPointerMove: (event: ReactPointerEvent) => {
      if (!startRef.current || timerRef.current === 0) return;
      const dx = event.clientX - startRef.current.x;
      const dy = event.clientY - startRef.current.y;
      if (dx * dx + dy * dy > MOVE_CANCEL_PX * MOVE_CANCEL_PX) {
        clear();
      }
    },
    onPointerUp: () => {
      clear();
    },
    onPointerCancel: () => {
      clear();
    },
    onContextMenu: (event: ReactMouseEvent) => {
      if (disabled) return;
      event.preventDefault();
      event.stopPropagation();
      onLongPress();
    },
    didLongPress: () => firedRef.current,
  };
}
