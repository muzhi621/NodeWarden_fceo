// Structured, secret-free logging for scheduled-backup ticks.
//
// Platform logs (Aliyun FC "FC Invoke Start/End", EdgeOne invocation logs) do
// not show the HTTP status or response body. A timer trigger that was rejected
// with 401 therefore looks exactly like a successful tick. Write one short line
// per tick so the result can be read straight from the platform console.
//
// Never log the secret itself: only its length is reported, which is enough to
// spot a stray space/quote in the console's "触发消息" field without leaking it.

export type CronTickStatus = 'ok' | 'rejected' | 'error';

export interface CronTickLogEntry {
  status: CronTickStatus;
  httpStatus: number;
  /** Which scheduler entry produced the tick (see SCHEDULER_SOURCE_HEADER). */
  source: string;
  /** Stable machine-readable reason; never free-form secret-bearing text. */
  reason?: string;
  providedLength?: number;
  expectedLength?: number;
  completed?: number;
  failed?: number;
  busy?: boolean;
  durationMs?: number;
}

/**
 * Header names and source labels are attacker-controlled. Keep a strict
 * allowlist so a forged header can neither inject a newline nor inject a
 * convincing `status=ok(200)` segment into the log line.
 */
function sanitize(value: string, maxLength: number): string {
  const safe = value
    .replace(/[^A-Za-z0-9_.:-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLength);
  return safe || '-';
}

export function formatCronTickLog(entry: CronTickLogEntry): string {
  const parts = [
    `[cron] status=${entry.status}(${entry.httpStatus})`,
    `source=${sanitize(entry.source, 32)}`,
  ];
  if (entry.reason) parts.push(`reason=${sanitize(entry.reason, 64)}`);
  if (entry.providedLength !== undefined) parts.push(`providedLen=${entry.providedLength}`);
  if (entry.expectedLength !== undefined) parts.push(`expectedLen=${entry.expectedLength}`);
  if (entry.completed !== undefined) parts.push(`completed=${entry.completed}`);
  if (entry.failed !== undefined) parts.push(`failed=${entry.failed}`);
  if (entry.busy !== undefined) parts.push(`busy=${entry.busy ? 'true' : 'false'}`);
  if (entry.durationMs !== undefined) parts.push(`durationMs=${entry.durationMs}`);
  return parts.join(' ');
}

export function logCronTick(entry: CronTickLogEntry, logger: Pick<Console, 'log' | 'warn' | 'error'> = console): void {
  const line = formatCronTickLog(entry);
  if (entry.status === 'ok') logger.log(line);
  else if (entry.status === 'rejected') logger.warn(line);
  else logger.error(line);
}
