import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Send } from 'lucide-react';
import { useApp, useAsync, useRef_ } from '../app/context';
import { repo, isDemo, isLocal } from '../data';
import { Button, Card, ErrorBox, Field, Loading, Modal, Pill, inputCls, textareaCls, useToast } from './ui';
import { buildScorecard, scorecardTeams } from '../lib/scorecard';
import { fmtDateTime } from '../lib/metrics';
import type { Evaluation, Period } from '../lib/types';

/** Weekly overall "Task Audit Scorecard" email: preview, open in the browser, send with a confirmation step. */
export function ScorecardCard({ period }: { period: Period }) {
  const { me, reloadRef } = useApp();
  const ref = useRef_();
  const toast = useToast();
  const s = ref.settings;
  const cfg = s.scorecard ?? { from_email: '', from_name: 'quality assurance', to: '', cc: '', chat_lead_id: null };
  const evals = useAsync(() => repo.getEvaluations({ periodIds: [period.id] }), [period.id]);
  const history = useAsync(() => repo.scorecardHistory(period.id), [period.id]);
  const [to, setTo] = useState(cfg.to);
  const [cc, setCc] = useState(cfg.cc);
  const [chatLead, setChatLead] = useState(cfg.chat_lead_id ?? '');
  const [excl, setExcl] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState(false);
  const [ticked, setTicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const isSuper = me?.role === 'super_admin';
  const leads = ref.employees.filter((e) => e.status === 'active' && ref.teams.some((t) => t.lead_id === e.id)).sort((a, b) => a.full_name.localeCompare(b.full_name));
  const list = (evals.data ?? []) as Evaluation[];

  // pre-fill the exclusion lists with active CAMs who had no audits this week
  useEffect(() => {
    if (!evals.data) return;
    const teams = scorecardTeams(list, ref.employees, ref.teams, chatLead || null);
    setExcl(Object.fromEntries(teams.map((t) => [t.key, t.notAudited.map((e) => e.email).join('\n')])));
  }, [evals.data, chatLead]); // eslint-disable-line react-hooks/exhaustive-deps

  const next = ref.periods.find((p) => p.start_date > period.start_date);
  const mail = useMemo(() => (evals.data ? buildScorecard({ period, evals: list, employees: ref.employees, teams: ref.teams, parameters: ref.parameters,
    taskTypes: ref.taskTypes, settings: s, chatLeadId: chatLead || null, exclusions: excl, nextWeekLabel: next?.short_label ?? 'next week' }) : null),
  [evals.data, excl, chatLead, period, ref, s, next]); // eslint-disable-line react-hooks/exhaustive-deps
  const count = (v: string) => v.split(/[\s,;]+/).filter(Boolean).length;

  const openInBrowser = () => {
    if (!mail) return;
    const doc = `<!doctype html><html><head><meta charset="utf-8"><title>${mail.subject.replace(/</g, '&lt;')}</title></head><body style="margin:24px;background:#fff">` +
      `<div style="font-family:Arial,sans-serif;font-size:13px;color:#555;margin-bottom:14px;border-bottom:1px solid #ddd;padding-bottom:10px"><b style="font-size:16px;color:#222">${mail.subject.replace(/</g, '&lt;')}</b><br>From: ${cfg.from_name} &lt;${cfg.from_email || 'your Gmail'}&gt;<br>To: ${to.replace(/</g, '&lt;')}${cc ? `<br>Cc: ${cc.replace(/</g, '&lt;')}` : ''}</div>${mail.html}</body></html>`;
    const url = URL.createObjectURL(new Blob([doc], { type: 'text/html' }));
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  const saveDefaults = async () => {
    try { await repo.updateSetting('scorecard', { ...cfg, to: to.trim(), cc: cc.trim(), chat_lead_id: chatLead || null }); await reloadRef(); toast('Saved as the default recipients and Chat Team lead.'); }
    catch (e) { toast(e instanceof Error ? e.message : String(e), 'bad'); }
  };
  const send = async () => {
    if (!mail) return;
    setBusy(true); setErr(null);
    try {
      await repo.queueScorecard(period.id, { subject: mail.subject, html: mail.html, text: mail.text, to, cc });
      toast(isDemo ? 'Scorecard sent (demo: not delivered).' : 'Scorecard queued. Your Google Sheet script sends it within about a minute.');
      setConfirm(false);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const last = history.data?.[0];

  return (
    <Card title="Weekly scorecard (overall)" subtitle={`Task Audit Scorecard for ${period.short_label} — CS Team and Chat Team tables, highlights and autofails, built from the audits.`}
      actions={<>
        <Button variant="secondary" disabled={!mail} onClick={openInBrowser}><ExternalLink className="h-4 w-4" />Open in browser</Button>
        <Button disabled={!mail || isLocal || period.status !== 'published' || !to.trim()} onClick={() => { setTicked(false); setErr(null); setConfirm(true); }}><Send className="h-4 w-4" />Send scorecard…</Button>
      </>}>
      {evals.loading ? <Loading /> : (
        <div className="flex flex-col gap-4">
          <ErrorBox error={evals.error} />
          {last && <p className="text-[13px]">Last sent {fmtDateTime(last.created_at)} by {last.created_by_name ?? 'QA'} · <Pill tone={last.status === 'sent' ? 'good' : last.status === 'failed' ? 'bad' : 'info'}>{last.status === 'sent' ? 'Sent' : last.status === 'failed' ? 'Failed' : 'Queued'}</Pill>{last.last_error && <span className="ml-2 text-bad">{last.last_error}</span>}</p>}
          <div className="grid gap-3 lg:grid-cols-2">
            <Field label={`To (${count(to)})`} htmlFor="sc-to"><textarea id="sc-to" rows={3} className={textareaCls} value={to} onChange={(e) => setTo(e.target.value)} /></Field>
            <Field label={`Cc (${count(cc)})`} htmlFor="sc-cc"><textarea id="sc-cc" rows={3} className={textareaCls} value={cc} onChange={(e) => setCc(e.target.value)} /></Field>
            <Field label="Chat Team = CAMs of this Team Lead" htmlFor="sc-lead"><select id="sc-lead" className={inputCls} value={chatLead} onChange={(e) => setChatLead(e.target.value)}>
              <option value="">No Chat Team table</option>{leads.map((l) => <option key={l.id} value={l.id}>{l.full_name}</option>)}</select></Field>
            <div className="text-[12.5px] text-muted">From: <strong className="text-ink">{cfg.from_name} &lt;{cfg.from_email || 'your Gmail'}&gt;</strong>
              {isSuper && <div className="mt-2"><Button size="sm" variant="ghost" onClick={saveDefaults}>Save To, Cc and Chat Team lead as default</Button></div>}</div>
            {Object.keys(excl).map((k) => (
              <Field key={k} label={`Exclusion list · ${k === 'cs' ? 'CS Team' : 'Chat Team'} (not audited this week — edit as needed)`} htmlFor={`sc-ex-${k}`}>
                <textarea id={`sc-ex-${k}`} rows={3} className={textareaCls} value={excl[k]} onChange={(e) => setExcl({ ...excl, [k]: e.target.value })} /></Field>
            ))}
          </div>
          {mail && <iframe title="Scorecard preview" sandbox="" className="h-[520px] w-full rounded border border-line bg-white" srcDoc={`<body style="margin:12px">${mail.html}</body>`} />}
          {period.status !== 'published' && <p className="text-[12.5px] text-warn">Publish {period.short_label} before sending its scorecard.</p>}
        </div>
      )}
      <Modal open={confirm} title={`Send the ${period.short_label} scorecard?`} onClose={() => setConfirm(false)} footer={<>
        <Button variant="secondary" onClick={() => setConfirm(false)}>Cancel</Button>
        <Button loading={busy} disabled={!ticked} onClick={send}>Yes, send scorecard</Button></>}>
        <div className="flex flex-col gap-3 text-sm">
          <p><strong>{mail?.subject}</strong></p>
          <p>From <strong>{cfg.from_name} &lt;{cfg.from_email || 'your Gmail'}&gt;</strong> to <strong>{count(to)}</strong> recipient(s){count(cc) ? <>, CC <strong>{count(cc)}</strong></> : null}. It can’t be recalled once sent.</p>
          <div className="max-h-40 overflow-auto rounded border border-line p-2 text-[12.5px] text-muted">To: {to}{cc ? <><br />Cc: {cc}</> : null}</div>
          <label className="flex items-start gap-2 font-medium"><input type="checkbox" className="mt-1" checked={ticked} onChange={(e) => setTicked(e.target.checked)} />
            I have checked the preview and the recipients, and I want to send this scorecard now.</label>
          <ErrorBox error={err} />
        </div>
      </Modal>
    </Card>
  );
}
