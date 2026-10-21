'use client';

import { useEffect, useState } from 'react';

type Mode = 'light' | 'dark' | 'system';
const COOKIE = 'elm_theme';

function apply(mode: Mode) {
  const el = document.documentElement;
  if (mode === 'system') delete el.dataset.theme;
  else el.dataset.theme = mode;
  document.cookie = `${COOKIE}=${mode}; path=/; max-age=31536000; samesite=lax`;
}

const ICONS: Record<Mode, React.ReactNode> = {
  light: <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><circle cx="10" cy="10" r="3.4" /><path d="M10 2.5v1.8M10 15.7v1.8M2.5 10h1.8M15.7 10h1.8M4.7 4.7l1.3 1.3M14 14l1.3 1.3M4.7 15.3L6 14M14 6l1.3-1.3" /></svg>,
  dark: <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"><path d="M16.5 12.3A6.8 6.8 0 0 1 7.7 3.5a6.8 6.8 0 1 0 8.8 8.8z" /></svg>,
  system: <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="2.8" y="3.8" width="14.4" height="9.8" rx="1.6" /><path d="M7 16.5h6" /></svg>,
};
const LABEL: Record<Mode, string> = { light: 'Light', dark: 'Dark', system: 'Match my device' };

/** Light / dark / match device. Remembered in a cookie so the page opens in the right colours. */
export function ThemeSwitch({ initial, full }: { initial: Mode; full?: boolean }) {
  const [mode, setMode] = useState<Mode>(initial);
  useEffect(() => apply(mode), [mode]);
  return (
    <div className={`ep-theme${full ? ' ep-theme--full' : ''}`} role="radiogroup" aria-label="Appearance">
      {(['light', 'dark', 'system'] as Mode[]).map((m) => (
        <button key={m} type="button" role="radio" aria-checked={mode === m} title={LABEL[m]} className={mode === m ? 'is-on' : ''} onClick={() => setMode(m)}>
          {ICONS[m]}
          {full && <span>{LABEL[m]}</span>}
        </button>
      ))}
    </div>
  );
}
