'use client';

import { useEffect, useRef, useState } from 'react';

/** Big phone photos are resized in the browser before upload: faster, and they fit the upload limit. */
async function shrink(f: File, maxSide = 1800): Promise<File> {
  if (!/^image\/(jpeg|png|webp)$/.test(f.type) || f.size < 700_000) return f;
  try {
    const bmp = await createImageBitmap(f);
    const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s);
    c.height = Math.round(bmp.height * s);
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    const keepAlpha = f.type === 'image/png';
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, keepAlpha ? 'image/webp' : 'image/jpeg', 0.86));
    if (!blob || blob.size >= f.size || (keepAlpha && blob.type !== 'image/webp')) return f;
    return new File([blob], f.name.replace(/\.\w+$/, '') + (blob.type === 'image/webp' ? '.webp' : '.jpg'), { type: blob.type });
  } catch {
    return f;
  }
}

const setFiles = (input: HTMLInputElement | null, files: File[]) => {
  if (!input) return;
  const dt = new DataTransfer();
  files.forEach((f) => dt.items.add(f));
  input.files = dt.files;
};

const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** One image (product photo, logo): drop or choose, see it at once, sent with the form. */
export function ImagePick({ name, current, label, hint, round = false, size = 116 }: { name: string; current?: string | null; label: string; hint?: string; round?: boolean; size?: number }) {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(current ?? null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => () => { if (preview?.startsWith('blob:')) URL.revokeObjectURL(preview); }, [preview]);
  const take = async (f: File | undefined) => {
    setErr('');
    if (!f) return;
    if (!/^image\//.test(f.type)) { setErr('Choose an image (JPG, PNG or WEBP).'); return; }
    setBusy(true);
    const s = await shrink(f);
    setBusy(false);
    setFiles(input.current, [s]);
    setPreview(URL.createObjectURL(s));
  };
  return (
    <div className="ep-ipick">
      <span className="ep-ipick-label">{label}</span>
      <div
        className={`ep-ipick-zone${over ? ' is-over' : ''}${round ? ' is-round' : ''}${preview ? ' has-img' : ''}`}
        style={{ width: size, height: size }}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files[0]); }}
        onClick={() => input.current?.click()}
        role="button"
        tabIndex={0}
        aria-label={`${preview ? 'Change' : 'Add'} ${label.toLowerCase()}`}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current?.click(); } }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- local preview */}
        {preview ? <img src={preview} alt="" /> : <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3" /><circle cx="9" cy="10.5" r="1.8" /><path d="M21 16l-5-5-8 8" /></svg>}
        <em>{busy ? 'Preparing…' : preview ? 'Change' : 'Add'}</em>
      </div>
      <input ref={input} type="file" name={name} accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => take(e.target.files?.[0])} />
      {err ? <small className="ep-ipick-err">{err}</small> : hint && <small>{hint}</small>}
    </div>
  );
}

const MAX_TOTAL = 4 * 1024 * 1024;

/** Several attachments (photos of damaged goods, PDFs): chips with previews, removable, images resized first. */
export function FilesPick({ name, max = 4, hint, what = 'Drop photos or PDFs here, or' }: { name: string; max?: number; hint?: string; what?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [files, setList] = useState<{ f: File; url: string | null }[]>([]);
  const [over, setOver] = useState(false);
  const [err, setErr] = useState('');
  const sync = (next: { f: File; url: string | null }[]) => { setList(next); setFiles(input.current, next.map((x) => x.f)); };
  const add = async (list: FileList | null) => {
    setErr('');
    if (!list?.length) return;
    const ok = [...list].filter((f) => /^image\/|^application\/pdf$/.test(f.type));
    if (ok.length < list.length) setErr('Only photos and PDF files can be attached.');
    const next = [...files];
    for (const f of ok) {
      if (next.length >= max) { setErr(max === 1 ? 'One file only: remove it first to choose another.' : `Up to ${max} files per message.`); break; }
      const s = await shrink(f);
      next.push({ f: s, url: s.type.startsWith('image/') && s.type !== 'image/heic' ? URL.createObjectURL(s) : null });
    }
    const total = next.reduce((a, x) => a + x.f.size, 0);
    if (total > MAX_TOTAL) { setErr(`Attachments add up to ${kb(total)}; the limit is 4 MB per message. Remove one or send it in a second message.`); return; }
    sync(next);
  };
  return (
    <div className="ep-fpick">
      <div
        className={`ep-fpick-zone${over ? ' is-over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); add(e.dataTransfer.files); }}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" /></svg>
        <span>{what} <button type="button" className="ep-link" onClick={() => picker.current?.click()}>choose files</button></span>
        <small>{hint ?? `Up to ${max} files · 4 MB in total · photos are resized automatically`}</small>
      </div>
      <input ref={picker} type="file" multiple accept="image/jpeg,image/png,image/webp,image/heic,application/pdf" hidden onChange={(e) => { add(e.target.files); e.target.value = ''; }} />
      <input ref={input} type="file" name={name} multiple hidden />
      {files.length > 0 && (
        <ul className="ep-fpick-list">
          {files.map((x, i) => (
            <li key={i}>
              {/* eslint-disable-next-line @next/next/no-img-element -- local preview */}
              {x.url ? <img src={x.url} alt="" /> : <span className="ep-fpick-doc">{x.f.type === 'application/pdf' ? 'PDF' : 'IMG'}</span>}
              <span><b>{x.f.name}</b><small>{kb(x.f.size)}</small></span>
              <button type="button" aria-label={`Remove ${x.f.name}`} onClick={() => { if (x.url) URL.revokeObjectURL(x.url); sync(files.filter((_, j) => j !== i)); }}>×</button>
            </li>
          ))}
        </ul>
      )}
      {err && <small className="ep-ipick-err">{err}</small>}
    </div>
  );
}
