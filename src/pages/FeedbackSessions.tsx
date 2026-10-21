import { useEffect, useMemo, useState } from 'react';
import { CalendarCheck, ExternalLink, RefreshCw } from 'lucide-react';
import { useApp, useAsync, useRef_ } from '../app/context';
import { repo } from '../data';
import { PageHeader } from '../components/Layout';
import { Button, Card, ConfirmModal, Tabs, EmptyState, ErrorBox, Field, Kpi, Loading, Modal, Pill, Table, td, th, inputBase, inputCls, useToast } from '../components/ui';
import { fmtDate, fmtDateTime, isQaRole } from '../lib/metrics';
import type { FeedbackSession, FeedbackStatus } from '../lib/types';
import { Select } from '../components/Select';

const STATUS: Record<FeedbackStatus, { label: string; tone: 'neutral' | 'good' | 'warn' | 'bad' | 'info' }> = {
  not_booked: { label: 'Not booked', tone: 'warn' },
  booked: { label: 'Booked', tone: 'info' },
  completed: { label: 'Completed', tone: 'good' },
  cancelled: { label: 'Cancelled', tone: 'bad' },
  no_audit: { label: 'No audits this cycle', tone: 'neutral' },
};
const StatusPill = ({ s }: { s: FeedbackStatus }) => <Pill tone={STATUS[s].tone}>{STATUS[s].label}</Pill>;
const overdue = (f: FeedbackSession) => (f.status === 'not_booked' || f.status === 'cancelled') && !!f.book_by && f.book_by < new Date().toISOString().slice(0, 10);
/** Feedback sessions every 3 audit weeks: CAMs book with their QA provider (Team Lead joins). */
export default function FeedbackSessionsPage() {
  const { me } = useApp();
  const ref = useRef_();
  const qa = isQaRole(me!.role);
  const cycles = useAsync(() => repo.listFeedbackCycles(), []);
  const [cycleId, setCycleId] = useState('');
  const current = cycleId || cycles.data?.[0]?.id || '';
  const cycle = cycles.data?.find((c) => c.id === current);
  const sessions = useAsync(() => (current ? repo.listFeedbackSessions(current) : Promise.resolve([] as FeedbackSession[])), [current]);
  const [tab, setTab] = useState<'sessions' | 'responses'>('sessions');
  const weekNames = cycle ? cycle.period_ids.map((id) => ref.periods.find((p) => p.id === id)?.short_label ?? '?').join(', ') : '';
  const list = sessions.data ?? [];
  const mine = list.filter((s) => s.cam_id === me!.id);
  const others = list.filter((s) => s.cam_id !== me!.id);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Feedback Sessions"
        subtitle="Every 3 audit weeks each CAM books a feedback session with the QA team member who audited them most. Their Team Lead joins the session."
        actions={(cycles.data?.length ?? 0) > 0 && <div className="flex items-center gap-2">
          <label htmlFor="fb-cycle" className="text-[13px] text-muted">Cycle</label>
          <Select id="fb-cycle" className={inputBase + ' w-auto'} value={current} onChange={(e) => setCycleId(e.target.value)}>
            {cycles.data!.map((c) => <option key={c.id} value={c.id}>Session {c.number}{c.released_at ? '' : ' (not visible to CAMs yet)'}</option>)}
          </Select></div>} />
      <ErrorBox error={cycles.error ?? sessions.error} />
      {cycles.loading ? <Loading /> : !cycle ? (
        <EmptyState title="No feedback cycle yet" body={qa ? 'A cycle is created automatically when its last audit week is published, or start one below.' : 'Your next feedback session will show here once the audit weeks are published.'} />
      ) : (<>
        {qa && <Tabs value={tab} onChange={setTab} tabs={[{ value: 'sessions', label: 'Sessions' }, { value: 'responses', label: 'Form responses' }]} />}
        {tab === 'responses' && qa ? <ResponsesView /> : sessions.loading ? <Loading /> : (<>
          {mine.map((s) => <MySession key={s.id} s={s} weekNames={weekNames} />)}
          {qa ? <QaView cycle={cycle} weekNames={weekNames} list={list} />
            : others.length > 0 && <TeamView list={others} weekNames={weekNames} number={cycle.number} />}
          {!qa && mine.length === 0 && others.length === 0 && <EmptyState title={`Nothing to book for Session ${cycle.number}`} body="You had no audits in this cycle's weeks." />}
        </>)}
      </>)}
      {me!.role === 'super_admin' && <LinksCard />}
      {qa && <NewCycle nextNumber={(cycles.data?.[0]?.number ?? (ref.settings.feedback?.anchor_number ?? 22) - 1) + 1} />}
    </div>
  );
}

function MySession({ s, weekNames }: { s: FeedbackSession; weekNames: string }) {
  const ref = useRef_();
  const toast = useToast();
  const { bump } = useApp();
  const [editing, setEditing] = useState(s.status === 'not_booked' || s.status === 'cancelled');
  const [removing, setRemoving] = useState(false);
  useEffect(() => { if (s.status === 'cancelled') setEditing(true); }, [s.status]);
  const form = ref.settings.feedback?.form_url;
  return (
    <Card title={`Your feedback session · Session ${s.cycle_number}`} subtitle={`Audit weeks ${weekNames}`} actions={<StatusPill s={s.status} />}>
      {s.status === 'no_audit' ? <p className="text-[13.5px] text-muted">You had no audits in these weeks, so there is no session to book this cycle.</p> : (
        <div className="flex flex-col gap-4 text-[13.5px]">
          <div className="grid gap-3 sm:grid-cols-3">
            <div><div className="text-[12px] text-muted">Session with (QA)</div><div className="text-[15px] font-semibold">{s.provider_name ?? 'To be confirmed by QA'}</div></div>
            <div><div className="text-[12px] text-muted">Your Team Lead joins</div><div className="text-[15px] font-semibold">{s.lead_name ?? '—'}</div></div>
            <div><div className="text-[12px] text-muted">Book on or before</div><div className={'text-[15px] font-semibold ' + (overdue(s) ? 'text-bad' : '')}>{fmtDate(s.book_by)}{overdue(s) ? ' (overdue)' : ''}</div></div>
          </div>
          {s.status === 'completed' ? <p className="rounded bg-good-soft px-3 py-2 text-good">Session completed{s.completed_at ? ` on ${fmtDate(s.completed_at)}` : ''}. Thank you for filling in the feedback form.</p> : (<>
            {s.status === 'booked' && !editing && (<>
              <p className="rounded bg-info-soft px-3 py-2 text-info">Booked for <strong>{fmtDateTime(s.booked_for)}</strong>{s.booking_source === 'sheet' || s.booking_source === 'setmore' ? ' (from Setmore)' : ''}{s.booking_source === 'portal' ? ' (in Setmore)' : ''}{s.booked_with_name && s.booked_with_name !== s.provider_name ? ` with ${s.booked_with_name}` : ''}. <button className="font-semibold underline" onClick={() => setEditing(true)}>Change time</button>
                {' · '}<button className="font-semibold underline" onClick={() => setRemoving(true)}>Cancel booking</button></p>
              <div>After the session, fill in the feedback form. The portal marks the session completed when your response arrives.
                <div className="mt-2">{form ? <a href={form} target="_blank" rel="noreferrer"><Button type="button" variant="secondary"><ExternalLink className="h-4 w-4" />Open feedback form</Button></a>
                  : <span className="text-warn">QA has not added the feedback form link yet.</span>}</div></div>
            </>)}
            {s.status === 'cancelled' && (
              <div className="flex flex-wrap items-center gap-3 rounded bg-bad-soft px-3 py-2 text-bad">
                <span>Your booking{s.booked_for ? ` for ${fmtDateTime(s.booked_for)}` : ''} was cancelled. Rebook a new slot before {fmtDate(s.book_by)}.</span>
              </div>
            )}
            {editing && (
              <ol className="flex flex-col gap-3">
                <li><strong>1.</strong> {s.status === 'booked' ? 'Pick a new time' : 'Pick a time'} with <strong>{s.provider_name ?? 'your QA provider'}</strong>. {s.lead_name ? <><strong>{s.lead_name}</strong> (your Team Lead) joins too.</> : 'Your Team Lead joins too.'}
                  <SlotPicker s={s} onBooked={() => { setEditing(false); bump(); }} onKeep={s.status === 'booked' ? () => setEditing(false) : undefined} /></li>
                <li><strong>2.</strong> After the session, fill in the feedback form. The portal marks the session completed when your response arrives.
                  <div className="mt-2">{form ? <a href={form} target="_blank" rel="noreferrer"><Button type="button" variant="secondary"><ExternalLink className="h-4 w-4" />Open feedback form</Button></a>
                    : <span className="text-warn">QA has not added the feedback form link yet.</span>}</div></li>
              </ol>
            )}
          </>)}
          <WeekBreakdown s={s} />
          <ConfirmModal open={removing} title="Cancel this booking?" confirmLabel="Cancel booking" danger onClose={() => setRemoving(false)}
            onConfirm={async () => { await repo.clearFeedbackBooking(s.id); setEditing(true); toast('Booking cancelled. Please book a new slot before the deadline.'); bump(); }}
            body={<p>Your session on <strong>{fmtDateTime(s.booked_for)}</strong> will show as <strong>Cancelled</strong> for you, your Team Lead and QA, and in the Booked Sessions sheet. Its Setmore appointment is labelled Cancelled automatically. Then book a new slot.</p>} />
        </div>
      )}
    </Card>
  );
}

const ymd = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });   // YYYY-MM-DD in India
const ampm = (t: string) => { const [h, m] = t.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };

/** Book inside the portal: pick a day, see the QA provider's free Setmore slots, confirm. */
function SlotPicker({ s, onBooked, onKeep }: { s: FeedbackSession; onBooked: () => void; onKeep?: () => void }) {
  const toast = useToast();
  const days = useMemo(() => Array.from({ length: 21 }, (_, i) => new Date(Date.now() + i * 86400000)), []);
  const [day, setDay] = useState(ymd(days[0]));
  const [time, setTime] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  const slots = useAsync(() => repo.listFeedbackSlots(s.id, day), [s.id, day, tick]);
  useEffect(() => setTime(''), [day]);
  const dayLabel = (d: string) => new Date(`${d}T12:00:00+05:30`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
  const book = async () => {
    setBusy(true); setErr(null);
    try {
      await repo.bookFeedbackSlot(s.id, day, time);
      toast(`Booked for ${dayLabel(day)}, ${ampm(time)} IST. It's in Setmore, and your Team Lead and QA can see it.`);
      onBooked();
    } catch (e) { setErr(e); setTick((n) => n + 1); } finally { setBusy(false); }
  };
  return (
    <div className="mt-2 flex flex-col gap-3 rounded border border-line p-3">
      <div>
        <div className="mb-1.5 text-[12px] font-medium text-muted">Choose a date</div>
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {days.map((d) => { const v = ymd(d); const late = !!s.book_by && v > s.book_by; return (
            <button key={v} type="button" onClick={() => setDay(v)}
              className={'shrink-0 rounded border px-2.5 py-1.5 text-[12.5px] ' + (v === day ? 'border-brand bg-brand text-white' : 'border-line hover:border-brand') + (late && v !== day ? ' text-muted' : '')}>
              {dayLabel(v)}</button>); })}
        </div>
        {!!s.book_by && day > s.book_by && <div className="mt-1 text-[12px] text-warn">This is after the book-by date ({fmtDate(s.book_by)}).</div>}
      </div>
      <div>
        <div className="mb-1.5 text-[12px] font-medium text-muted">Choose a time (India time, IST)</div>
        {slots.loading ? <Loading /> : slots.error ? <ErrorBox error={slots.error} /> : !slots.data?.slots.length
          ? <p className="text-[13px] text-muted">No free slots on {dayLabel(day)} — try another date.</p>
          : <div className="flex flex-wrap gap-1.5">{slots.data.slots.map((t) => (
              <button key={t} type="button" onClick={() => setTime(t)}
                className={'rounded border px-3 py-1.5 text-[13px] ' + (t === time ? 'border-brand bg-brand text-white' : 'border-line hover:border-brand')}>{ampm(t)}</button>))}</div>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button loading={busy} disabled={!time} onClick={book}><CalendarCheck className="h-4 w-4" />{time ? `Book ${dayLabel(day)}, ${ampm(time)}` : 'Book this slot'}</Button>
        {onKeep && <Button variant="ghost" onClick={onKeep}>Keep current time</Button>}
        {s.status === 'booked' && <span className="text-[12px] text-muted">Your current booking is cancelled in Setmore when you book the new time.</span>}
      </div>
      <ErrorBox error={err} />
    </div>
  );
}

function WeekBreakdown({ s }: { s: FeedbackSession }) {
  return (
    <div className="text-[12.5px] text-muted">Who audited {s.weeks.length ? '' : 'you: —'}{s.weeks.map((w, i) => (
      <span key={w.period_id}>{i ? ' · ' : ''}{w.label}: <span className="text-ink">{w.audits ? `${w.evaluator ?? '?'} (${w.audits})` : 'No audit'}</span></span>
    ))}</div>
  );
}

function TeamView({ list, weekNames, number }: { list: FeedbackSession[]; weekNames: string; number: number }) {
  return (
    <Card title={`Your team · Session ${number}`} subtitle={`Audit weeks ${weekNames}. Each CAM books their own session; you join it.`} pad={false}>
      <Table>
        <thead><tr><th className={th}>CAM</th><th className={th}>Session with (QA)</th><th className={th}>Status</th><th className={th}>Booked for</th><th className={th}>Book by</th></tr></thead>
        <tbody>{list.map((s) => (
          <tr key={s.id}><td className={td}><div className="font-medium">{s.cam_name}</div><div className="text-[12px] text-muted">{s.cam_email}</div></td>
            <td className={td}>{s.provider_name ?? '—'}</td><td className={td}><StatusPill s={s.status} />{overdue(s) && <div className="text-[11.5px] text-bad">Overdue</div>}</td>
            <td className={td}>{s.booked_for ? fmtDateTime(s.booked_for) : '—'}</td><td className={td}>{fmtDate(s.book_by)}</td></tr>
        ))}</tbody>
      </Table>
    </Card>
  );
}

function QaView({ cycle, weekNames, list }: { cycle: { id: string; number: number; period_ids: string[]; book_by: string | null; released_at: string | null }; weekNames: string; list: FeedbackSession[] }) {
  const ref = useRef_();
  const toast = useToast();
  const { bump, me } = useApp();
  const [q, setQ] = useState('');
  const [st, setSt] = useState<'' | FeedbackStatus>('');
  const [prov, setProv] = useState('');
  const [bookBy, setBookBy] = useState(cycle.book_by ?? '');
  const [busy, setBusy] = useState('');
  const qaPeople = ref.employees.filter((e) => e.status === 'active' && (e.role === 'super_admin' || e.role === 'evaluator')).sort((a, b) => a.full_name.localeCompare(b.full_name));
  const providers = [...new Set(list.map((s) => s.provider_name).filter(Boolean) as string[])].sort();
  const shown = list.filter((s) => (!st || s.status === st) && (!prov || s.provider_name === prov)
    && (!q || `${s.cam_name} ${s.cam_email} ${s.lead_name ?? ''}`.toLowerCase().includes(q.toLowerCase())));
  const count = (x: FeedbackStatus) => list.filter((s) => s.status === x).length;
  const run = async (key: string, fn: () => Promise<unknown>, msg: string) => {
    setBusy(key);
    try { await fn(); toast(msg); bump(); } catch (e) { toast(e instanceof Error ? e.message : String(e), 'bad'); } finally { setBusy(''); }
  };
  const byProvider = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of list) if (s.provider_name && s.status !== 'no_audit') m.set(s.provider_name, (m.get(s.provider_name) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [list]);

  return (<>
    {!cycle.released_at && <p className="rounded bg-warn-soft px-3 py-2 text-[13px] text-warn">CAMs and Team Leads can't see Session {cycle.number} yet. It appears for them when its last audit week is published.</p>}
    <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
      <Kpi label="CAMs to book" value={list.length - count('no_audit')} sub={`Audit weeks ${weekNames}`} />
      <Kpi label="Not booked" value={count('not_booked')} tone={count('not_booked') ? 'warn' : 'good'} sub={list.filter(overdue).length ? `${list.filter(overdue).length} overdue` : `Book by ${fmtDate(cycle.book_by)}`} />
      <Kpi label="Booked" value={count('booked')} />
      <Kpi label="Completed" value={count('completed')} tone="good" sub="feedback form received" />
      <Kpi label="No audits" value={count('no_audit')} sub="nothing to book" />
    </div>
    <Card title={`Session ${cycle.number} · ${weekNames}`} subtitle={<>Sessions per provider: {byProvider.map(([n, c]) => `${n.split(' ')[0]} ${c}`).join(' · ') || '—'}</>} pad={false}
      actions={<div className="flex flex-wrap items-center gap-2">
        <label htmlFor="fb-bookby" className="text-[12.5px] text-muted">Book by</label>
        <input id="fb-bookby" type="date" className={inputBase + ' w-auto'} value={bookBy} onChange={(e) => setBookBy(e.target.value)} />
        <Button size="sm" variant="secondary" disabled={bookBy === (cycle.book_by ?? '')} loading={busy === 'bookby'} onClick={() => run('bookby', () => repo.updateFeedbackCycle(cycle.id, bookBy || null), 'Booking deadline saved.')}>Save date</Button>
        <Button size="sm" variant="secondary" loading={busy === 'refresh'} onClick={() => run('refresh', () => repo.buildFeedbackCycle(cycle.number, cycle.period_ids, cycle.book_by), 'Providers refreshed from the latest audits (your manual changes are kept).')}><RefreshCw className="h-4 w-4" />Refresh from audits</Button>
      </div>}>
      <div className="flex flex-wrap gap-2 border-b border-line px-4 py-3">
        <input aria-label="Search CAM or Lead" placeholder="Search CAM or Lead" className={inputBase + ' w-56'} value={q} onChange={(e) => setQ(e.target.value)} />
        <Select aria-label="Status" className={inputBase + ' w-auto'} value={st} onChange={(e) => setSt(e.target.value as FeedbackStatus | '')}>
          <option value="">All statuses</option>{(Object.keys(STATUS) as FeedbackStatus[]).map((k) => <option key={k} value={k}>{STATUS[k].label}</option>)}</Select>
        <Select people aria-label="Provider" className={inputBase + ' w-auto'} value={prov} onChange={(e) => setProv(e.target.value)}>
          <option value="">All providers</option>{providers.map((p) => <option key={p}>{p}</option>)}</Select>
        <span className="self-center text-[12.5px] text-muted">{shown.length} of {list.length}</span>
      </div>
      <Table>
        <thead><tr><th className={th}>CAM</th>{cycle.period_ids.map((id) => <th key={id} className={th}>{ref.periods.find((p) => p.id === id)?.short_label}</th>)}
          <th className={th}>Session with</th><th className={th}>Team Lead</th><th className={th}>Status</th><th className={th}>Booked for</th></tr></thead>
        <tbody>{shown.map((s) => (
          <tr key={s.id}>
            <td className={td}><div className="font-medium">{s.cam_name}</div><div className="text-[12px] text-muted">{s.cam_email}</div></td>
            {cycle.period_ids.map((id) => { const w = s.weeks.find((x) => x.period_id === id); return <td key={id} className={td + ' text-[12.5px]'}>{w?.audits ? <>{(w.evaluator ?? '?').split(' ')[0]} <span className="text-muted">({w.audits})</span></> : <span className="text-muted">No audit</span>}</td>; })}
            <td className={td}>
              <Select people aria-label={`Provider for ${s.cam_name}`} className={inputBase + ' w-auto text-[13px]'} value={s.provider_id ?? ''} disabled={busy === s.id}
                onChange={(e) => e.target.value && run(s.id, () => repo.updateFeedbackSession(s.id, { providerId: e.target.value }), `Provider for ${s.cam_name} changed.`)}>
                <option value="">{s.provider_name ?? '— choose —'}</option>
                {qaPeople.map((p) => <option key={p.id} value={p.id}>{p.full_name}{p.id === me!.id ? ' (you)' : ''}</option>)}
              </Select>
              {!s.provider_auto && <div className="text-[11px] text-muted">Changed by QA</div>}
            </td>
            <td className={td}>{s.lead_name ?? <span className="text-warn">No Lead</span>}</td>
            <td className={td}>
              <Select aria-label={`Status for ${s.cam_name}`} className={inputBase + ' w-auto text-[13px]'} value={s.status} disabled={busy === s.id}
                onChange={(e) => run(s.id, () => repo.updateFeedbackSession(s.id, { status: e.target.value as FeedbackStatus }), `Status for ${s.cam_name} updated.`)}>
                {(Object.keys(STATUS) as FeedbackStatus[]).map((k) => <option key={k} value={k}>{STATUS[k].label}</option>)}
              </Select>
              {overdue(s) && <div className="text-[11.5px] text-bad">Overdue</div>}
            </td>
            <td className={td + ' whitespace-nowrap'}>{s.booked_for ? fmtDateTime(s.booked_for) : '—'}{s.booking_source && <div className="text-[11px] text-muted">{{ sheet: 'From Setmore', setmore: 'From Setmore', portal: 'Booked in portal', cam: 'Entered by CAM', qa: 'Entered by QA' }[s.booking_source]}{s.booked_with_name && s.booked_with_name !== s.provider_name ? <span className="text-warn"> · booked with {s.booked_with_name}</span> : null}</div>}</td>
          </tr>
        ))}</tbody>
      </Table>
    </Card>
  </>);
}

function ResponsesView() {
  const rows = useAsync(() => repo.listFeedbackResponses(), []);
  const [q, setQ] = useState('');
  const [prov, setProv] = useState('');
  const list = rows.data ?? [];
  const providers = [...new Set(list.map((r) => r.provider_name).filter(Boolean) as string[])].sort();
  const shown = list.filter((r) => (!prov || r.provider_name === prov) && (!q || `${r.cam_email} ${r.feedback_for_provider ?? ''} ${r.lead_name ?? ''}`.toLowerCase().includes(q.toLowerCase())));
  const pct = (f: (r: typeof list[number]) => boolean) => (shown.length ? `${Math.round((100 * shown.filter(f).length) / shown.length)}%` : '—');
  return (<>
    <ErrorBox error={rows.error} />
    {rows.loading ? <Loading /> : list.length === 0 ? (
      <EmptyState title="No form responses yet" body="Responses arrive from the feedback form tab in your audit sheet each time the sheet script runs (paste the latest script first)." />
    ) : (<>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Responses" value={shown.length} />
        <Kpi label="Agree with the feedback" value={pct((r) => /^yes/i.test(r.agrees ?? ''))} />
        <Kpi label="Team Lead present" value={pct((r) => /^yes/i.test(r.lead_present ?? ''))} />
        <Kpi label="Latest" value={fmtDate(shown[0]?.submitted_at)} />
      </div>
      <Card title="Feedback form responses" subtitle="Visible to the QA team only." pad={false}>
        <div className="flex flex-wrap gap-2 border-b border-line px-4 py-3">
          <input aria-label="Search responses" placeholder="Search CAM or comment" className={inputBase + ' w-60'} value={q} onChange={(e) => setQ(e.target.value)} />
          <Select people aria-label="Provider" className={inputBase + ' w-auto'} value={prov} onChange={(e) => setProv(e.target.value)}>
            <option value="">All providers</option>{providers.map((p) => <option key={p}>{p}</option>)}</Select>
        </div>
        <Table>
          <thead><tr><th className={th}>Submitted</th><th className={th}>CAM</th><th className={th}>Provider</th><th className={th}>Lead present</th><th className={th}>Agrees</th><th className={th}>Feedback for the provider</th><th className={th}>QA feedback</th></tr></thead>
          <tbody>{shown.map((r) => (
            <tr key={r.id}><td className={td + ' whitespace-nowrap'}>{fmtDateTime(r.submitted_at)}</td><td className={td}>{r.cam_email}</td><td className={td}>{r.provider_name ?? '—'}</td>
              <td className={td}>{r.lead_present ?? '—'}{r.lead_name ? <div className="text-[12px] text-muted">{r.lead_name}</div> : null}</td>
              <td className={td}>{r.agrees ?? '—'}</td><td className={td + ' max-w-[360px] whitespace-pre-wrap text-[12.5px]'}>{r.feedback_for_provider ?? '—'}</td>
              <td className={td + ' max-w-[260px] whitespace-pre-wrap text-[12.5px]'}>{r.qa_feedback ?? '—'}</td></tr>
          ))}</tbody>
        </Table>
      </Card>
    </>)}
  </>);
}

function NewCycle({ nextNumber }: { nextNumber: number }) {
  const ref = useRef_();
  const toast = useToast();
  const { bump } = useApp();
  const [open, setOpen] = useState(false);
  const [num, setNum] = useState(nextNumber);
  const [weeks, setWeeks] = useState<string[]>([]);
  const [bookBy, setBookBy] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const recent = [...ref.periods].reverse().slice(0, 12);
  return (<>
    <div><Button variant="ghost" size="sm" onClick={() => { setNum(nextNumber); setWeeks([]); setOpen(true); }}>Start a feedback cycle manually…</Button>
      <span className="ml-2 text-[12px] text-muted">Normally not needed: cycles are created when their last week is published.</span></div>
    <Modal open={open} title="Start a feedback cycle" onClose={() => setOpen(false)} footer={<>
      <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
      <Button loading={busy} disabled={!weeks.length} onClick={async () => {
        setBusy(true); setErr(null);
        try { await repo.buildFeedbackCycle(num, [...weeks].sort((a, b) => (ref.periods.find((p) => p.id === a)?.start_date ?? '').localeCompare(ref.periods.find((p) => p.id === b)?.start_date ?? '')), bookBy || null); toast(`Session ${num} set up.`); setOpen(false); bump(); }
        catch (e) { setErr(e); } finally { setBusy(false); }
      }}>Set up Session {num}</Button></>}>
      <div className="flex flex-col gap-3 text-sm">
        <Field label="Session number" htmlFor="nc-num"><input id="nc-num" type="number" className={inputCls} value={num} onChange={(e) => setNum(Number(e.target.value))} /></Field>
        <div><div className="mb-1 text-[13px] font-medium">Audit weeks</div>
          <div className="grid grid-cols-3 gap-1">{recent.map((p) => (
            <label key={p.id} className="flex items-center gap-1.5 text-[13px]"><input type="checkbox" checked={weeks.includes(p.id)}
              onChange={(e) => setWeeks(e.target.checked ? [...weeks, p.id] : weeks.filter((w) => w !== p.id))} />{p.short_label}</label>))}</div></div>
        <Field label="Book on or before" htmlFor="nc-by"><input id="nc-by" type="date" className={inputCls} value={bookBy} onChange={(e) => setBookBy(e.target.value)} /></Field>
        <p className="text-[12.5px] text-muted">If the session number already exists, it's refreshed from the latest audits (manual provider changes and bookings are kept).</p>
        <ErrorBox error={err} />
      </div>
    </Modal>
  </>);
}

function LinksCard() {
  const ref = useRef_();
  const toast = useToast();
  const { reloadRef } = useApp();
  const f = ref.settings.feedback;
  const [booking, setBooking] = useState(f?.booking_url ?? '');
  const [form, setForm] = useState(f?.form_url ?? '');
  const [busy, setBusy] = useState(false);
  const ok = (u: string) => !u || /^https:\/\//.test(u.trim());
  return (
    <Card title="Links shown to CAMs" subtitle="Super Admin only." actions={<Button size="sm" loading={busy} disabled={!ok(booking) || !ok(form) || (booking === (f?.booking_url ?? '') && form === (f?.form_url ?? ''))}
      onClick={async () => {
        setBusy(true);
        try { await repo.updateSetting('feedback', { ...f, booking_url: booking.trim(), form_url: form.trim() }); await reloadRef(); toast('Links saved.'); }
        catch (e) { toast(e instanceof Error ? e.message : String(e), 'bad'); } finally { setBusy(false); }
      }}>Save links</Button>}>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Setmore booking link" htmlFor="fl-book" hint={ok(booking) ? undefined : 'Start the link with https://'}><input id="fl-book" className={inputCls} value={booking} onChange={(e) => setBooking(e.target.value)} /></Field>
        <Field label="Feedback form link (Google Form)" htmlFor="fl-form" hint={ok(form) ? 'Open the form, click Send → link icon, copy the link and paste it here.' : 'Start the link with https://'}>
          <input id="fl-form" className={inputCls} placeholder="https://forms.gle/…" value={form} onChange={(e) => setForm(e.target.value)} /></Field>
      </div>
    </Card>
  );
}
