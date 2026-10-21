import { Children, Fragment, isValidElement, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { Check, ChevronDown, Search } from 'lucide-react';

/**
 * Drop-in replacement for <select>: same <option>/<optgroup> children, value and onChange(e.target.value),
 * shown as a searchable list (shadcn-style). `people` adds a name avatar to each option.
 */
type Opt = { value: string; label: string; disabled?: boolean; group?: string };
type Props = {
  id?: string; value?: string | number; onChange?: (e: ChangeEvent<HTMLSelectElement>) => void; disabled?: boolean;
  className?: string; children?: ReactNode; people?: boolean; 'aria-label'?: string; placeholder?: string;
};

const textOf = (n: ReactNode): string => {
  if (n == null || typeof n === 'boolean') return '';
  if (typeof n === 'string' || typeof n === 'number') return String(n);
  if (Array.isArray(n)) return n.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(n)) return textOf(n.props.children);
  return '';
};
function collect(children: ReactNode, group?: string, out: Opt[] = []): Opt[] {
  Children.forEach(children, (ch) => {
    if (!isValidElement<{ children?: ReactNode; value?: string | number; disabled?: boolean; label?: string }>(ch)) return;
    if (ch.type === 'option') {
      const label = textOf(ch.props.children);
      out.push({ value: String(ch.props.value ?? label), label, disabled: ch.props.disabled, group });
    } else if (ch.type === 'optgroup') collect(ch.props.children, ch.props.label, out);
    else if (ch.type === Fragment) collect(ch.props.children, group, out);
  });
  return out;
}

const HUES = [210, 160, 25, 280, 340, 190, 45, 120, 250, 0];
export function Avatar({ name, size = 24 }: { name: string; size?: number }) {
  const clean = name.replace(/\(.*?\)|·.*$/g, '').trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  const initials = ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
  let h = 0; for (const c of clean) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hue = HUES[h % HUES.length];
  return (
    <span aria-hidden className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold"
      style={{ width: size, height: size, fontSize: size * 0.4, background: `hsl(${hue} 70% 92%)`, color: `hsl(${hue} 55% 32%)` }}>{initials}</span>
  );
}

export function Select({ id, value, onChange, disabled, className, children, people, placeholder, ...rest }: Props) {
  const opts = useMemo(() => collect(children), [children]);
  const cur = String(value ?? '');
  const selected = opts.find((o) => o.value === cur) ?? (cur === '' ? undefined : undefined);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; up: boolean; max: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const searchable = opts.length > 7;
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? opts.filter((o) => o.label.toLowerCase().includes(s) || (o.group ?? '').toLowerCase().includes(s)) : opts;
  }, [opts, q]);

  // keep only the width-related classes the caller passed (the look comes from here)
  const sizing = (className ?? '').split(/\s+/).filter((c) => /^(w-|max-w-|min-w-|mt-|mb-|ml-|flex-|self-|shrink|grow)/.test(c));
  const small = /\bh-8\b|text-\[1[23]/.test(className ?? '');
  if (!sizing.some((c) => c.startsWith('w-'))) sizing.push('w-full');

  const place = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom, above = r.top;
    const need = Math.min(340, opts.length * (people ? 44 : 34) + (searchable ? 52 : 0) + 12);
    const up = below < need && above > below;
    setPos({ top: up ? r.top - 4 : r.bottom + 4, left: Math.min(r.left, window.innerWidth - Math.max(r.width, 240) - 8), width: Math.max(r.width, 240), up, max: Math.min(340, (up ? above : below) - 16) });
  };
  useLayoutEffect(() => { if (open) place(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!pop.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false); };
    const re = () => place();
    document.addEventListener('mousedown', close);
    window.addEventListener('resize', re); window.addEventListener('scroll', re, true);
    setQ(''); setActive(Math.max(0, opts.findIndex((o) => o.value === cur)));
    setTimeout(() => (searchable ? search.current : list.current)?.focus(), 0);
    return () => { document.removeEventListener('mousedown', close); window.removeEventListener('resize', re); window.removeEventListener('scroll', re, true); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active, open]);

  const pick = (o: Opt) => {
    if (o.disabled) return;
    setOpen(false);
    btn.current?.focus();
    if (o.value !== cur) onChange?.({ target: { value: o.value }, currentTarget: { value: o.value } } as unknown as ChangeEvent<HTMLSelectElement>);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(shown.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (shown[active]) pick(shown[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); btn.current?.focus(); }
    else if (e.key === 'Tab') setOpen(false);
  };
  const showAvatar = (o?: Opt) => people && o && o.value !== '';
  const label = selected?.label ?? placeholder ?? opts[0]?.label ?? '';

  let lastGroup: string | undefined;
  return (
    <>
      <button ref={btn} id={id} type="button" role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-label={rest['aria-label']} disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setOpen(true); } }}
        className={clsx('inline-flex items-center justify-between gap-2 rounded-md border border-line bg-surface text-left text-ink shadow-xs transition-[color,box-shadow] hover:bg-sunken/50',
          'focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50',
          small ? 'h-8 px-2.5 text-[12.5px]' : 'h-9 px-3 text-sm', open && 'border-ring ring-[3px] ring-ring/30', sizing)}>
        <span className="flex min-w-0 items-center gap-2">
          {showAvatar(selected) && <Avatar name={selected!.label} size={small ? 18 : 20} />}
          <span className={clsx('truncate', !selected && 'text-muted')}>{label}</span>
        </span>
        <ChevronDown className={clsx('h-4 w-4 shrink-0 text-muted transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && pos && createPortal(
        <div ref={pop} onKeyDown={onKey} className="fixed z-[80] flex flex-col overflow-hidden rounded-lg border border-line bg-surface text-ink shadow-lg animate-in"
          style={{ left: pos.left, width: pos.width, ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }) }}>
          {searchable && (
            <div className="p-2">
              <div className="flex h-9 items-center gap-2 rounded-full bg-sunken px-3.5">
                <input ref={search} value={q} onChange={(e) => { setQ(e.target.value); setActive(0); }} placeholder="Search"
                  aria-label="Search options" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted" />
                <Search className="h-4 w-4 shrink-0 text-ink" aria-hidden />
              </div>
            </div>
          )}
          <ul ref={list} role="listbox" tabIndex={-1} aria-labelledby={id} className="overflow-y-auto p-1 outline-none" style={{ maxHeight: pos.max }}>
            {shown.length === 0 && <li className="px-3 py-6 text-center text-[13px] text-muted">No matches</li>}
            {shown.map((o, i) => {
              const head = o.group && o.group !== lastGroup ? o.group : null;
              lastGroup = o.group;
              return (
                <Fragment key={o.value + i}>
                  {head && <li role="presentation" className="px-2.5 pb-1 pt-2 text-[11.5px] font-medium text-muted">{head}</li>}
                  <li role="option" aria-selected={o.value === cur} aria-disabled={o.disabled} data-i={i}
                    onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(o)}
                    className={clsx('flex cursor-pointer select-none items-center gap-2.5 rounded-md px-2.5 text-sm',
                      people ? 'py-2' : 'py-1.5', i === active && 'bg-sunken', o.disabled && 'cursor-not-allowed opacity-50')}>
                    {showAvatar(o) && <Avatar name={o.label} size={28} />}
                    <span className="min-w-0 flex-1 truncate">{o.label}</span>
                    {o.value === cur && <Check className="h-4 w-4 shrink-0" aria-hidden />}
                  </li>
                </Fragment>
              );
            })}
          </ul>
        </div>, document.body)}
    </>
  );
}
