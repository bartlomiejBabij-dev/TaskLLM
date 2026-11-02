import { CronExpressionParser } from 'cron-parser';

export function nextRun(cron: string, timezone: string, after: Date = new Date()): Date {
  if (!Number.isFinite(after.getTime())) throw new Error('Invalid schedule date.');
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(after); }
  catch { throw new Error('Choose a valid IANA timezone.'); }
  // Minute precision prevents unexpectedly creating a job every second.
  if (cron.trim().split(/\s+/).length !== 5 || cron.length > 100) throw new Error('Use a five-field CRON expression (minute hour day month weekday).');
  try { return CronExpressionParser.parse(cron, { currentDate: after, tz: timezone }).next().toDate(); }
  catch { throw new Error('Invalid CRON expression or schedule has no upcoming occurrence.'); }
}
