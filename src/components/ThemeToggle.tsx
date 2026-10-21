import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Check, Monitor, Moon, Sun } from 'lucide-react';

type Theme = 'light' | 'dark' | 'system';
const KEY = 'csqa-theme';
const read = (): Theme => { try { const t = localStorage.getItem(KEY); return t === 'light' || t === 'dark' ? t : 'system'; } catch { return 'system'; } };
const apply = (t: Theme) => {
  if (t === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  try { if (t === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, t); } catch { /* private mode: not remembered */ }
};
const OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun }, { value: 'dark', label: 'Dark', icon: Moon }, { value: 'system', label: 'System', icon: Monitor },
];

/** Light / dark / follow the computer's setting; remembered in this browser. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(read);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => apply(theme), [theme]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-label="Theme" aria-haspopup="menu" aria-expanded={open}
        className="relative rounded-md p-2 text-muted hover:bg-sunken hover:text-ink">
        <Sun className="h-5 w-5 transition-all dark-hide" aria-hidden />
        <Moon className="absolute left-2 top-2 h-5 w-5 transition-all dark-show" aria-hidden />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-11 z-40 w-36 rounded-lg border border-line bg-surface p-1 shadow-lg animate-in">
          {OPTIONS.map((o) => (
            <button key={o.value} role="menuitemradio" aria-checked={theme === o.value} onClick={() => { setTheme(o.value); setOpen(false); }}
              className={clsx('flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-sunken', theme === o.value && 'font-medium')}>
              <o.icon className="h-4 w-4 text-muted" aria-hidden />{o.label}
              {theme === o.value && <Check className="ml-auto h-4 w-4" aria-hidden />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
