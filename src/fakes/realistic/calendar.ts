/**
 * Team calendar. Virtual time 0 is Monday 00:00 in the team's time zone; people work
 * Monday–Friday 09:00–18:00, and production rollouts pause over the weekend.
 */
import { DAY, HOUR } from '../../core/time.js';

export const WORK_START_H = 9;
export const WORK_END_H = 18;

/** 0 = Monday … 6 = Sunday. */
export const dayOfWeek = (t: number) => Math.floor(t / DAY) % 7;
export const hourOfDay = (t: number) => (t % DAY) / HOUR;
export const isWeekend = (t: number) => dayOfWeek(t) >= 5;
export const isWorkingTime = (t: number) => !isWeekend(t) && hourOfDay(t) >= WORK_START_H && hourOfDay(t) < WORK_END_H;

/** The next moment working hours begin, strictly after `t` unless `t` is before 09:00 on a weekday. */
export function nextWorkStart(t: number) {
  let start = Math.floor(t / DAY) * DAY + WORK_START_H * HOUR;
  if (t >= start) start += DAY;
  while (isWeekend(start)) start += DAY;
  return start;
}

/** The time at which `ms` of working time has passed after `t` (a person's response time). */
export function afterWorkingTime(t: number, ms: number) {
  let now = t, left = ms;
  for (;;) {
    if (!isWorkingTime(now)) { now = nextWorkStart(now); continue; }
    const blockEnd = Math.floor(now / DAY) * DAY + WORK_END_H * HOUR;
    if (now + left <= blockEnd) return now + left;
    left -= blockEnd - now;
    now = blockEnd;
  }
}

/** The time at which `ms` of weekday time has passed after `t` (rollout waves don't run on weekends). */
export function afterWeekdayTime(t: number, ms: number) {
  let now = t, left = ms;
  for (;;) {
    if (isWeekend(now)) { now = (Math.floor(now / DAY) + 7 - dayOfWeek(now)) * DAY; continue; }
    const dayEnd = (Math.floor(now / DAY) + 1) * DAY;
    if (now + left <= dayEnd) return now + left;
    left -= dayEnd - now;
    now = dayEnd;
  }
}

/** Daily release cut: weekdays at 18:00, the next one after `t`. */
export function nextReleaseCut(t: number) {
  let cut = Math.floor(t / DAY) * DAY + 18 * HOUR;
  if (t >= cut) cut += DAY;
  while (isWeekend(cut)) cut += DAY;
  return cut;
}
