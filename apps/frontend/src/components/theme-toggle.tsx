/**
 * Animated theme toggle, ported from perplexity-webapp (originally rare-lab):
 * a circular clip-path reveal expanding from the button's centre via the View
 * Transitions API.
 *
 * Falls back to an instant switch where the API is unavailable or the visitor
 * has asked for reduced motion. The paired ::view-transition rules live in
 * globals.css; without them the browser's default cross-fade muddies the wipe.
 */
import { Moon, Sun } from "lucide-react";
import { useCallback, useRef } from "react";
import { flushSync } from "react-dom";

import { useTheme } from "@/components/theme-provider";
import { cn } from "@/lib/utils";

export function ThemeToggle({ className, duration = 450 }: { className?: string; duration?: number }) {
  const { theme, setTheme } = useTheme();
  const isDark = theme === "dark";
  const ref = useRef<HTMLButtonElement>(null);
  const label = isDark ? "Switch to light theme" : "Switch to dark theme";

  const toggle = useCallback(() => {
    const next = isDark ? "light" : "dark";

    // Synchronous, so the View Transition snapshots the *new* theme rather
    // than a frame that is still half old.
    const apply = () => {
      flushSync(() => {
        document.documentElement.classList.toggle("dark", next === "dark");
        setTheme(next);
      });
    };

    const doc = document as Document & {
      startViewTransition?: (cb: () => void) => { ready: Promise<void> };
    };
    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (prefersReduced || typeof doc.startViewTransition !== "function" || !ref.current) {
      apply();
      return;
    }

    const { top, left, width, height } = ref.current.getBoundingClientRect();
    const x = left + width / 2;
    const y = top + height / 2;
    // Reach the furthest corner, so the circle covers the viewport.
    const maxRadius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));

    const transition = doc.startViewTransition(apply);
    transition.ready.then(() => {
      document.documentElement.animate(
        {
          clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${maxRadius}px at ${x}px ${y}px)`],
        },
        { duration, easing: "ease-in-out", pseudoElement: "::view-transition-new(root)" },
      );
    });
  }, [isDark, setTheme, duration]);

  return (
    <button
      ref={ref}
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      className={cn(
        "text-text-subtle hover:bg-surface-hover hover:text-text-strong inline-flex size-8 shrink-0 items-center justify-center rounded-md transition-colors",
        "focus-visible:ring-ring/50 outline-none focus-visible:ring-[3px]",
        className,
      )}
    >
      {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}
