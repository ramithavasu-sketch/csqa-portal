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
export function scorecardTeams(evals: Evaluation[], employees: Employee[], teams: Team[], chatLeadId: string | null, members?: string[] | null): ScorecardTeam[] {
  const chatTeamIds = new Set(teams.filter((t) => chatLeadId && t.lead_id === chatLeadId).map((t) => t.id));
  const isChat = (e: Employee | undefined) => !!e?.team_id && chatTeamIds.has(e.team_id);
  const byId = new Map(employees.map((e) => [e.id, e]));
  // with the sheet's Team List: only its CAMs count, and its CAMs without audits are the exclusions
  const list = members?.length ? new Set(members.map((m) => m.toLowerCase())) : null;
  if (list) evals = evals.filter((e) => list.has((e.cam_email ?? '').toLowerCase()));
  const audited = new Set(evals.map((e) => e.cam_id));
  const cams = (chat: boolean) => (list
    ? [...list].map((m) => employees.find((e) => e.email.toLowerCase() === m) ?? ({ id: m, email: m, full_name: m, role: 'user', status: 'active', team_id: null } as Employee))
    : employees.filter((e) => e.status === 'active' && e.role === 'user' && !e.is_demo)).filter((e) => isChat(e) === chat);
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
  settings: PortalSettings; chatLeadId: string | null; exclusions: Record<string, string>; nextWeekLabel: string; members?: string[] | null;
}) {
  const s = o.settings;
  const teams = scorecardTeams(o.evals, o.employees, o.teams, o.chatLeadId, o.members);
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

/**
 * New layout: headline cards, team summary, CAMs needing attention, top issues,
 * autofails with full QA feedback, top performers and who wasn't audited.
 * Same numbers as the classic grid (an autofail counts as a miss on every parameter).
 */
export function buildScorecardSummary(o: Parameters<typeof buildScorecard>[0]) {
  const s = o.settings;
  const teams = scorecardTeams(o.evals, o.employees, o.teams, o.chatLeadId, o.members);
  const link = reportLink(s, o.period);
  const all = teams.flatMap((t) => t.evals);
  const avg = (l: Evaluation[]) => (l.length ? l.reduce((a, e) => a + Number(e.score), 0) / l.length : null);
  const isMiss = (e: Evaluation, p: Parameter) => e.task_type === p.task_type && e.scores.some((x) => x.parameter_id === p.id && x.earned !== null && (e.autofail || Number(x.earned) < Number(x.max_score)));
  const typeShort = (code: string) => ({ ER: 'Email', CHAT: 'Chat', IB_CALL: 'Calls', INTERNAL: 'Internal' } as Record<string, string>)[code] ?? (o.taskTypes.find((t) => t.code === code)?.name ?? code);
  const issues = (list: Evaluation[]) => o.parameters.map((p) => {
    const n = list.filter((e) => e.task_type === p.task_type).length;
    const m = list.filter((e) => isMiss(e, p)).length;
    return { p, n, m, pct: n ? (100 * m) / n : 0 };
  }).filter((x) => x.m > 0);
  const byCam = new Map<string, Evaluation[]>();
  for (const e of all) byCam.set(e.cam_id, [...(byCam.get(e.cam_id) ?? []), e]);
  const cams = [...byCam.values()].map((l) => ({ name: l[0].cam_name || l[0].cam_email, lead: l[0].lead_name, avg: avg(l)!, af: l.filter((e) => e.autofail).length, list: l }));
  const attention = cams.filter((c) => c.avg < 90 || c.af > 0).sort((a, b) => a.avg - b.avg);
  const perfect = cams.filter((c) => c.avg >= 100).map((c) => c.name).sort();
  const afs = all.filter((e) => e.autofail).sort((a, b) => a.audited_at.localeCompare(b.audited_at));
  const A = avg(all);

  const F = 'font-family:Arial,sans-serif;color:#222;';
  const P = `${F}font-size:14px;margin:0 0 10px;`;
  const H = `${F}font-size:15px;font-weight:bold;margin:20px 0 6px;`;
  const TH = 'padding:6px 8px;border-bottom:1px solid #ccc;font-size:12px;color:#555;text-align:left;font-weight:bold;';
  const TD = 'padding:6px 8px;border-bottom:1px solid #eee;font-size:13px;vertical-align:top;text-align:left;';
  const tbl = (inner: string) => `<table cellspacing="0" cellpadding="0" style="${F}border-collapse:collapse;width:100%;max-width:980px">${inner}</table>`;
  const scoreColor = (v: number | null) => (v === null ? '#222' : v >= s.qa_target.score ? '#1e7b34' : v >= 90 ? '#b26a00' : '#c0392b');
  const card = (label: string, value: string, sub: string, color = '#222') =>
    `<td style="padding:10px 14px;background:#f4f6f8;border-radius:6px;vertical-align:top;width:25%"><div style="${F}font-size:12px;color:#666">${esc(label)}</div><div style="${F}font-size:22px;font-weight:bold;color:${color}">${value}</div><div style="${F}font-size:12px;color:#666">${sub}</div></td>`;

  let h = `<div style="${F}font-size:14px">`;
  h += `<p style="${P}">Hello all,</p><p style="${P}">Here is the QA summary for <b>${esc(o.period.label)}</b>. Full CAM and parameter details are in the <a href="${esc(link)}" style="color:#1155cc">CS QA Portal</a>.</p>`;
  h += `<table cellspacing="8" cellpadding="0" style="border-collapse:separate;width:100%;max-width:980px;margin:0 -8px"><tr>`;
  h += card('Tasks reviewed', String(all.length), teams.filter((t) => t.evals.length).map((t) => `${t.key === 'cs' ? 'CS' : 'Chat'} ${t.evals.length}`).join(' · '));
  h += card('Overall QA score', pct2(A), `target ${s.qa_target.score}% ${A !== null && A >= s.qa_target.score ? '✓' : ''}`, scoreColor(A));
  h += card('Autofails', String(afs.length), teams.filter((t) => t.evals.length).map((t) => `${t.key === 'cs' ? 'CS' : 'Chat'} ${t.evals.filter((e) => e.autofail).length}`).join(' · '), afs.length ? '#c0392b' : '#1e7b34');
  h += card('Perfect 100%', String(perfect.length), 'CAMs', '#1e7b34');
  h += '</tr></table>';

  h += `<p style="${H}">Team summary</p>`;
  h += tbl(`<tr><td style="${TH}">Team</td><td style="${TH}">CAMs</td><td style="${TH}">Tasks</td><td style="${TH}">Score</td><td style="${TH}">Autofails</td><td style="${TH}">Most missed</td></tr>` +
    teams.filter((t) => t.evals.length).map((t) => {
      const top = issues(t.evals).sort((a, b) => b.m - a.m)[0];
      const v = avg(t.evals);
      return `<tr><td style="${TD}">${t.title === 'CS TEAM' ? 'CS Team' : 'Chat Team'}</td><td style="${TD}">${t.camIds.size}</td><td style="${TD}">${t.evals.length}</td><td style="${TD}color:${scoreColor(v)};font-weight:bold">${pct2(v)}</td><td style="${TD}">${t.evals.filter((e) => e.autofail).length}</td><td style="${TD}">${top ? `${esc(typeShort(top.p.task_type))} · ${esc(top.p.name)} (${top.m} of ${top.n})` : '—'}</td></tr>`;
    }).join(''));

  h += `<p style="${H}">Needs attention <span style="font-weight:normal;font-size:12px;color:#666">(below 90% or an autofail)</span></p>`;
  h += attention.length ? tbl(`<tr><td style="${TH}">CAM</td><td style="${TH}">Team Lead</td><td style="${TH}">Score</td><td style="${TH}">Autofail</td><td style="${TH}">Most missed</td></tr>` +
    attention.map((c) => {
      const top = issues(c.list.filter((e) => !e.autofail)).sort((a, b) => b.m - a.m)[0];
      return `<tr><td style="${TD}">${esc(c.name)}</td><td style="${TD}">${esc(c.lead ?? '—')}</td><td style="${TD}color:${scoreColor(c.avg)};font-weight:bold">${pct2(c.avg)}</td><td style="${TD}">${c.af ? `<span style="background:#fde2e1;color:#c0392b;padding:1px 6px;border-radius:4px;font-size:12px">${c.af} autofail${c.af > 1 ? 's' : ''}</span>` : ''}</td><td style="${TD}">${top ? `${esc(typeShort(top.p.task_type))} · ${esc(top.p.name)} (${top.m})` : (c.af ? 'Autofail only' : '—')}</td></tr>`;
    }).join('')) : `<p style="${P}">Nobody below 90% and no autofails this week.</p>`;

  const topIssues = issues(all).sort((a, b) => b.pct - a.pct || b.m - a.m).slice(0, 5);
  if (topIssues.length) {
    h += `<p style="${H}">Top issues this week <span style="font-weight:normal;font-size:12px;color:#666">(% of that task type's tasks)</span></p>`;
    h += tbl(topIssues.map((x) => `<tr><td style="${TD}width:45%">${esc(typeShort(x.p.task_type))} · ${esc(x.p.name)}</td><td style="${TD}"><table cellspacing="0" cellpadding="0" style="display:inline-table;vertical-align:middle"><tr><td style="background:#f6b26b;height:8px;width:${Math.max(4, Math.round(x.pct * 3))}px;font-size:0;line-height:0">&nbsp;</td></tr></table> ${Math.round(x.pct)}% (${x.m} of ${x.n})</td></tr>`).join(''));
  }

  h += `<p style="${H}">Autofails (${afs.length})</p>`;
  h += afs.length ? tbl(`<tr><td style="${TH}">CAM</td><td style="${TH}">Type</td><td style="${TH}">Task</td><td style="${TH}">QA feedback</td></tr>` +
    afs.map((e) => `<tr><td style="${TD}white-space:nowrap">${esc(e.cam_name || e.cam_email)}</td><td style="${TD}">${esc(typeShort(e.task_type))}</td><td style="${TD}"><a href="${esc(e.task_link)}" style="color:#1155cc">${esc(e.task_id.slice(0, 8))}</a>${e.connection_id ? `<br><span style="font-size:11px;color:#666">${esc(e.connection_id)}</span>` : ''}</td><td style="${TD}white-space:pre-wrap">${esc(e.feedback ?? '')}</td></tr>`).join('')) : `<p style="${P}">No autofails this week. 🎉</p>`;

  if (perfect.length) h += `<p style="${H}">Top performers</p><p style="${P}">${perfect.length} CAM${perfect.length > 1 ? 's' : ''} scored 100%: ${perfect.map(esc).join(', ')}.</p>`;
  const excl = teams.flatMap((t) => (o.exclusions[t.key] ?? '').split(/[\n,]+/).map((x) => x.trim()).filter(Boolean).map((x) => `${esc(x)} (${t.key === 'cs' ? 'CS' : 'Chat'})`));
  if (excl.length) h += `<p style="${H}">Not audited this week</p><p style="${P}">${excl.join(' · ')}</p>`;

  h += `<p style="${P}margin-top:18px">${afs.length ? `Let’s aim for zero autofails in ${esc(o.nextWeekLabel)}. ` : ''}<a href="${esc(link)}" style="color:#1155cc">Open the full ${esc(o.period.short_label)} report in the portal</a>${s.feedback?.booking_url ? ` · <a href="${esc(s.feedback.booking_url)}" style="color:#1155cc">Book your feedback session</a>` : ''}</p>`;
  h += `<p style="${P}">Regards,<br>${esc(s.report_email.sender_name || 'CS QA Team')}<br>Quality Assurance | FULL Creative</p></div>`;

  const text = `QA summary for ${o.period.label}\nTasks reviewed: ${all.length}\nOverall QA score: ${pct2(A)}\nAutofails: ${afs.length}\n` +
    afs.map((e) => `- ${e.cam_name || e.cam_email}: ${e.task_link}\n  ${e.feedback ?? ''}`).join('\n') + `\n\nFull report: ${link}\n\nRegards,\n${s.report_email.sender_name || 'CS QA Team'}\nQuality Assurance | FULL Creative\n`;
  return { subject: `Task Audit Scorecard - ${o.period.label} · ${pct2(A)} · ${afs.length} autofail${afs.length === 1 ? '' : 's'}`, html: h, text, teams };
}
