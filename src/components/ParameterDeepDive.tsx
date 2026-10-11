import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { useAsync, useRef_ } from '../app/context';
import { repo } from '../data';
import { Card, EmptyState, ErrorBox, Kpi, Loading, ScoreBadge, Table, td, th, Variance } from './ui';
import { TrendChart } from './charts';
import { fmtPct, parameterStats, summarize, variance, weeklyTrend, type ParamStat, type PeriodSelection } from '../lib/metrics';
import type { Evaluation, Period } from '../lib/types';


/**
 * One CAM in the selected week only: what to focus on next (ranked by points lost)
 * and one table of every parameter checked, with the missed tasks under each.
 */
export function CamDeepDive({ camName, cur, sel }: { camName: string; cur: Evaluation[]; sel: PeriodSelection }) {
  const ref = useRef_();
  const s = ref.settings;
  const mine = useMemo(() => parameterStats(cur, ref.parameters, ref.taskTypeNames).filter((x) => x.evaluated > 0), [cur, ref]);
  const S = summarize(cur);
  const rows = [...mine].sort((x, y) => (y.pointsLost - x.pointsLost) || ((x.pct ?? 0) - (y.pct ?? 0)) || x.parameter.sort_order - y.parameter.sort_order);
  const focus = rows.filter((m) => m.deductions > 0).slice(0, 3);
  const strengths = [...mine].filter((m) => m.deductions === 0).sort((x, y) => y.evaluated - x.evaluated).slice(0, 4);
  const autofails = cur.filter((e) => e.autofail);
  const lost = cur.flatMap((e) => (e.autofail ? [] : e.scores.filter((x) => x.earned !== null && Number(x.earned) < Number(x.max_score)).map((x) => ({ e, x }))));
  const pointsLost = lost.reduce((t, l) => t + Number(l.x.max_score) - Number(l.x.earned), 0);
  const types = Object.keys(ref.taskTypeNames).filter((t) => cur.some((e) => e.task_type === t));
  const priority = (m: ParamStat) => ((m.pct ?? 100) < s.thresholds.amber ? 'High' : (m.pct ?? 100) < s.thresholds.green ? 'Medium' : 'Low');
  const remark = (paramId: string) => { const l = lost.find((x) => x.x.parameter_id === paramId && (x.x.remarks || x.e.feedback)); return l ? (l.x.remarks || l.e.feedback || '') : ''; };

  if (!cur.length) return <Card title={`Deep dive · ${camName}`} subtitle={sel.label}><EmptyState title="No audits for this CAM in the selected week." /></Card>;
  return (
    <Card title={`Deep dive · ${camName}`} subtitle={`${sel.label} only`}>
      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Kpi label="Tasks audited" value={S.tasks} sub={types.map((t) => `${ref.taskTypeNames[t]} ${cur.filter((e) => e.task_type === t).length}`).join(' · ')} />
          <Kpi label="Average QA score" value={fmtPct(S.avg)} sub={S.avg === null ? '' : S.avg >= s.qa_target.score ? `meets the ${s.qa_target.score}% target` : `${round1(s.qa_target.score - S.avg)} pts below the ${s.qa_target.score}% target`} />
          <Kpi label="Autofails" value={S.autofails} tone={S.autofails ? 'bad' : 'good'} sub={S.autofails ? 'task score set to 0' : 'none this week'} />
          <Kpi label="Issues missed" value={lost.length} sub={`${pointsLost} point(s) lost`} />
        </div>

        <div className="rounded-lg border border-brand/40 bg-brand-soft/30 p-4">
          <div className="mb-2 text-[14px] font-semibold">Where {camName.split(' ')[0]} should focus</div>
          {autofails.length === 0 && focus.length === 0 ? <p className="text-[13px] text-good">No points lost this week — keep it up.</p> : (
            <ol className="flex flex-col gap-3 text-[13px]">
              {autofails.length > 0 && (
                <li><span className="mr-2 rounded bg-bad px-1.5 py-0.5 text-[11px] font-semibold text-white">Top priority</span>
                  <strong>Avoid autofails</strong> — {autofails.length} task(s) scored 0: {autofails.map((e, i) => <span key={e.id}>{i ? ', ' : ''}<Link to={`/evaluations/${e.id}`} className="font-mono text-brand hover:underline">{e.task_id.slice(0, 8)}</Link> ({e.task_type_name})</span>)}.</li>
              )}
              {focus.map((m, i) => {
                const p = priority(m); const said = remark(m.parameter.id);
                return (
                  <li key={m.parameter.id}>
                    <span className={clsx('mr-2 rounded px-1.5 py-0.5 text-[11px] font-semibold', p === 'High' ? 'bg-bad-soft text-bad' : p === 'Medium' ? 'bg-warn-soft text-warn' : 'bg-sunken text-muted')}>{i === 0 && !autofails.length ? 'Focus first' : `${p} priority`}</span>
                    <strong>{m.parameter.name}</strong> <span className="text-muted">({m.taskTypeName})</span> — missed on {m.deductions} of {m.evaluated} task(s), {m.pointsLost} point(s) lost, {fmtPct(m.pct)} achieved.
                    {said && <div className="mt-1 border-l-2 border-line pl-2 text-[12.5px] text-muted">QA said: “{said.slice(0, 220)}{said.length > 220 ? '…' : ''}”</div>}
                  </li>
                );
              })}
            </ol>
          )}
          {strengths.length > 0 && <p className="mt-3 text-[12.5px] text-good"><strong>Doing well:</strong> {strengths.map((m) => `${m.parameter.name} (${m.taskTypeName}, ${m.evaluated}/${m.evaluated})`).join(' · ')}</p>}
        </div>

        <div>
          <div className="mb-2 text-[13.5px] font-semibold">Parameters checked this week · missed tasks listed under each</div>
          <Table>
            <thead><tr><th className={th}>Parameter / missed task</th><th className={th + ' text-right'}>% achieved</th><th className={th + ' text-right'}>Tasks checked</th><th className={th + ' text-right'}>Missed</th><th className={th + ' text-right'}>Points lost</th><th className={th}>QA remarks / feedback</th></tr></thead>
            <tbody>{rows.map((m) => {
              const items = lost.filter((l) => l.x.parameter_id === m.parameter.id);
              return (
                <Fragment key={m.parameter.id}>
                  <tr className={items.length ? 'bg-sunken/50' : ''}>
                    <td className={td}><span className="font-medium">{m.parameter.name}</span> <span className="text-[12px] text-muted">· {m.taskTypeName}</span></td>
                    <td className={td + ' text-right'}><ScoreBadge score={m.pct} settings={s} /></td>
                    <td className={td + ' text-right tnum'}>{m.evaluated}</td>
                    <td className={td + ' text-right tnum'}>{m.deductions ? <span className="font-semibold text-bad">{m.deductions}</span> : 0}</td>
                    <td className={td + ' text-right tnum'}>{m.pointsLost || 0}</td>
                    <td className={td + ' text-[12.5px] text-good'}>{items.length ? '' : 'All tasks met'}</td>
                  </tr>
                  {items.map(({ e, x }) => (
                    <tr key={x.id}>
                      <td className={td + ' whitespace-nowrap pl-8'}><Link to={`/evaluations/${e.id}`} className="font-mono text-[12px] text-brand hover:underline">{e.task_id.slice(0, 8)}</Link> <span className="text-[11.5px] text-muted">{e.task_type_name}</span></td>
                      <td className={td + ' text-right tnum text-bad'}>{x.earned}/{x.max_score}</td>
                      <td className={td} /><td className={td} />
                      <td className={td + ' text-right tnum text-bad'}>{Number(x.max_score) - Number(x.earned)}</td>
                      <td className={td + ' max-w-[560px] whitespace-pre-wrap text-[12.5px] text-muted'}>{x.remarks || e.feedback || '—'}</td>
                    </tr>
                  ))}
                </Fragment>
              );
            })}</tbody>
          </Table>
        </div>
      </div>
    </Card>
  );
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Pick any weeks and see every parameter side by side, with the change from the first to the last week. */
export function WeekCompare({ camIds, scopeLabel, periods, endId }: { camIds?: string[]; scopeLabel: string; periods: Period[]; /** start with this week and the 3 before it */ endId?: string }) {
  const ref = useRef_();
  const s = ref.settings;
  const choices = useMemo(() => [...periods].sort((a, b) => b.start_date.localeCompare(a.start_date)).slice(0, 26), [periods]);
  const around = (id?: string) => { const i = Math.max(0, choices.findIndex((p) => p.id === id)); return choices.slice(i, i + 4).map((p) => p.id); };
  const [picked, setPicked] = useState<string[]>(() => around(endId));
  useEffect(() => { setPicked(around(endId)); }, [endId]);   // follow the week chosen at the top of the page
  const weeks = choices.filter((p) => picked.includes(p.id)).sort((a, b) => a.start_date.localeCompare(b.start_date));
  const data = useAsync(() => (weeks.length ? repo.getEvaluations({ periodIds: weeks.map((w) => w.id), camIds }) : Promise.resolve([] as Evaluation[])), [weeks.map((w) => w.id).join(','), camIds?.join(',') ?? '']);
  const all = data.data ?? [];
  const types = Object.keys(ref.taskTypeNames).filter((t) => all.some((e) => e.task_type === t));
  const [type, setType] = useState('');
  const activeType = types.includes(type) ? type : types[0];
  const perWeek = useMemo(() => weeks.map((w) => new Map(parameterStats(all.filter((e) => e.period_id === w.id), ref.parameters, ref.taskTypeNames).map((x) => [x.parameter.id, x]))), [all, weeks, ref]);
  const params = ref.parameters.filter((p) => p.task_type === activeType && perWeek.some((m) => (m.get(p.id)?.evaluated ?? 0) > 0)).sort((a, b) => a.sort_order - b.sort_order);
  const sections = [...new Set(params.map((p) => p.section ?? ''))];
  const sums = weeks.map((w) => summarize(all.filter((e) => e.period_id === w.id && (!activeType || e.task_type === activeType))));
  const overall = weeks.map((w) => summarize(all.filter((e) => e.period_id === w.id)));
  const toggle = (id: string) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : picked.length >= 8 ? picked : [...picked, id]);
  const pctOf = (st: ParamStat | undefined) => (st?.evaluated ? st.pct : null);

  return (
    <Card title="Compare weeks" subtitle={<>{scopeLabel} · starts with the selected week and the 3 before it — click weeks to add or remove (2–8)</>}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-1.5">{choices.map((p) => (
          <button key={p.id} onClick={() => toggle(p.id)} aria-pressed={picked.includes(p.id)}
            className={clsx('rounded-full border px-2.5 py-1 text-[12.5px] font-medium', picked.includes(p.id) ? 'border-brand bg-brand-soft text-brand' : 'border-line text-muted hover:text-ink')}>
            {p.short_label}{p.status !== 'published' ? ' (draft)' : ''}</button>
        ))}</div>
        <ErrorBox error={data.error} />
        {weeks.length < 2 ? <p className="text-[13px] text-muted">Choose at least two weeks.</p> : data.loading ? <Loading /> : !all.length ? <EmptyState title="No audits in the chosen weeks." /> : (<>
          <TrendChart points={weeklyTrend(all, weeks)} settings={s} height={200} />
          <div className="flex flex-wrap gap-2">{types.map((t) => (
            <button key={t} onClick={() => setType(t)} className={clsx('rounded-full border px-3 py-1 text-[13px] font-medium', t === activeType ? 'border-brand bg-brand-soft text-brand' : 'border-line text-muted hover:text-ink')}>
              {ref.taskTypeNames[t]}</button>))}</div>
          <Table>
            <thead><tr><th className={th}>Parameter</th>{weeks.map((w) => <th key={w.id} className={th + ' text-right'}>{w.short_label}</th>)}<th className={th + ' text-right'}>Change {weeks[0].short_label} → {weeks[weeks.length - 1].short_label}</th></tr></thead>
            <tbody>
              <tr className="bg-sunken/40"><td className={td + ' font-semibold'}>Tasks audited (all types)</td>{overall.map((x, i) => <td key={i} className={td + ' text-right tnum'}>{x.tasks}</td>)}<td className={td} /></tr>
              <tr className="bg-sunken/40"><td className={td + ' font-semibold'}>Average QA score (all types)</td>{overall.map((x, i) => <td key={i} className={td + ' text-right'}><ScoreBadge score={x.avg} settings={s} /></td>)}
                <td className={td + ' text-right'}><Variance value={variance(overall[overall.length - 1].avg, overall[0].avg)} /></td></tr>
              <tr className="bg-sunken/40"><td className={td + ' font-semibold'}>Autofails (all types)</td>{overall.map((x, i) => <td key={i} className={td + ' text-right tnum'}>{x.autofails}</td>)}<td className={td} /></tr>
              <tr className="bg-sunken/40"><td className={td + ' font-semibold'}>{ref.taskTypeNames[activeType]} tasks · average</td>{sums.map((x, i) => <td key={i} className={td + ' text-right tnum text-[12.5px]'}>{x.tasks} · {fmtPct(x.avg, 1)}</td>)}
                <td className={td + ' text-right'}><Variance value={variance(sums[sums.length - 1].avg, sums[0].avg)} /></td></tr>
              {sections.map((sec) => (
                <Fragment key={sec}>
                  {sec && <tr><td colSpan={weeks.length + 2} className="bg-sunken px-3 py-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-muted">{sec}</td></tr>}
                  {params.filter((p) => (p.section ?? '') === sec).map((p) => {
                    const vals = perWeek.map((m) => pctOf(m.get(p.id)));
                    const first = vals.find((v) => v !== null) ?? null;
                    const last = [...vals].reverse().find((v) => v !== null) ?? null;
                    return (
                      <tr key={p.id}><td className={td + ' font-medium'}>{p.name}</td>
                        {vals.map((v, i) => <td key={i} className={td + ' text-right'}>{v === null ? <span className="text-faint">—</span> : <ScoreBadge score={v} settings={s} />}
                          {(perWeek[i].get(p.id)?.deductions ?? 0) > 0 && <div className="text-[11px] text-bad">{perWeek[i].get(p.id)!.deductions} ded.</div>}</td>)}
                        <td className={td + ' text-right'}><Variance value={variance(last, first)} /></td></tr>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </Table>
          <p className="text-[12px] text-muted">Parameter % excludes autofailed tasks, the same as the table above. "ded." = number of checks with points deducted that week.</p>
        </>)}
      </div>
    </Card>
  );
}
