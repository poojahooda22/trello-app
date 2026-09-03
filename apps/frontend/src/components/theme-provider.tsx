/**
 * Light/dark theme, ported from the perplexity-webapp implementation.
 *
 * The `.dark` class on <html> is the switch; `@custom-variant dark` in
 * globals.css is what makes Tailwind's `dark:` utilities and the `.dark {}`
 * palette respond to it. That palette already existed here — nothing was ever
 * adding the class.
 *
 * The initial value is read from the DOM rather than recomputed, because the
 * inline script in index.html has already decided it before first paint. Two
 * copies of that logic would be two things to keep in sync.
 *
 * Some pages are light-only: sign-in, sign-up and the invitation page sit in
 * front of the login, where the toggle does not exist, and were designed on
 * the light palette. They hold a lock while mounted; the preference itself is
 * untouched, so the boards come up dark again afterwards.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

export type Theme = "dark" | "light";

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  /** Holds the document on the light palette while the calling page is mounted. */
  lockLight: () => () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = "theme";

function getInitialTheme(): Theme {
  if (typeof document === "undefined") return "light";
  // The preference, not the class: on a light-only page the script leaves the
  // class off while still recording what the person chose.
  return document.documentElement.dataset.themePreference === "dark" ? "dark" : "light";
}

function hasExplicitChoice() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark";
  } catch {
    return false;
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(getInitialTheme);
  // How many light-only pages are mounted. A count rather than a flag, so two
  // overlapping mounts (StrictMode, a route transition) cannot unlock early.
  const [lightOnly, setLightOnly] = useState(0);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark" && lightOnly === 0);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* private mode; the theme still works for this session */
    }
  }, [theme, lightOnly]);

  // Until someone picks a theme explicitly, follow the operating system — so a
  // visitor who switches their machine to dark at sunset sees the app follow.
  // Once they have chosen here, their choice wins and this stops applying.
  useEffect(() => {
    if (hasExplicitChoice()) return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setThemeState(e.matches ? "dark" : "light");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const setTheme = useCallback((next: Theme) => setThemeState(next), []);
  const toggleTheme = useCallback(() => setThemeState((prev) => (prev === "dark" ? "light" : "dark")), []);

  const lockLight = useCallback(() => {
    setLightOnly((n) => n + 1);
    return () => setLightOnly((n) => n - 1);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, setTheme, toggleTheme, lockLight }),
    [theme, setTheme, toggleTheme, lockLight],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}

/** For pages in front of the login: light palette while mounted, whatever the preference. */
export function useLightOnly(): void {
  const { lockLight } = useTheme();
  useEffect(() => lockLight(), [lockLight]);
}
