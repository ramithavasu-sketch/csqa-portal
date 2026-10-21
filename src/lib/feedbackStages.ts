import type { PortalFeedbackStatus } from './types';

/** Stages of a portal feedback item, in order. */
export const STAGES: { value: PortalFeedbackStatus; label: string; hint: string; tone: 'warn' | 'info' | 'brand' | 'good' | 'neutral' }[] = [
  { value: 'new', label: 'New', hint: 'Not looked at yet', tone: 'warn' },
  { value: 'planned', label: 'In pipeline', hint: 'Accepted — will be done', tone: 'info' },
  { value: 'in_progress', label: 'In progress', hint: 'Being worked on now', tone: 'brand' },
  { value: 'fixed', label: 'Fixed', hint: 'Done and live in the portal', tone: 'good' },
  { value: 'declined', label: 'Won’t do', hint: 'Not planned', tone: 'neutral' },
];
export const stageOf = (s: string) => STAGES.find((x) => x.value === s) ?? STAGES[0];
export const KIND_LABEL: Record<string, string> = { bug: 'Something isn’t working', idea: 'Idea or suggestion', question: 'Question', other: 'Other' };
