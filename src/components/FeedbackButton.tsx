import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { MessageSquarePlus, Star } from 'lucide-react';
import clsx from 'clsx';
import { repo, isDemo } from '../data';
import { Button, ErrorBox, Modal, textareaCls, useToast } from './ui';

const KINDS = [
  { value: 'bug', label: 'Something isn’t working' },
  { value: 'idea', label: 'Idea or suggestion' },
  { value: 'question', label: 'Question' },
  { value: 'other', label: 'Other' },
] as const;

/** "Feedback" in the top bar: anyone can tell the QA team what to fix or improve in the portal. */
export function FeedbackButton() {
  const loc = useLocation();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<(typeof KINDS)[number]['value']>('idea');
  const [rating, setRating] = useState<number | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const page = loc.pathname + (loc.search || '');
  const send = async () => {
    setBusy(true); setErr(null);
    try {
      await repo.submitFeedback({ kind, message: msg, page, rating });
      toast(isDemo ? 'Thanks! (Demo: feedback is not sent anywhere.)' : 'Thanks! Your feedback was sent to the QA team.');
      setOpen(false); setMsg(''); setRating(null); setKind('idea');
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (<>
    <button onClick={() => { setErr(null); setOpen(true); }} className="mr-1 inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] font-medium text-muted hover:bg-sunken hover:text-ink" title="Send feedback about the portal">
      <MessageSquarePlus className="h-4 w-4" /><span className="hidden sm:inline">Feedback</span>
    </button>
    {createPortal(<Modal open={open} title="Feedback about the portal" onClose={() => setOpen(false)} footer={<>
      <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
      <Button loading={busy} disabled={msg.trim().length < 5} onClick={send}>Send feedback</Button></>}>
      <div className="flex flex-col gap-4 text-sm">
        <p className="text-[13px] text-muted">Tell us what’s not working, what’s confusing or what would help. It goes to the QA team, who can reply to you by email.</p>
        <div>
          <div className="mb-1.5 text-[13px] font-medium">What is it about?</div>
          <div className="flex flex-wrap gap-2">{KINDS.map((k) => (
            <button key={k.value} type="button" onClick={() => setKind(k.value)} aria-pressed={kind === k.value}
              className={clsx('rounded-full border px-3 py-1 text-[13px]', kind === k.value ? 'border-brand bg-brand-soft font-medium text-brand' : 'border-line text-muted hover:text-ink')}>{k.label}</button>
          ))}</div>
        </div>
        <div>
          <label htmlFor="fb-msg" className="mb-1.5 block text-[13px] font-medium">Your feedback</label>
          <textarea id="fb-msg" rows={5} className={textareaCls} value={msg} maxLength={4000} onChange={(e) => setMsg(e.target.value)}
            placeholder={kind === 'bug' ? 'What were you doing, and what happened?' : 'What would make the portal better for you?'} />
        </div>
        <div>
          <div className="mb-1.5 text-[13px] font-medium">How is the portal working for you? <span className="font-normal text-muted">(optional)</span></div>
          <div className="flex gap-1" role="radiogroup" aria-label="Rating">{[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n} of 5`} onClick={() => setRating(rating === n ? null : n)}>
              <Star className={clsx('h-6 w-6', rating !== null && n <= rating ? 'fill-amber-400 text-amber-400' : 'text-faint')} />
            </button>
          ))}</div>
        </div>
        <p className="text-[12px] text-muted">We’ll include the page you’re on ({page}) so we can see what you mean.</p>
        <ErrorBox error={err} />
      </div>
    </Modal>, document.body)}
  </>);
}
