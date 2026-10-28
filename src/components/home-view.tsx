'use client';

import { useEffect, useOptimistic, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { setHomeView } from '@/app/(app)/home-actions';

const done = () => { delete document.documentElement.dataset.homeSwitching; };

/** Full view / Quick view. The pill moves at once; the page fades over to the other view when it's ready. */
export function ViewSwitch({ view }: { view: 'quick' | 'full' }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [shown, setShown] = useOptimistic(view);
  const pick = (v: 'quick' | 'full') => {
    if (v === shown || pending) return;
    start(async () => {
      setShown(v);
      document.documentElement.dataset.homeSwitching = '1';
      window.dispatchEvent(new Event('elm:busy'));
      const r = await setHomeView(v).catch(() => ({ ok: false }));
      if (r.ok) router.refresh();
      // Never leave the page faded: if the new view hasn't cleared it shortly after, clear it here.
      window.setTimeout(done, r.ok ? 1500 : 0);
    });
  };
  return (
    <div className={`ds-switch${pending ? ' is-busy' : ''}`} role="radiogroup" aria-label="Overview layout" data-on={shown}>
      <i className="ds-switch-thumb" aria-hidden="true" />
      <button type="button" role="radio" aria-checked={shown === 'full'} onClick={() => pick('full')}>Full view</button>
      <button type="button" role="radio" aria-checked={shown === 'quick'} onClick={() => pick('quick')}>Quick view</button>
    </div>
  );
}

/** Removes the fade once the new view is on screen (runs again whenever the view changes). */
export function ViewReady({ view }: { view: 'quick' | 'full' }) {
  useEffect(() => { done(); }, [view]);
  return null;
}
