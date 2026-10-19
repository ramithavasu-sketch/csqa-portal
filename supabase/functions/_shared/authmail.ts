// Invitation and password emails without Supabase's own mailer: create a one-time link
// with the Admin API (no email is sent by Supabase), then queue the message in
// email_outbox for the audit sheet's Apps Script to send from the QA owner's Gmail.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { HttpError } from './auth.ts';

export async function mailSettings(admin: SupabaseClient) {
  const { data } = await admin.from('settings').select('value').eq('key', 'notifications').maybeSingle();
  const v = (data?.value ?? {}) as { mail_route?: string; portal_url?: string };
  return { viaSheet: v.mail_route === 'sheet', portalUrl: String(v.portal_url ?? '').replace(/\/+$/, '') };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

// What each role can do — shown in the invitation so people know what to expect.
const ACCESS: Record<string, { title: string; items: string[] }> = {
  user: { title: 'CAM', items: ['See your own weekly QA scores and the feedback on every audited task', 'Raise an appeal on a task within the appeal window', 'Book and track your feedback session with QA'] },
  admin: { title: 'Team Lead', items: ['See the QA results of your team and each CAM in it', 'Review your CAMs’ appeals and add your recommendation before QA decides', 'Track your team’s feedback sessions'] },
  evaluator: { title: 'QA Evaluator', items: ['See every team’s audits, dashboards and reports', 'Decide appeals and correct scores', 'Publish audit weeks and send the weekly report emails'] },
  super_admin: { title: 'Super Admin', items: ['Everything QA Evaluators can do', 'Manage users, teams, scoring and portal settings'] },
};

/** kind 'invite' for someone without a login yet, 'recovery' to set or reset the password of an existing login. */
export async function queueAuthEmail(admin: SupabaseClient, p: { email: string; name: string; kind: 'invite' | 'recovery'; portalUrl: string }) {
  if (!/^https?:\/\//.test(p.portalUrl)) throw new HttpError(400, 'Set Reporting & Settings → Notifications → Portal URL first, so the email link points at the portal.');
  const { data, error } = await admin.auth.admin.generateLink(p.kind === 'invite'
    ? { type: 'invite', email: p.email, options: { data: { must_change_password: true } } }
    : { type: 'recovery', email: p.email });
  if (error || !data?.properties?.hashed_token) throw new HttpError(400, error?.message ?? 'Could not create the link');
  // portal_url ends with '#' (hash routing), e.g. https://example.github.io/csqa-portal/#
  const link = `${p.portalUrl}/auth-confirm?type=${p.kind}&token_hash=${encodeURIComponent(data.properties.hashed_token)}`;
  const first = p.name.split(' ')[0] || p.name;
  const invite = p.kind === 'invite';
  const subject = invite ? 'You have access to the CS QA Portal' : 'Set your CS QA Portal password';
  const lead = invite ? 'You have been given access to the CS QA Portal.' : 'Use the button below to set a new password for the CS QA Portal.';
  const expiry = invite ? 'The link works once and expires in 24 hours.' : 'The link works once and expires in 1 hour. If you didn’t ask for this, you can ignore this email.';
  const { data: emp } = invite ? await admin.from('employees').select('role').eq('email', p.email.toLowerCase()).maybeSingle() : { data: null };
  const acc = emp?.role ? ACCESS[emp.role as string] : undefined;
  const accText = acc ? `\n\nYour access: ${acc.title}\n${acc.items.map((x) => `- ${x}`).join('\n')}` : '';
  const accHtml = acc ? `<p style="margin:0 0 4px"><b>Your access: ${esc(acc.title)}</b></p><ul style="margin:0 0 14px;padding-left:20px">${acc.items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
  const body_text = `Hello ${first},\n\n${lead}${accText}\n\nChoose your password here:\n${link}\n\n${expiry}\n\nCS QA Portal`;
  const body_html = `<p>Hello ${esc(first)},</p><p>${esc(lead)}</p>${accHtml}<p><a href="${esc(link)}" style="display:inline-block;padding:10px 16px;background:#0e7478;color:#fff;border-radius:6px;text-decoration:none">Choose your password</a></p><p style="color:#555">${esc(expiry)}</p><p>CS QA Portal</p>`;
  // a new link cancels the previous one, so drop any older unsent sign-in email to the same person
  await admin.from('email_outbox').delete().eq('recipient_email', p.email).eq('kind', 'auth').eq('status', 'queued');
  const { error: qe } = await admin.from('email_outbox').insert({ recipient_email: p.email, subject, body_text, body_html, kind: 'auth' });
  if (qe) throw new HttpError(500, qe.message);
}
