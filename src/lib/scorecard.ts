// Weekly overall "Task Audit Scorecard" email, built from the week's audits in the
// same layout QA used to send by hand: one table per team (CS Team, Chat Team) with
// tasks, score, autofails and, per parameter, how many tasks missed it; totals,
// exclusion list, key highlights and the autofail list.
// An autofailed task counts as a miss on every parameter (same rule as parameter %).
import type { Employee, Evaluation, Parameter, Period, PortalSettings, TaskType, Team } from './types';
import { reportLink } from './email';

const esc = (s: string) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pct2 = (n: number | null) => (n === null ? '' : `${n.toFixed(2)}%`);

export interface ScorecardSettings { from_email: string; from_name: string; to: string; cc: string; chat_lead_id: string | null }
export interface ScorecardTeam {
  key: 'cs' | 'chat'; title: string; camIds: Set<string>; evals: Evaluation[];
  /** active CAMs in this team with no audits this week (pre-fills the exclusion list) */
  notAudited: Employee[];
}

/** Split the week's audits into CS Team and Chat Team (CAMs whose Team Lead is the chosen Chat Lead). */
export function scorecardTeams(evals: Evaluation[], employees: Employee[], teams: Team[], chatLeadId: string | null): ScorecardTeam[] {
  const chatTeamIds = new Set(teams.filter((t) => chatLeadId && t.lead_id === chatLeadId).map((t) => t.id));
  const isChat = (e: Employee | undefined) => !!e?.team_id && chatTeamIds.has(e.team_id);
  const byId = new Map(employees.map((e) => [e.id, e]));
  const audited = new Set(evals.map((e) => e.cam_id));
  const cams = (chat: boolean) => employees.filter((e) => e.status === 'active' && e.role === 'user' && !e.is_demo && isChat(e) === chat);
  const out: ScorecardTeam[] = [
    { key: 'cs', title: 'CS TEAM', camIds: new Set(), evals: [], notAudited: cams(false).filter((e) => !audited.has(e.id)) },
    { key: 'chat', title: 'CHAT TEAM', camIds: new Set(), evals: [], notAudited: cams(true).filter((e) => !audited.has(e.id)) },
  ];
  for (const ev of evals) {
    const t = isChat(byId.get(ev.cam_id)) ? out[1] : out[0];
    t.evals.push(ev); t.camIds.add(ev.cam_id);
  }
  return out.filter((t) => t.evals.length || t.notAudited.length);
}

interface Col { type: TaskType; params: Parameter[] }

function teamTable(t: ScorecardTeam, period: Period, cols: Col[]) {
  const th = 'border:1px solid #999;padding:4px 6px;font-size:12px;font-weight:bold;text-align:center;';
  const td = 'border:1px solid #ccc;padding:3px 6px;font-size:12px;text-align:center;';
  const byCam = new Map<string, Evaluation[]>();
  for (const e of t.evals) byCam.set(e.cam_id, [...(byCam.get(e.cam_id) ?? []), e]);
  const rows = [...byCam.values()].map((list) => {
    const avg = list.reduce((a, e) => a + Number(e.score), 0) / list.length;
    return { email: list[0].cam_email, list, avg, af: list.filter((e) => e.autofail).length };
  }).sort((a, b) => a.avg - b.avg || a.email.localeCompare(b.email));
  const missed = (list: Evaluation[], p: Parameter) => list.filter((e) => e.task_type === p.task_type
    && e.scores.some((s) => s.parameter_id === p.id && s.earned !== null && (e.autofail || Number(s.earned) < Number(s.max_score)))).length;

  let h = `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-family:Arial,sans-serif;margin:6px 0 14px">`;
  h += `<tr><td style="${th}background:#fff2cc">Week</td><td colspan="3" style="${th}background:#fff2cc">${esc(period.label)}</td></tr>`;
  h += `<tr><td style="${th}background:#6d9eeb;color:#000;min-width:200px">CAM</td><td style="${th}background:#6d9eeb">Total Task Reviewed</td><td style="${th}background:#6d9eeb">Score</td><td style="${th}background:#6d9eeb">Auto Fail</td>`;
  for (const c of cols) {
    h += `<td style="${th}background:#6d9eeb">${esc(c.type.name)}</td>`;
    for (const p of c.params) h += `<td style="${th}background:#b6d7a8;max-width:90px">${esc(p.name)} (${p.max_score})</td>`;
  }
  h += '</tr>';
  for (const r of rows) {
    h += `<tr><td style="${td}text-align:left;color:#1155cc">${esc(r.email)}</td><td style="${td}">${r.list.length}</td>`;
    h += `<td style="${td}background:${r.avg < 90 ? '#f9cb9c' : '#b7e1cd'}">${pct2(r.avg)}</td>`;
    h += `<td style="${td}${r.af ? 'background:#ffff00;' : ''}">${r.af || ''}</td>`;
    for (const c of cols) {
      const n = r.list.filter((e) => e.task_type === c.type.code).length;
      h += `<td style="${td}">${n || ''}</td>`;
      for (const p of c.params) { const m = missed(r.list, p); h += `<td style="${td}${m ? 'background:#f6b26b;' : ''}">${m || ''}</td>`; }
    }
    h += '</tr>';
  }
  const all = t.evals;
  const total = all.length;
  const avgAll = total ? all.reduce((a, e) => a + Number(e.score), 0) / total : null;
  const afAll = all.filter((e) => e.autofail).length;
  h += `<tr style="font-weight:bold"><td style="${td}text-align:left;font-weight:bold">Grand Total</td><td style="${td}font-weight:bold">${total}</td><td style="${td}font-weight:bold">${pct2(avgAll)}</td><td style="${td}font-weight:bold">${afAll}</td>`;
  for (const c of cols) {
    h += `<td style="${td}font-weight:bold">${all.filter((e) => e.task_type === c.type.code).length}</td>`;
    for (const p of c.params) h += `<td style="${td}font-weight:bold">${missed(all, p)}</td>`;
  }
  h += `</tr><tr><td style="${td}text-align:left;font-weight:bold">%Percentage</td><td style="${td}"></td><td style="${td}"></td><td style="${td}">${total ? Math.round((100 * afAll) / total) + '%' : ''}</td>`;
  for (const c of cols) {
    const n = all.filter((e) => e.task_type === c.type.code).length;
    h += `<td style="${td}"></td>`;
    for (const p of c.params) h += `<td style="${td}">${n ? Math.round((100 * missed(all, p)) / n) + '%' : ''}</td>`;
  }
  h += '</tr></table>';
  return { html: h, total, avgAll, afAll, perfect: rows.filter((r) => r.avg >= 100).length, rows };
}

export function buildScorecard(o: {
  period: Period; evals: Evaluation[]; employees: Employee[]; teams: Team[]; parameters: Parameter[]; taskTypes: TaskType[];
  settings: PortalSettings; chatLeadId: string | null; exclusions: Record<string, string>; nextWeekLabel: string;
}) {
  const s = o.settings;
  const teams = scorecardTeams(o.evals, o.employees, o.teams, o.chatLeadId);
  const types = [...o.taskTypes].sort((a, b) => a.sort_order - b.sort_order);
  const p = 'font-family:Arial,sans-serif;font-size:14px;color:#222;margin:0 0 10px';
  const link = reportLink(s, o.period);
  let html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222"><p style="${p}">Hello all,</p><p style="${p}">Kindly find below the task audit scorecard for the following week.</p>`;
  let text = `Hello all,\n\nKindly find below the task audit scorecard for ${o.period.label}.\n`;
  let totalAf = 0;
  for (const t of teams) {
    // columns: task types (and their active parameters) that have audits in this team this week
    const cols: Col[] = types.filter((ty) => t.evals.some((e) => e.task_type === ty.code)).map((ty) => ({
      type: ty, params: o.parameters.filter((x) => x.task_type === ty.code && (x.active || t.evals.some((e) => e.scores.some((sc) => sc.parameter_id === x.id && sc.earned !== null)))).sort((a, b) => a.sort_order - b.sort_order),
    }));
    html += `<p style="${p}margin-top:18px"><b><u>${t.title}:</u></b></p>`;
    if (!t.evals.length) { html += `<p style="${p}">No audits this week.</p>`; continue; }
    const tb = teamTable(t, o.period, cols);
    totalAf += tb.afAll;
    html += `<div style="overflow-x:auto">${tb.html}</div>`;
    const excl = (o.exclusions[t.key] ?? '').split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
    if (excl.length) html += `<p style="${p}"><b>Exclusion List for the ${esc(o.period.short_label)}:</b><br>${excl.map(esc).join('<br>')}</p>`;
    html += `<p style="${p}"><b>Key Highlights Overall Performance:</b></p><p style="${p}"><b>1) Overall Performance:</b></p>`;
    html += `<p style="${p}">Total Tasks Reviewed: <b>${tb.total}</b><br>Overall QA Score: <b>${pct2(tb.avgAll)}</b><br>Auto-Fail${tb.afAll === 1 ? '' : 's'}: <b>${tb.afAll}</b>`;
    if (tb.perfect) html += `<br>Top Performers: <b>${tb.perfect} CAM${tb.perfect === 1 ? '' : 's'}</b> achieved perfect 100% scores!`;
    html += '</p>';
    text += `\n${t.title}\nTotal Tasks Reviewed: ${tb.total}\nOverall QA Score: ${pct2(tb.avgAll)}\nAuto-Fails: ${tb.afAll}\n`;
    const afs = t.evals.filter((e) => e.autofail).sort((a, b) => a.audited_at.localeCompare(b.audited_at));
    if (afs.length) {
      const th = 'border:1px solid #999;padding:4px 6px;font-size:12px;font-weight:bold;background:#6d9eeb;text-align:left;';
      const td = 'border:1px solid #ccc;padding:4px 6px;font-size:12px;vertical-align:top;text-align:left;';
      html += `<p style="${p}"><b>2) Auto-Fails:</b></p><table cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-family:Arial,sans-serif;margin:0 0 12px;max-width:1100px">`;
      html += `<tr><td style="${th}">Task Type</td><td style="${th}">CAM</td><td style="${th}">DS Task Link / Conn ID</td><td style="${th}">Feedback</td></tr>`;
      for (const e of afs) {
        const tt = o.taskTypes.find((x) => x.code === e.task_type);
        html += `<tr><td style="${td}white-space:nowrap">${esc(tt?.source_label ?? e.task_type_name)}</td><td style="${td}">${esc(e.cam_email)}</td>`;
        html += `<td style="${td}"><a href="${esc(e.task_link)}" style="color:#1155cc">${esc(e.task_link)}</a>${e.connection_id ? `<br>${esc(e.connection_id)}` : ''}</td><td style="${td}">${esc(e.feedback ?? '')}</td></tr>`;
        text += `Autofail: ${e.cam_email} ${e.task_link}\n`;
      }
      html += '</table>';
    }
  }
  html += `<p style="${p}margin-top:16px">${totalAf ? `Let’s aim for zero auto-fails in ${esc(o.nextWeekLabel)}! ` : ''}Reach out with questions.</p>`;
  html += `<p style="${p}">Detailed feedback for every task is in the <a href="${esc(link)}" style="color:#1155cc">CS QA Portal</a>. Please review the comments related to your tasks.</p>`;
  if (s.feedback?.booking_url) html += `<p style="${p}">Just a reminder to schedule your feedback session using <a href="${esc(s.feedback.booking_url)}" style="color:#1155cc">this link</a>.</p>`;
  html += `<p style="${p}">Regards,<br>${esc(s.report_email.sender_name || 'CS QA Team')}<br>Quality Assurance | FULL Creative</p></div>`;
  text += `\nDetailed feedback: ${link}\n\nRegards,\n${s.report_email.sender_name || 'CS QA Team'}\nQuality Assurance | FULL Creative\n`;
  return { subject: `Task Audit Scorecard - ${o.period.label}`, html, text, teams };
}
