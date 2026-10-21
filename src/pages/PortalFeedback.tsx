import { useState } from 'react';
import clsx from 'clsx';
import { Bug, Lightbulb, Star } from 'lucide-react';
import { useApp, useAsync } from '../app/context';
import { repo } from '../data';
import { PageHeader } from '../components/Layout';
import { Button, Card, EmptyState, ErrorBox, Loading, Pill, inputBase, textareaCls, useToast } from '../components/ui';
import { Select } from '../components/Select';
import { fmtDate, fmtDateTime } from '../lib/metrics';
import { KIND_LABEL, STAGES, stageOf } from '../lib/feedbackStages';
import type { PortalFeedbackItem, PortalFeedbackStatus } from '../lib/types';

type View = PortalFeedbackStatus | 'open' | 'all';

/** Super Admin: tracker for everything sent with the Feedback button — what's new, in the pipeline, being fixed and fixed. */
export default function PortalFeedbackPage() {
  const rows = useAsync(() => repo.listFeedback(), []);
  const [view, setView] = useState<View>('open');
  const [kind, setKind] = useState<'' | 'bug' | 'idea'>('');
  const all = rows.data ?? [];
  const count = (s: PortalFeedbackStatus) => all.filter((r) => r.status === s).length;
  const list = all.filter((r) => (kind ? r.kind === kind : true))
    .filter((r) => view === 'all' || (view === 'open' ? !['fixed', 'declined'].includes(r.status) : r.status === view));
  const sorted = view === 'fixed' || view === 'declined'
    ? [...list].sort((a, b) => (b.resolved_at ?? '').localeCompare(a.resolved_at ?? ''))
    : [...list].sort((a, b) => STAGES.findIndex((s) => s.value === a.status) - STAGES.findIndex((s) => s.value === b.status) || b.created_at.localeCompare(a.created_at));
  const rated = all.filter((r) => r.rating);
  const avg = rated.length ? rated.reduce((a, r) => a + (r.rating ?? 0), 0) / rated.length : null;
  const tabs: { value: View; label: string; n: number }[] = [
    { value: 'open', label: 'Open', n: all.filter((r) => !['fixed', 'declined'].includes(r.status)).length },
    ...STAGES.map((s) => ({ value: s.value as View, label: s.label, n: count(s.value) })),
    { value: 'all', label: 'All', n: all.length },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Portal Feedback" subtitle="Problems and ideas sent with the Feedback button. Move each one along as it's planned, worked on and fixed — the sender sees its stage and your note."
        actions={<Select aria-label="Type" className={inputBase + ' w-auto'} value={kind} onChange={(e) => setKind(e.target.value as '' | 'bug' | 'idea')}>
          <option value="">All types</option><option value="bug">Something isn’t working</option><option value="idea">Idea or suggestion</option></Select>} />
      <ErrorBox error={rows.error} />
      {rows.loading ? <Loading /> : (<>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {STAGES.slice(0, 4).map((s) => (
            <button key={s.value} onClick={() => setView(s.value)} className={clsx('rounded-xl border bg-surface px-4 py-3 text-left shadow-sm transition-colors hover:bg-sunken/40', view === s.value ? 'border-brand ring-1 ring-brand' : 'border-line')}>
              <div className="text-[12.5px] font-medium text-muted">{s.label}</div>
              <div className="mt-1.5 text-[26px] font-semibold leading-none tracking-tight tnum">{count(s.value)}</div>
              <div className="mt-1.5 text-[12px] text-muted">{s.hint}</div>
            </button>
          ))}
          <div className="rounded-xl border border-line bg-surface px-4 py-3 shadow-sm">
            <div className="text-[12.5px] font-medium text-muted">Average rating</div>
            <div className="mt-1.5 text-[26px] font-semibold leading-none tracking-tight tnum">{avg === null ? '—' : avg.toFixed(1)}</div>
            <div className="mt-1.5 text-[12px] text-muted">{rated.length} rating(s) out of 5</div>
          </div>
        </div>
        <div role="tablist" className="inline-flex max-w-full gap-1 self-start overflow-x-auto rounded-lg bg-sunken p-[3px]">
          {tabs.map((t) => (
            <button key={t.value} role="tab" aria-selected={view === t.value} onClick={() => setView(t.value)}
              className={clsx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium transition-all', view === t.value ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink')}>
              {t.label}<span className="rounded bg-sunken px-1.5 text-[11.5px] tnum text-muted">{t.n}</span></button>
          ))}
        </div>
        {sorted.length === 0 ? <EmptyState title={all.length ? 'Nothing here' : 'No feedback yet'} body={all.length ? 'Try another stage.' : 'Feedback people send with the Feedback button shows up here.'} />
          : <div className="flex flex-col gap-3">{sorted.map((r) => <Item key={r.id} r={r} />)}</div>}
      </>)}
    </div>
  );
}

function Item({ r }: { r: PortalFeedbackItem }) {
  const { bump } = useApp();
  const toast = useToast();
  const [note, setNote] = useState(r.admin_note ?? '');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const st = stageOf(r.status);
  const save = async (status: PortalFeedbackStatus, withNote?: string) => {
    setBusy(true);
    try { await repo.setFeedbackStatus(r.id, status, withNote); toast(`Moved to ${stageOf(status).label}.`); setEditing(false); bump(); }
    catch (e) { toast(e instanceof Error ? e.message : String(e), 'bad'); } finally { setBusy(false); }
  };
  const Icon = r.kind === 'bug' ? Bug : Lightbulb;
  return (
    <Card>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
            <span className={clsx('inline-flex items-center gap-1 font-medium', r.kind === 'bug' ? 'text-bad' : 'text-info')}><Icon className="h-3.5 w-3.5" aria-hidden />{KIND_LABEL[r.kind] ?? r.kind}</span>
            <span>·</span><span>{r.sender_name ?? 'Unknown'}{r.sender_email ? ` (${r.sender_email})` : ''}</span>
            <span>·</span><span>{fmtDateTime(r.created_at)}</span>
            {r.rating ? <><span>·</span><span className="inline-flex items-center gap-0.5">{r.rating}<Star className="h-3 w-3 fill-amber-400 text-amber-400" /></span></> : null}
          </div>
          <p className="mt-1.5 whitespace-pre-wrap text-[14px]">{r.message}</p>
          {r.page && <p className="mt-1 text-[12px] text-muted">Page: {r.page}</p>}
          {editing ? (
            <div className="mt-3 flex flex-col gap-2">
              <textarea rows={2} className={textareaCls} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} placeholder="Note for the sender, e.g. what was fixed or why it won't be done" />
              <div className="flex gap-2"><Button size="sm" loading={busy} onClick={() => save(r.status, note)}>Save note</Button><Button size="sm" variant="ghost" onClick={() => { setEditing(false); setNote(r.admin_note ?? ''); }}>Cancel</Button></div>
            </div>
          ) : r.admin_note ? (
            <p className="mt-3 rounded-md bg-sunken px-3 py-2 text-[13px]"><span className="font-medium">QA note:</span> {r.admin_note} <button className="ml-1 text-[12px] text-muted underline" onClick={() => setEditing(true)}>Edit</button></p>
          ) : <button className="mt-2 text-[12.5px] text-muted underline hover:text-ink" onClick={() => setEditing(true)}>Add a note for the sender</button>}
        </div>
        <div className="flex shrink-0 flex-col items-start gap-1.5 sm:items-end">
          <Pill tone={st.tone}>{st.label}</Pill>
          <Select aria-label="Stage" className="h-8 w-40 text-[12.5px]" value={r.status} disabled={busy} onChange={(e) => save(e.target.value as PortalFeedbackStatus)}>
            {STAGES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</Select>
          {r.resolved_at && (r.status === 'fixed' || r.status === 'declined') && <span className="text-[12px] text-muted">{r.status === 'fixed' ? 'Fixed' : 'Closed'} {fmtDate(r.resolved_at)}</span>}
          {r.status_changed_at && !r.resolved_at && <span className="text-[12px] text-muted">Updated {fmtDate(r.status_changed_at)}</span>}
        </div>
      </div>
    </Card>
  );
}
