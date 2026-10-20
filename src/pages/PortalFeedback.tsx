import { useState } from 'react';
import { Star } from 'lucide-react';
import { useApp, useAsync } from '../app/context';
import { repo } from '../data';
import { PageHeader } from '../components/Layout';
import { Card, EmptyState, ErrorBox, Kpi, Loading, Pill, Table, td, th, inputBase, useToast } from '../components/ui';
import { fmtDateTime } from '../lib/metrics';

const KIND: Record<string, { label: string; tone: 'bad' | 'info' | 'warn' | 'neutral' }> = {
  bug: { label: 'Problem', tone: 'bad' }, idea: { label: 'Idea', tone: 'info' }, question: { label: 'Question', tone: 'warn' }, other: { label: 'Other', tone: 'neutral' },
};

/** Super Admin: everything people sent with the Feedback button (each one is also emailed). */
export default function PortalFeedbackPage() {
  const { bump } = useApp();
  const toast = useToast();
  const rows = useAsync(() => repo.listFeedback(), []);
  const [show, setShow] = useState<'new' | 'done' | 'all'>('new');
  const list = (rows.data ?? []).filter((r) => show === 'all' || r.status === show);
  const all = rows.data ?? [];
  const rated = all.filter((r) => r.rating);
  const avg = rated.length ? rated.reduce((a, r) => a + (r.rating ?? 0), 0) / rated.length : null;
  const toggle = async (id: string, status: 'new' | 'done') => {
    try { await repo.setFeedbackStatus(id, status); bump(); } catch (e) { toast(e instanceof Error ? e.message : String(e), 'bad'); }
  };
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Portal Feedback" subtitle="Everything people sent with the Feedback button. Each one is also emailed to you; reply to that email to answer the sender."
        actions={<select aria-label="Show" className={inputBase + ' w-auto'} value={show} onChange={(e) => setShow(e.target.value as 'new' | 'done' | 'all')}>
          <option value="new">New</option><option value="done">Handled</option><option value="all">All</option></select>} />
      <ErrorBox error={rows.error} />
      {rows.loading ? <Loading /> : (<>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Kpi label="New" value={all.filter((r) => r.status === 'new').length} tone={all.some((r) => r.status === 'new') ? 'warn' : 'good'} />
          <Kpi label="Problems reported" value={all.filter((r) => r.kind === 'bug').length} />
          <Kpi label="Ideas" value={all.filter((r) => r.kind === 'idea').length} />
          <Kpi label="Average rating" value={avg === null ? '—' : `${avg.toFixed(1)} / 5`} sub={`${rated.length} rating(s)`} />
        </div>
        {list.length === 0 ? <EmptyState title={show === 'new' ? 'No new feedback' : 'No feedback here yet'} /> : (
          <Card pad={false}>
            <Table>
              <thead><tr><th className={th}>Received</th><th className={th}>From</th><th className={th}>Type</th><th className={th}>Feedback</th><th className={th}>Rating</th><th className={th}>Page</th><th className={th}></th></tr></thead>
              <tbody>{list.map((r) => (
                <tr key={r.id} className={r.status === 'done' ? 'opacity-60' : ''}>
                  <td className={td + ' whitespace-nowrap'}>{fmtDateTime(r.created_at)}</td>
                  <td className={td}><div className="font-medium">{r.sender_name ?? '—'}</div><div className="text-[12px] text-muted">{r.sender_email}</div></td>
                  <td className={td}><Pill tone={KIND[r.kind]?.tone ?? 'neutral'}>{KIND[r.kind]?.label ?? r.kind}</Pill></td>
                  <td className={td + ' max-w-[520px] whitespace-pre-wrap text-[13px]'}>{r.message}</td>
                  <td className={td + ' whitespace-nowrap'}>{r.rating ? <span className="inline-flex items-center gap-0.5">{r.rating}<Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" /></span> : '—'}</td>
                  <td className={td + ' text-[12px] text-muted'}>{r.page ?? '—'}</td>
                  <td className={td + ' whitespace-nowrap'}><button className="text-[12.5px] font-medium text-brand hover:underline" onClick={() => toggle(r.id, r.status === 'new' ? 'done' : 'new')}>{r.status === 'new' ? 'Mark handled' : 'Mark new'}</button></td>
                </tr>
              ))}</tbody>
            </Table>
          </Card>
        )}
      </>)}
    </div>
  );
}
