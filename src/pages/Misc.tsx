import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { useApp, useAsync, useRef_ } from '../app/context';
import { useScopeData } from '../app/useScope';
import { repo } from '../data';
import { PageHeader } from '../components/Layout';
import { PeriodPicker, usePeriodSelection } from '../components/PeriodPicker';
import { Button, Card, EmptyState, ErrorBox, Loading, inputBase } from '../components/ui';
import { InsightsPanel, ParameterAnalysis } from '../components/shared';
import { CamDeepDive, WeekCompare } from '../components/ParameterDeepDive';
import { isQaRole, isReportee, buildInsights, fmtDateTime, METRIC_DEFINITIONS } from '../lib/metrics';

export function ParametersPage() {
  const { me } = useApp();
  const ref = useRef_();
  const [sel, setSel, periods] = usePeriodSelection(isQaRole(me!.role));
  const [cam, setCam] = useState(me!.role === 'user' ? me!.id : '');
  const data = useScopeData(sel, cam ? [cam] : undefined);
  const cams = ref.employees.filter((e) => isReportee(e) && e.id !== me!.id && (isQaRole(me!.role) || me!.role === 'manager' || (me!.role === 'admin' && ref.teams.some((t) => t.id === e.team_id && t.lead_id === me!.id))));
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const camName = cam === me!.id ? me!.full_name : ref.employees.find((e) => e.id === cam)?.full_name ?? '';
  const insights = useMemo(() => buildInsights(data.cur, data.prev, data.history, data.historyWeeks, ref.parameters, ref.taskTypeNames, ref.settings), [data, ref]);
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Parameter-Level Performance Analysis" subtitle="Results for the selected week only. Choose a CAM for a deep dive into that week; use Compare weeks at the bottom to compare weeks."
        actions={<>
          {me!.role !== 'user' && <><label htmlFor="pa-cam" className="sr-only">CAM</label><select id="pa-cam" className={inputBase + ' w-auto'} value={cam} onChange={(e) => setCam(e.target.value)}><option value="">{me!.role === 'admin' ? 'Whole team' : 'All CAMs'}</option>{cams.map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}</select></>}
          <PeriodPicker sel={sel} onChange={setSel} periods={periods} showVs={false} />
        </>} />
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="text-muted">Jump to:</span>
        <button className="rounded-full border border-brand bg-brand-soft px-3 py-1 font-medium text-brand" onClick={() => (cam ? jump('pa-deep') : document.getElementById('pa-cam')?.focus())}>
          {cam ? `Deep dive · ${camName}` : 'CAM deep dive (choose a CAM first)'}</button>
        <button className="rounded-full border border-brand bg-brand-soft px-3 py-1 font-medium text-brand" onClick={() => jump('pa-compare')}>Compare weeks</button>
      </div>
      <ErrorBox error={data.error} />
      {data.loading ? <Loading /> : (<>
        {!cam && <Card title="Parameters" subtitle={`${sel.label} only${cam ? ` · ${camName} · full table in the deep dive below` : ''} · parameters with no tasks this period are hidden`}><ParameterAnalysis cur={data.cur} prev={data.prev} parameters={ref.parameters} taskTypeNames={ref.taskTypeNames} settings={ref.settings} compare={false} showTable={!cam} /></Card>}
        {data.cur.length > 0 && !cam && <Card title="Strengths and improvement areas" subtitle={sel.label}><InsightsPanel insights={insights} hide={['positive', 'declining']} /></Card>}
        {cam && <div id="pa-deep" className="scroll-mt-4" />}
        {cam && <CamDeepDive camName={camName} cur={data.cur} sel={sel} />}
        <div id="pa-compare" className="scroll-mt-4" />
        <WeekCompare camIds={cam ? [cam] : undefined} endId={sel.current[sel.current.length - 1]?.id} periods={isQaRole(me!.role) ? ref.periods : ref.publishedPeriods}
          scopeLabel={cam ? camName : me!.role === 'admin' ? 'Your whole team' : 'All CAMs'} />
        <Card title="Metric definitions">
          <dl className="grid gap-3 md:grid-cols-2">{Object.entries(METRIC_DEFINITIONS).map(([k, v]) => <div key={k}><dt className="text-[13px] font-semibold">{k}</dt><dd className="text-[12.5px] text-muted">{v}</dd></div>)}</dl>
        </Card>
      </>)}
    </div>
  );
}

export function NotificationsPage() {
  const { bump } = useApp();
  const nav = useNavigate();
  const n = useAsync(() => repo.listNotifications(), []);
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const list = (n.data ?? []).filter((x) => filter === 'all' || !x.read_at);
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Notifications" subtitle="Weekly report releases, appeal updates and score changes."
        actions={<><select aria-label="Filter" className={inputBase + ' w-auto'} value={filter} onChange={(e) => setFilter(e.target.value as 'all' | 'unread')}><option value="all">All</option><option value="unread">Unread</option></select>
          <Button variant="secondary" onClick={async () => { await repo.markNotificationsRead(); bump(); }}>Mark all as read</Button></>} />
      {n.loading ? <Loading /> : list.length === 0 ? <EmptyState title="You’re all caught up" /> : (
        <Card pad={false}>
          <ul className="divide-y divide-line">{list.map((x) => (
            <li key={x.id}>
              <button className={clsx('flex w-full flex-col gap-0.5 px-4 py-3 text-left hover:bg-sunken', !x.read_at && 'bg-brand-soft/30')}
                onClick={async () => { await repo.markNotificationsRead([x.id]); bump(); if (x.link) nav(x.link.replace('/dashboard', '/')); }}>
                <span className="flex items-center gap-2 text-[13.5px] font-medium">{!x.read_at && <span className="h-2 w-2 rounded-full bg-brand" aria-label="Unread" />}{x.title}</span>
                <span className="text-[13px] text-muted">{x.message}</span>
                <span className="text-[11.5px] text-faint">{fmtDateTime(x.created_at)}</span>
              </button>
            </li>
          ))}</ul>
        </Card>
      )}
    </div>
  );
}
