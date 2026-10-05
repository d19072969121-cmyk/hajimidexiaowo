import { useLayoutEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '@/styles/motion-springs';

export type MotionPresenceState = {
  /** Keep the node in the tree (including the close animation). */
  mounted: boolean;
  /**
   * Transition end-state. For `enter: 'transition'`, this flips true one/two
   * frames after mount so CSS transitions have a from-state.
   */
  shown: boolean;
  /** True while the close animation is playing. */
  exiting: boolean;
};

/**
 * Fallback budget for the transition enter handoff. The single rAF is the
 * normal path; this timer only exists so `shown` can never be stranded at
 * `false` when the browser throttles or drops animation frames (background
 * tab, heavy first paint, reduced refresh rate).
 */
const ENTER_FRAME_FALLBACK_MS = 48;

export function readCssDurationMs(varName: string, fallback: number): number {
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') {
    return fallback;
  }
  const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  if (!raw) return fallback;
  const value = parseFloat(raw);
  if (Number.isNaN(value)) return fallback;
  if (raw.endsWith('s') && !raw.endsWith('ms')) return value * 1000;
  return value;
}

/**
 * Keep a surface mounted through its close animation, and (for CSS
 * *transitions*) delay the open class by one frame so enter is not skipped.
 *
 * CSS *animations* (`ui-*-in`) play on mount; pass `enter: 'animation'`
 * and swap to the `*-out` class while `exiting`.
 *
 * Open/close flags commit in `useLayoutEffect` so children can measure and
 * take focus in the same act()/frame as `open` flipping true.
 *
 * Enter handoff contract: while `open` stays true, `shown` converges to true
 * on its own. The from-state needs exactly one committed paint, so a single
 * `requestAnimationFrame` is enough; a short timer arm backs that frame up, so
 * a dropped/throttled frame can never leave a surface permanently hidden
 * (which previously showed up as the mobile header flickering away). The
 * from-state is never painted on the opening pass: the false state is set in
 * the layout effect, so the follow-up frame always follows a committed paint.
 */
export function useMotionPresence(
  open: boolean,
  options?: {
    exitMs?: number;
    enter?: 'animation' | 'transition';
  },
): MotionPresenceState {
  const enter = options?.enter ?? 'animation';
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(enter === 'animation' ? open : false);
  const [exiting, setExiting] = useState(false);
  const mountedRef = useRef(open);

  mountedRef.current = mounted;

  useLayoutEffect(() => {
    let frame = 0;
    let enterTimer: ReturnType<typeof setTimeout> | undefined;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    const reduced = prefersReducedMotion();
    const exitMs = reduced ? 0 : (options?.exitMs ?? 150);

    const reveal = () => {
      setShown(true);
    };

    if (open) {
      setMounted(true);
      setExiting(false);
      if (reduced || enter === 'animation') {
        setShown(true);
      } else {
        setShown(false);
        frame = requestAnimationFrame(reveal);
        enterTimer = setTimeout(reveal, ENTER_FRAME_FALLBACK_MS);
      }
    } else if (mountedRef.current) {
      setShown(false);
      setExiting(true);
      if (exitMs <= 0) {
        setMounted(false);
        setExiting(false);
      } else {
        exitTimer = setTimeout(() => {
          setMounted(false);
          setExiting(false);
        }, exitMs);
      }
    } else {
      setShown(false);
      setExiting(false);
      setMounted(false);
    }

    return () => {
      if (frame) cancelAnimationFrame(frame);
      if (enterTimer) clearTimeout(enterTimer);
      if (exitTimer) clearTimeout(exitTimer);
    };
  }, [open, enter, options?.exitMs]);

  return { mounted, shown, exiting };
}
