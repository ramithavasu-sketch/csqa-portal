// Setmore → portal: feedback-session bookings. Read-only towards Setmore.
// Called every 10 minutes by the database scheduler (header x-cron = app_secrets.setmore_cron),
// or for a check (header x-probe = settings.setmore.probe_nonce, body {"action":"preview"}).
import { json, serviceClient, HttpError } from '../_shared/auth.ts';
import { setmoreGet, setmoreToken, smDate } from '../_shared/setmore.ts';

// Setmore returns the account's local time (India) with a 'Z' on the end: read it as local time.
const TZ_OFFSET = Deno.env.get('SETMORE_TZ_OFFSET') ?? '+05:30';
const localTime = (t: string) => String(t ?? '').replace(/(Z|[+-]\d\d:\d\d)$/, '') + TZ_OFFSET;

type Appt = { key: string; start_time: string; staff_key: string; service_key: string; label?: string; customer?: { email_id?: string } };

Deno.serve(async (req) => {
  try {
    const sb = serviceClient();
    const body = await req.json().catch(() => ({})) as { action?: string };
    const [{ data: st }, { data: sec }, { data: fb }] = await Promise.all([
      sb.from('settings').select('value').eq('key', 'setmore').maybeSingle(),
      sb.from('app_secrets').select('value').eq('key', 'setmore_cron').maybeSingle(),
      sb.from('settings').select('value').eq('key', 'feedback').maybeSingle(),
    ]);
    const nonce = String((st?.value as { probe_nonce?: string } | undefined)?.probe_nonce ?? '');
    const cron = String(sec?.value ?? '');
    const byCron = cron.length >= 20 && req.headers.get('x-cron') === cron;
    const byProbe = nonce.length >= 20 && req.headers.get('x-probe') === nonce;
    if (!byCron && !byProbe) throw new HttpError(401, 'Not allowed');

    // which Setmore service is the feedback session: the one in the booking link (products=<key>)
    const bookingUrl = String((fb?.value as { booking_url?: string } | undefined)?.booking_url ?? '');
    const serviceKey = /products=([0-9a-f-]{36})/i.exec(bookingUrl)?.[1];
    if (!serviceKey) throw new HttpError(422, 'The Setmore booking link in Feedback Sessions settings has no service key');

    // window: from 7 days before the oldest open cycle (max 90 days back) to 120 days ahead
    const { data: cyc } = await sb.from('feedback_cycles').select('released_at').not('released_at', 'is', null).order('number', { ascending: false }).limit(2);
    const oldest = (cyc ?? []).map((c) => Date.parse(c.released_at as string)).sort()[0] ?? Date.now();
    const from = new Date(Math.max(oldest - 7 * 86400000, Date.now() - 90 * 86400000));
    const to = new Date(Date.now() + 120 * 86400000);

    const token = await setmoreToken();
    const staffs = await setmoreGet(token, '/bookingapi/staffs');
    const staffEmail = new Map<string, string>();
    for (const s of ((staffs.body?.data?.staffs ?? []) as { key: string; email_id?: string }[])) staffEmail.set(s.key, String(s.email_id ?? '').toLowerCase());

    const appts: Appt[] = [];
    let cursor = '';
    for (let page = 0; page < 30; page++) {
      const q = `/bookingapi/appointments?startDate=${smDate(from)}&endDate=${smDate(to)}&customerDetails=true${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const r = await setmoreGet(token, q);
      if (r.status !== 200) throw new HttpError(502, `Setmore appointments request failed (${r.status})`);
      const list = (r.body?.data?.appointments ?? []) as Appt[];
      appts.push(...list);
      cursor = r.body?.data?.cursor ?? '';
      if (!cursor || !list.length) break;
    }
    const rows = appts.filter((a) => a.service_key === serviceKey).map((a) => ({
      key: a.key, start: localTime(a.start_time), staff_email: staffEmail.get(a.staff_key) ?? '', customer_email: String(a.customer?.email_id ?? '').toLowerCase(), label: a.label ?? '' }));

    // a session cancelled in the portal: label its Setmore appointment "Cancelled" (called by the database)
    if (body.action === 'cancel_label' && byCron) {
      const key = String((body as { key?: string }).key ?? '');
      if (!/^[0-9a-f-]{36}$/i.test(key)) throw new HttpError(400, 'Missing appointment key');
      const r = await fetch(`https://developer.setmore.com/api/v1/bookingapi/appointments/${key}/label?label=Cancelled`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` } });
      const rb = await r.json().catch(() => null);
      return json({ ok: r.ok, status: r.status, msg: rb?.msg });
    }

    if (body.action === 'preview') return json({ window: [from.toISOString(), to.toISOString()], all: appts.length, feedback_sessions: rows.length, rows });

    const res = await sb.rpc('apply_setmore_appointments', { p_rows: rows, p_from: from.toISOString() });
    if (res.error) throw new HttpError(500, res.error.message);
    await sb.from('settings').update({ value: { ...(st?.value as object ?? {}), connected: true, last_sync_at: new Date().toISOString(), last_sync: res.data } }).eq('key', 'setmore');
    return json({ ok: true, ...(res.data as object) });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, e instanceof HttpError ? e.status : 500);
  }
});
