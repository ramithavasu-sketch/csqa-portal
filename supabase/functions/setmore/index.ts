// Two-way sync of feedback-session bookings with Setmore.
//   sync          Setmore → portal, every 5 minutes (database scheduler)
//   push_booking  portal → Setmore: a time entered or changed in the portal becomes a Setmore
//                 appointment (Setmore's API can't move one, so a change books the new slot and
//                 labels the old one "Cancelled")
//   set_label     portal → Setmore: cancelled in the portal → "Cancelled", completed → "Complete"
// Called by the database (header x-cron = app_secrets.setmore_cron), or for a check
// (header x-probe = settings.setmore.probe_nonce, body {"action":"preview"}).
import { cors, json, serviceClient, HttpError } from '../_shared/auth.ts';
import { setmoreGet, setmoreToken, smDate } from '../_shared/setmore.ts';

// Setmore returns the account's local time (India) with a 'Z' on the end: read it as local time.
const TZ_OFFSET = Deno.env.get('SETMORE_TZ_OFFSET') ?? '+05:30';
const localTime = (t: string) => String(t ?? '').replace(/(Z|[+-]\d\d:\d\d)$/, '') + TZ_OFFSET;

type Appt = { key: string; start_time: string; staff_key: string; service_key: string; label?: string; customer?: { email_id?: string } };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
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
    // the CAM (or QA) picking a slot inside the portal: signed-in user
    let caller: { id: string; role: string } | null = null;
    if (!byCron && !byProbe) {
      if (body.action !== 'slots' && body.action !== 'book') throw new HttpError(401, 'Not allowed');
      const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
      const { data: u } = await sb.auth.getUser(jwt);
      const { data: emp } = u?.user ? await sb.from('employees').select('id, role, status').eq('auth_user_id', u.user.id).maybeSingle() : { data: null };
      if (!emp || emp.status !== 'active') throw new HttpError(401, 'Please sign in again');
      caller = emp as { id: string; role: string };
    }

    // which Setmore service is the feedback session: the one in the booking link (products=<key>)
    const bookingUrl = String((fb?.value as { booking_url?: string } | undefined)?.booking_url ?? '');
    const serviceKey = /products=([0-9a-f-]{36})/i.exec(bookingUrl)?.[1];
    if (!serviceKey) throw new HttpError(422, 'The Setmore booking link in Feedback Sessions settings has no service key');

    const token = await setmoreToken();
    const staffs = await setmoreGet(token, '/bookingapi/staffs');
    const staffEmail = new Map<string, string>();
    for (const s of ((staffs.body?.data?.staffs ?? []) as { key: string; email_id?: string }[])) staffEmail.set(s.key, String(s.email_id ?? '').toLowerCase());

    const send = async (method: string, path: string, payload?: unknown) => {
      const r = await fetch(`https://developer.setmore.com/api/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: payload ? JSON.stringify(payload) : undefined });
      return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) };
    };
    const setLabel = (key: string, label: string) => send('PUT', `/bookingapi/appointments/${key}/label?label=${encodeURIComponent(label)}`);
    const ist = (t: number) => new Date(t + 330 * 60000).toISOString().slice(0, 16) + 'Z';   // Setmore expects local (India) time
    const readAppointments = async (from: Date, to: Date) => {
      const all: Appt[] = [];
      let cursor = '';
      for (let page = 0; page < 30; page++) {
        const q = `/bookingapi/appointments?startDate=${smDate(from)}&endDate=${smDate(to)}&customerDetails=true${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const r = await setmoreGet(token, q);
        if (r.status !== 200) throw new HttpError(502, `Setmore appointments request failed (${r.status})`);
        const list = (r.body?.data?.appointments ?? []) as Appt[];
        all.push(...list);
        cursor = r.body?.data?.cursor ?? '';
        if (!cursor || !list.length) break;
      }
      return all.filter((a) => a.service_key === serviceKey).map((a) => ({
        key: a.key, start: localTime(a.start_time), staff_email: staffEmail.get(a.staff_key) ?? '', customer_email: String(a.customer?.email_id ?? '').toLowerCase(), label: a.label ?? '' }));
    };
    const serviceMinutes = async () => {
      const services = await setmoreGet(token, '/bookingapi/services');
      return Number(((services.body?.data?.services ?? []) as { key: string; duration?: number }[]).find((x) => x.key === serviceKey)?.duration) || 60;
    };
    type Sess = { id: string; cam_id: string; status: string; booked_for: string | null; setmore_key: string | null; cam: { full_name: string; email: string }; provider: { email: string; full_name: string } | null; cycle: { released_at: string | null } };
    const loadSession = async (id: string) => {
      const { data } = await sb.from('feedback_sessions').select('id, cam_id, status, booked_for, setmore_key, cam:cam_id(full_name, email), provider:provider_id(email, full_name), cycle:cycle_id(released_at)').eq('id', id).maybeSingle();
      return data as unknown as Sess | null;
    };
    // slots the QA provider has free on a day (Setmore's own availability), as times in India
    const freeSlots = async (staffKey: string, day: string) => {
      const [y, m, d] = day.split('-');
      const r = await send('POST', '/bookingapi/slots', { staff_key: staffKey, service_key: serviceKey, selected_date: `${d}/${m}/${y}`, off_hours: false, double_booking: false, slot_limit: await serviceMinutes(), timezone: 'Asia/Kolkata' });
      const to24 = (t: string) => {   // "3:00 PM" -> "15:00"
        const m2 = /^(\d{1,2})[:.](\d{2})\s*(AM|PM)?$/i.exec(String(t).trim());
        if (!m2) return '';
        let h = Number(m2[1]) % (m2[3] ? 12 : 24);
        if (m2[3]?.toUpperCase() === 'PM') h += 12;
        return `${String(h).padStart(2, '0')}:${m2[2]}`;
      };
      return { r, slots: ((r.body?.data?.slots ?? []) as string[]).map(to24).filter(Boolean) };
    };

    if (body.action === 'slots' || body.action === 'book') {
      const { session, date, time } = body as { session?: string; date?: string; time?: string };
      const sess = await loadSession(String(session ?? ''));
      if (!sess || !sess.cycle?.released_at) throw new HttpError(404, 'Feedback session not found');
      const isQa = byCron || ['super_admin', 'evaluator'].includes(caller?.role ?? '');
      if (!isQa && caller?.id !== sess.cam_id) throw new HttpError(403, 'Only the CAM (or QA) can book this session');
      if (sess.status === 'completed') throw new HttpError(400, 'This feedback session is already completed');
      const provider = String(sess.provider?.email ?? '').toLowerCase();
      const staffKey = [...staffEmail.entries()].find(([, e]) => e === provider)?.[0];
      if (!staffKey) throw new HttpError(422, `${sess.provider?.full_name ?? 'The QA provider'} isn't set up as staff in Setmore yet — ask QA`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new HttpError(400, 'Choose a date');
      const { r, slots } = await freeSlots(staffKey, String(date));
      if (body.action === 'slots') {
        if (!r.ok) throw new HttpError(502, `Setmore couldn't list free slots (${r.status}: ${r.body?.msg ?? ''})`);
        const now = Date.now();
        return json({ provider: sess.provider?.full_name, slots: slots.filter((t) => Date.parse(`${date}T${t}:00+05:30`) > now + 30 * 60000), ...(byCron ? { raw: r.body } : {}) });
      }
      if (!/^\d{2}:\d{2}$/.test(String(time)) || !slots.includes(String(time))) throw new HttpError(409, 'That slot was just taken — please choose another');
      const want = Date.parse(`${date}T${time}:00+05:30`);
      const camEmail = sess.cam.email.toLowerCase();
      const [first, ...rest] = sess.cam.full_name.split(' ');
      const found = await setmoreGet(token, `/bookingapi/customer?firstname=${encodeURIComponent(first)}&email=${encodeURIComponent(camEmail)}`);
      let customerKey = ((found.body?.data?.customer ?? []) as { key: string; email_id?: string }[]).find((c) => String(c.email_id ?? '').toLowerCase() === camEmail)?.key;
      if (!customerKey) {
        const c = await send('POST', '/bookingapi/customer/create', { first_name: first, last_name: rest.join(' '), email_id: camEmail });
        customerKey = c.body?.data?.customer?.key;
        if (!customerKey) throw new HttpError(502, `Couldn't add you as a Setmore customer (${c.status})`);
      }
      const mins = await serviceMinutes();
      const ap = await send('POST', '/bookingapi/appointment/create', { staff_key: staffKey, service_key: serviceKey, customer_key: customerKey,
        start_time: ist(want), end_time: ist(want + mins * 60000), cost: 0, comment: 'Booked in the CS QA portal' });
      const key = ap.body?.data?.appointment?.key as string | undefined;
      if (!key) throw new HttpError(502, `Setmore didn't accept the booking (${ap.status}: ${ap.body?.msg ?? ''})`);
      // a rebooking: the CAM's earlier appointment for this cycle is labelled Cancelled
      const released = Date.parse(sess.cycle.released_at);
      const old = (await readAppointments(new Date(released - 86400000), new Date(Date.now() + 120 * 86400000)))
        .filter((x) => x.customer_email === camEmail && x.key !== key && Date.parse(x.start) >= released - 86400000 && !/cancel|no.?show/i.test(x.label));
      for (const x of old) await setLabel(x.key, 'Cancelled');
      await sb.from('feedback_sessions').update({ status: 'booked', booked_for: new Date(want).toISOString(), booked_at: new Date().toISOString(), booking_source: 'portal',
        setmore_key: key, booked_with_email: provider, updated_at: new Date().toISOString() }).eq('id', sess.id);
      return json({ ok: true, booked_for: new Date(want).toISOString(), provider: sess.provider?.full_name, replaced: old.length });
    }

    // window: from 7 days before the oldest open cycle (max 90 days back) to 120 days ahead
    const { data: cyc } = await sb.from('feedback_cycles').select('released_at').not('released_at', 'is', null).order('number', { ascending: false }).limit(2);
    const oldest = (cyc ?? []).map((c) => Date.parse(c.released_at as string)).sort()[0] ?? Date.now();
    const from = new Date(Math.max(oldest - 7 * 86400000, Date.now() - 90 * 86400000));
    const to = new Date(Date.now() + 120 * 86400000);

    const rows = await readAppointments(from, to);

    if (body.action === 'set_label' && byCron) {
      const { key, label } = body as { key?: string; label?: string };
      if (!/^[0-9a-f-]{36}$/i.test(String(key)) || !['Cancelled', 'Complete'].includes(String(label))) throw new HttpError(400, 'Bad label request');
      const r = await setLabel(String(key), String(label));
      return json({ ok: r.ok, status: r.status, msg: r.body?.msg });
    }

    if (body.action === 'push_booking' && byCron) {
      const id = String((body as { session?: string }).session ?? '');
      const { data: ss } = await sb.from('feedback_sessions').select('id, status, booked_for, setmore_key, cam:cam_id(full_name, email), provider:provider_id(email), cycle:cycle_id(released_at)').eq('id', id).maybeSingle();
      const sess = ss as unknown as { id: string; status: string; booked_for: string | null; setmore_key: string | null; cam: { full_name: string; email: string }; provider: { email: string } | null; cycle: { released_at: string } } | null;
      if (!sess || sess.status !== 'booked' || !sess.booked_for) return json({ ok: true, skipped: 'not booked' });
      const camEmail = sess.cam.email.toLowerCase();
      const want = Date.parse(sess.booked_for);
      const mine = rows.filter((r) => r.customer_email === camEmail && Date.parse(r.start) >= Date.parse(sess.cycle.released_at) - 86400000 && !/cancel|no.?show/i.test(r.label));
      const fail = async (why: string) => {
        await sb.from('settings').update({ value: { ...(st?.value as object ?? {}), last_push_error: { at: new Date().toISOString(), cam: camEmail, error: why } } }).eq('key', 'setmore');
        return json({ ok: false, error: why });
      };
      let key = mine.find((r) => Date.parse(r.start) === want)?.key;
      let staffMail = mine.find((r) => r.key === key)?.staff_email;
      if (!key) {
        const provider = String(sess.provider?.email ?? '').toLowerCase();
        const staffKey = [...staffEmail.entries()].find(([, e]) => e === provider)?.[0];
        if (!staffKey) return fail(`The QA provider (${provider || 'none'}) is not a staff member in Setmore`);
        const [first, ...rest] = sess.cam.full_name.split(' ');
        const found = await setmoreGet(token, `/bookingapi/customer?firstname=${encodeURIComponent(first)}&email=${encodeURIComponent(camEmail)}`);
        let customerKey = ((found.body?.data?.customer ?? []) as { key: string; email_id?: string }[]).find((c) => String(c.email_id ?? '').toLowerCase() === camEmail)?.key;
        if (!customerKey) {
          const c = await send('POST', '/bookingapi/customer/create', { first_name: first, last_name: rest.join(' '), email_id: camEmail });
          customerKey = c.body?.data?.customer?.key;
          if (!customerKey) return fail(`Couldn't add ${camEmail} as a Setmore customer (${c.status})`);
        }
        const mins = await serviceMinutes();
        const ap = await send('POST', '/bookingapi/appointment/create', { staff_key: staffKey, service_key: serviceKey, customer_key: customerKey,
          start_time: ist(want), end_time: ist(want + mins * 60000), cost: 0, comment: 'Booked from the CS QA portal' });
        key = ap.body?.data?.appointment?.key;
        if (!key) return fail(`Setmore didn't create the appointment (${ap.status}: ${ap.body?.msg ?? ''})`);
        staffMail = provider;
      }
      // the CAM's other appointments for this cycle (the old time) are labelled Cancelled
      for (const r of mine) if (r.key !== key) await setLabel(r.key, 'Cancelled');
      await sb.from('feedback_sessions').update({ setmore_key: key, booked_with_email: staffMail ?? null }).eq('id', sess.id);
      return json({ ok: true, key, replaced: mine.filter((r) => r.key !== key).length });
    }

    if (body.action === 'preview') return json({ window: [from.toISOString(), to.toISOString()], feedback_sessions: rows.length, rows });

    const res = await sb.rpc('apply_setmore_appointments', { p_rows: rows, p_from: from.toISOString() });
    if (res.error) throw new HttpError(500, res.error.message);
    await sb.from('settings').update({ value: { ...(st?.value as object ?? {}), connected: true, last_sync_at: new Date().toISOString(), last_sync: res.data } }).eq('key', 'setmore');
    return json({ ok: true, ...(res.data as object) });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, e instanceof HttpError ? e.status : 500);
  }
});
