// Scheduled tasks ("every weekday at 8, summarise my unread mail"), portable part: no Cloudflare or `agents` imports, so it can
// move into the library later. It owns the schedule record, validation (cron, time zone, host limits), the request ID rule, the
// `fire` step that turns a due schedule into one native submission, and the model's tools. Where schedules are stored and what
// wakes them is the host's `backend` (on Cloudflare: agents' Scheduler on the object's Lifecycle, see schedules-cloudflare.mjs).
//
// Time zones: the backend's cron runs in UTC. A local cron (Europe/Zurich by default) is handed to it as a UTC superset that
// covers every offset the zone uses in the next year, and `fire` runs only the occurrences that match the local cron, so
// "0 8 * * 1-5" runs at 08:00 local in summer and winter. Zones with non-hour offsets are refused for cron (use UTC there).
// Fictional content only.
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable';
import { Type } from '@earendil-works/pi-ai';
import { requireApproval } from '@boring/agent/approval';

export const SCHEDULES = Object.freeze({
  defaultTimeZone: 'Europe/Zurich',
  maxSchedules: 20,
  minIntervalMinutes: 15,
  maxPrompt: 2000,
  maxName: 80,
  /** One-shot schedules: at least this far ahead, at most this far. */
  minLeadMs: 60_000,
  maxLeadMs: 366 * 24 * 60 * 60 * 1000,
});

/**
 * @typedef {{ kind: 'cron', text: string, cron: string, utc: string } | { kind: 'at', text: string, at: string } | { kind: 'delay', text: string, seconds: number, at: string }} ScheduleWhen
 *   `cron`: the local 5-field cron and its UTC superset for the backend. `at`/`delay`: one run at the ISO instant `at`.
 * @typedef {{ id: string, name: string, prompt: string, when: ScheduleWhen, timezone: string, conversation: number, createdAt: string, approvedBy: string }} ScheduleRecord
 * @typedef {{
 *   set: (record: Omit<ScheduleRecord, 'id'>, options: { key: string }) => Promise<ScheduleRecord>,
 *   list: () => Promise<ScheduleRecord[]>,
 *   cancel: (id: string) => Promise<boolean>,
 * }} ScheduleBackend
 *   Host storage and wake-up. `set` is idempotent on `key` (the tool call ID: a replayed call never creates a second schedule).
 */

/** The native request ID of one occurrence: Pi deduplicates on it, so a re-run callback never submits twice. */
export const scheduleRequestId = (id, due) => `schedule:${id}:${due}`;

/** What the conversation receives when a schedule fires: marked, so the model knows no person just wrote it. */
export const scheduledText = record => `[Scheduled task "${record.name}" (${record.id})] ${record.prompt}`;

// ---- Time zones (Intl only) ----

const formatters = new Map();
function formatter(timeZone) {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
    formatters.set(timeZone, value);
  }
  return value;
}
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Whether `timeZone` is an IANA zone this runtime knows. */
export function validTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone) return false;
  try { formatter(timeZone); return true; } catch { return false; }
}

/** Wall clock of an instant in a zone: `{ year, month (1-12), day, hour, minute, weekday (0 = Sunday) }`. */
export function wallClock(ms, timeZone) {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute), weekday: WEEKDAYS.indexOf(parts.weekday) };
}
const wallMs = wall => Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
const sameMinute = (a, b) => a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute;
/** Offset of a zone at an instant, in minutes east of UTC. */
const offsetMinutes = (ms, timeZone) => Math.round((wallMs(wallClock(ms, timeZone)) - Math.floor(ms / 60_000) * 60_000) / 60_000);

/** The instant a local wall-clock minute happens in a zone, or undefined when it does not exist (skipped by a DST change). */
export function zonedInstant(wall, timeZone) {
  const guess = wallMs(wall);
  for (const offset of new Set([offsetMinutes(guess, timeZone), offsetMinutes(guess - 3 * 60 * 60_000, timeZone), offsetMinutes(guess + 3 * 60 * 60_000, timeZone)])) {
    const candidate = guess - offset * 60_000;
    if (sameMinute(wallClock(candidate, timeZone), wall)) return candidate;
  }
  return undefined;
}

/** Every UTC offset (minutes) a zone uses within a year from `from`. */
function zoneOffsets(timeZone, from) {
  const offsets = new Set();
  for (let ms = from; ms < from + 370 * 24 * 60 * 60_000; ms += 12 * 60 * 60_000) offsets.add(offsetMinutes(ms, timeZone));
  return [...offsets];
}

/** `2026-10-09T08:00` */
const wallText = wall => `${wall.year}-${String(wall.month).padStart(2, '0')}-${String(wall.day).padStart(2, '0')}T${String(wall.hour).padStart(2, '0')}:${String(wall.minute).padStart(2, '0')}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** `Fri 9 Oct 2026, 17:00` in the zone. */
export function localText(ms, timeZone) {
  const wall = wallClock(ms, timeZone);
  return `${WEEKDAYS[wall.weekday]} ${wall.day} ${MONTHS[wall.month - 1]} ${wall.year}, ${String(wall.hour).padStart(2, '0')}:${String(wall.minute).padStart(2, '0')}`;
}

// ---- Cron (5 fields: minute hour day-of-month month day-of-week) ----

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'], base: 1 },
  { name: 'day of week', min: 0, max: 7, names: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'], base: 0 },
];

function parseField(text, field) {
  const values = new Set();
  const number = token => {
    const named = field.names?.indexOf(token.toLowerCase());
    const value = named !== undefined && named >= 0 ? named + field.base : /^\d+$/.test(token) ? Number(token) : NaN;
    if (!(value >= field.min && value <= field.max)) throw new Error(`"${token}" is not a valid ${field.name}`);
    return value;
  };
  for (const part of text.split(',')) {
    const match = /^(\*|([0-9a-zA-Z]+)(?:-([0-9a-zA-Z]+))?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new Error(`"${part}" is not a valid ${field.name}`);
    const step = match[4] === undefined ? 1 : Number(match[4]);
    if (step < 1) throw new Error(`step "${match[4]}" must be at least 1`);
    let start = match[1] === '*' ? field.min : number(match[2]);
    const end = match[1] === '*' ? field.max : match[3] !== undefined ? number(match[3]) : match[4] !== undefined ? field.max : start;
    if (field.base === 0 && start === 7 && end !== 7) start = 0;
    if (start > end) throw new Error(`"${part}" is an empty range`);
    for (let value = start; value <= end; value += step) values.add(field.base === 0 && value === 7 ? 0 : value);
  }
  return [...values].sort((a, b) => a - b);
}

/** Parse a 5-field cron. Day of month and day of week are ORed when both are restricted (standard cron). */
export function parseCron(text) {
  const tokens = String(text).trim().split(/\s+/);
  if (tokens.length !== 5) throw new Error('A cron needs exactly 5 fields: minute hour day-of-month month day-of-week');
  const [minutes, hours, days, months, weekdays] = tokens.map((token, index) => parseField(token, FIELDS[index]));
  return { minutes, hours, days, months, weekdays, daysRestricted: days.length !== 31, weekdaysRestricted: weekdays.length !== 7 };
}

const dayMatches = (cron, year, month, day) => {
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  if (!cron.months.includes(month)) return false;
  const byDay = cron.days.includes(day), byWeekday = cron.weekdays.includes(weekday);
  return cron.daysRestricted && cron.weekdaysRestricted ? byDay || byWeekday : byDay && byWeekday;
};

/** Whether a wall-clock minute is an occurrence of a parsed cron. */
export const cronMatches = (cron, wall) => cron.minutes.includes(wall.minute) && cron.hours.includes(wall.hour) && dayMatches(cron, wall.year, wall.month, wall.day);

/** The wall-clock occurrences of a cron strictly after `after` (a wall clock), in order. */
function* cronOccurrences(cron, after) {
  const start = Date.UTC(after.year, after.month - 1, after.day);
  for (let index = 0; index < 5 * 366; index++) {
    const date = new Date(start + index * 24 * 60 * 60_000);
    const year = date.getUTCFullYear(), month = date.getUTCMonth() + 1, day = date.getUTCDate();
    if (!dayMatches(cron, year, month, day)) continue;
    for (const hour of cron.hours) for (const minute of cron.minutes) {
      const wall = { year, month, day, hour, minute };
      if (wallMs(wall) > wallMs(after)) yield wall;
    }
  }
}

/** The next instant (ms) a local cron fires after `now`, skipping minutes a DST change removes; undefined when none within five years. */
export function nextCronRun(cronText, timeZone, now) {
  for (const wall of cronOccurrences(parseCron(cronText), wallClock(now, timeZone))) {
    const at = zonedInstant(wall, timeZone);
    if (at !== undefined && at > now) return at;
  }
  return undefined;
}

/** A UTC cron that fires at every UTC minute where the local cron can match, whatever offset the zone is on. */
function utcSuperset(cron, timeZone, now) {
  const offsets = zoneOffsets(timeZone, now);
  if (offsets.some(offset => offset % 60 !== 0)) throw new Error(`${timeZone} has a UTC offset that is not whole hours; give the cron in UTC (timezone "UTC")`);
  const hours = new Set();
  let wraps = false;
  for (const hour of cron.hours) for (const offset of offsets) {
    const utc = hour - offset / 60;
    if (utc < 0 || utc > 23) wraps = true;
    hours.add(((utc % 24) + 24) % 24);
  }
  const list = (values, full) => values.length === full ? '*' : values.join(',');
  const hourField = list([...hours].sort((a, b) => a - b), 24);
  // A shifted hour that crosses midnight lands on another day: fire daily at those hours and let the local check decide.
  if (wraps) return `${list(cron.minutes, 60)} ${hourField} * * *`;
  return `${list(cron.minutes, 60)} ${hourField} ${list(cron.days, 31)} ${list(cron.months, 12)} ${list(cron.weekdays, 7)}`;
}

// ---- `when` ----

const DELAY = /^(?:in\s+)?(\d{1,6})\s*(m|min|mins|minutes?|h|hrs?|hours?|d|days?)$/i;
const ISO = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Validate `when` for one schedule: a 5-field cron (local to `timeZone`), an ISO date-time (local to `timeZone` unless it carries
 * `Z` or an offset) or a delay such as "30m", "2h", "1d". Throws an Error whose message can be shown to the model.
 * @returns {ScheduleWhen}
 */
export function parseWhen(when, timeZone, now) {
  const text = String(when ?? '').trim();
  if (!validTimeZone(timeZone)) throw new Error(`Unknown time zone "${timeZone}"; use an IANA name such as Europe/Zurich`);
  const delay = DELAY.exec(text);
  if (delay) {
    const unit = delay[2].toLowerCase()[0];
    const seconds = Number(delay[1]) * (unit === 'm' ? 60 : unit === 'h' ? 3600 : 86_400);
    return { kind: 'delay', text, seconds, at: oneShot(now + seconds * 1000, now) };
  }
  const iso = ISO.exec(text);
  if (iso) {
    let at;
    if (iso[7]) at = Date.parse(text.replace(' ', 'T'));
    else {
      const wall = { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]), hour: Number(iso[4]), minute: Number(iso[5]) };
      at = zonedInstant(wall, timeZone);
      if (at === undefined) throw new Error(`${wallText(wall)} does not exist in ${timeZone} (a daylight-saving change skips it); pick another time`);
    }
    if (!Number.isFinite(at)) throw new Error(`"${text}" is not a valid date-time`);
    return { kind: 'at', text, at: oneShot(at, now) };
  }
  if (text.split(/\s+/).length === 5 && !text.includes(':')) {
    const cron = parseCron(text);
    const runs = [];
    for (const wall of cronOccurrences(cron, wallClock(now, timeZone))) { runs.push(wallMs(wall)); if (runs.length >= 200) break; }
    if (!runs.length) throw new Error(`"${text}" never runs`);
    for (let index = 1; index < runs.length; index++) {
      if (runs[index] - runs[index - 1] < SCHEDULES.minIntervalMinutes * 60_000) throw new Error(`"${text}" runs more often than every ${SCHEDULES.minIntervalMinutes} minutes, which is not allowed`);
    }
    return { kind: 'cron', text, cron: text, utc: utcSuperset(cron, timeZone, now) };
  }
  throw new Error(`"${text}" is not a cron (5 fields), an ISO date-time (2026-10-09T17:00) or a delay (30m, 2h, 1d)`);
}

function oneShot(at, now) {
  if (at < now + SCHEDULES.minLeadMs) throw new Error('That time is in the past or less than a minute away');
  if (at > now + SCHEDULES.maxLeadMs) throw new Error('That time is more than a year away');
  return new Date(at).toISOString();
}

/** The next run of a schedule (ms), or undefined for a one-shot already due. */
export function nextRun(record, now) {
  if (record.when.kind === 'cron') return nextCronRun(record.when.cron, record.timezone, now);
  const at = Date.parse(record.when.at);
  return at >= now ? at : undefined;
}

/** One line about a schedule, for the model, the person and `GET /api/schedules` callers. */
export function describeWhen(when, timeZone, now) {
  if (when.kind === 'cron') { const next = nextCronRun(when.cron, timeZone, now); return `cron "${when.cron}" (${timeZone})${next === undefined ? '' : `, next ${localText(next, timeZone)}`}`; }
  return `once at ${localText(Date.parse(when.at), timeZone)} (${timeZone})`;
}

// ---- Firing ----

/**
 * Turn a due schedule into one native submission. `due` is the backend's due time for this occurrence (ms). A cron occurrence
 * is identified by its local wall-clock minute, so the two UTC firings of one local minute around a DST change submit once and
 * a UTC firing that is not a local occurrence submits nothing. `submit` is the host's admission path (it keeps the object's
 * wake-up and owes the reply to the conversation's channel); Pi deduplicates on the request ID, so calling `fire` twice for
 * one occurrence submits once.
 * @param {ScheduleRecord} record
 * @param {number} due
 * @param {(input: { conversation: number, requestId: string, text: string, record: ScheduleRecord }) => Promise<unknown>} submit
 * @returns {Promise<{ requestId: string } | undefined>} undefined when this firing is not an occurrence
 */
export async function fireSchedule(record, due, submit) {
  let occurrence;
  if (record.when.kind === 'cron') {
    const wall = wallClock(due, record.timezone);
    if (!cronMatches(parseCron(record.when.cron), wall)) return undefined;
    occurrence = wallText(wall);
  } else occurrence = record.when.at;
  const requestId = scheduleRequestId(record.id, occurrence);
  await submit({ conversation: record.conversation, requestId, text: scheduledText(record), record });
  return { requestId };
}

// ---- Tools ----

const result = (text, isError = false) => ({ ...(isError ? { isError: true } : {}), content: [{ type: 'text', text }] });
const clip = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * The model's tools: `schedule_task` (asks the person first, through the approval question, relayed as buttons on WhatsApp),
 * `list_schedules` and `cancel_schedule` (no approval). A scheduled run gets the same tools and approvals as any turn.
 * @param {object} options
 * @param {ScheduleBackend} options.backend
 * @param {string} [options.timeZone] default for schedules that do not name one
 * @param {(conversationId: unknown) => string} [options.approver] who approves in that conversation (stored as `approvedBy`)
 * @param {() => number} [options.now]
 */
export function createScheduleExtension({ backend, timeZone = SCHEDULES.defaultTimeZone, approver = () => 'person', now = Date.now }) {
  const parameters = Type.Object({
    name: Type.String({ minLength: 1, maxLength: SCHEDULES.maxName, description: 'Short name, e.g. "Morning mail summary".' }),
    instruction: Type.String({ minLength: 1, maxLength: SCHEDULES.maxPrompt, description: 'What to do when it runs, written as a request to yourself, e.g. "Summarise my unread mail".' }),
    when: Type.String({ minLength: 1, description: 'A 5-field cron in local time ("0 8 * * 1-5" = weekdays 08:00), a local ISO date-time ("2026-10-09T17:00") or a delay ("30m", "2h", "1d").' }),
    timezone: Type.Optional(Type.String({ description: `IANA time zone for the cron or date-time. Default ${timeZone}.` })),
  }, { additionalProperties: false });
  const check = args => { const zone = args.timezone || timeZone; return { zone, when: parseWhen(args.when, zone, now()) }; };
  const schedule = requireApproval(defineTool({
    name: 'schedule_task',
    description: 'Schedule a task that runs later in this conversation: once, or repeatedly. When it runs you receive the instruction as a message starting with [Scheduled task "<name>" (<id>)] and your answer is sent to the person. The person approves each new schedule. Use list_schedules to see existing ones.',
    parameters,
    // Idempotent on the call ID, so a replayed call never creates a second schedule.
    replay: 'safe',
    execute: async (args, api) => {
      let parsed;
      try { parsed = check(args); } catch (error) { return result(error.message, true); }
      const existing = await backend.list();
      if (existing.length >= SCHEDULES.maxSchedules) return result(`There are already ${existing.length} schedules (the limit is ${SCHEDULES.maxSchedules}); cancel one first.`, true);
      const record = await backend.set({ name: clip(args.name, SCHEDULES.maxName), prompt: String(args.instruction).trim().slice(0, SCHEDULES.maxPrompt), when: parsed.when, timezone: parsed.zone,
        conversation: Number(api.conversationId), createdAt: new Date(now()).toISOString(), approvedBy: approver(api.conversationId) }, { key: `${String(api.conversationId)}:${api.callId}` });
      return result(`Scheduled "${record.name}" (id ${record.id}): ${describeWhen(record.when, record.timezone, now())}.`);
    },
  }), {
    summarize: args => { const { zone, when } = check(args); return `"${clip(args.name, SCHEDULES.maxName)}" ${describeWhen(when, zone, now())}: ${clip(args.instruction, 300)}`; },
    // Invalid input is refused at once, without asking the person to approve something that cannot be scheduled.
    when: args => { try { check(args); return true; } catch { return false; } },
  });
  const ownedBy = (record, api) => api?.conversationId !== undefined && String(record.conversation) === String(api.conversationId);
  const list = defineTool({
    name: 'list_schedules',
    description: 'List the scheduled tasks of this conversation: id, name, when, next run and instruction.',
    parameters: Type.Object({}, { additionalProperties: false }),
    replay: 'safe',
    // Host policy inside the tool: a conversation sees (and cancels) only its own schedules, whoever reached it (a link session too).
    execute: async (_args, api) => {
      const records = (await backend.list()).filter(record => ownedBy(record, api));
      if (!records.length) return result('No scheduled tasks.');
      return result(records.map(record => `- ${record.id} "${record.name}": ${describeWhen(record.when, record.timezone, now())}. Instruction: ${clip(record.prompt, 300)}`).join('\n'));
    },
  });
  const cancel = defineTool({
    name: 'cancel_schedule',
    description: 'Cancel a scheduled task of this conversation by its id (from list_schedules).',
    parameters: Type.Object({ id: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    replay: 'safe',
    execute: async (args, api) => (await backend.list()).some(record => record.id === args.id && ownedBy(record, api)) && await backend.cancel(args.id)
      ? result(`Cancelled ${args.id}.`) : result(`No schedule with id ${args.id} in this conversation.`, true),
  });
  return defineExtension({
    name: 'boring.schedules',
    tools: [schedule, list, cancel],
    // Date only, so the prompt changes once a day, not every minute.
    sections: [section('schedules', () => {
      const today = wallClock(now(), timeZone);
      return `Scheduled tasks: schedule_task runs an instruction later (once, or on a cron) in this conversation; times are local to ${timeZone} unless the person names another zone. Today is ${WEEKDAYS[today.weekday]} ${wallText(today).slice(0, 10)} there. For "remind me Friday 17:00" give the local date-time; for "every weekday at 8" give "0 8 * * 1-5". A message starting with [Scheduled task "<name>" (<id>)] is such a run, not something the person just wrote: do the instruction and answer the person directly. A scheduled run has no more permission than any turn: actions that need the person's approval still ask.`;
    })],
  });
}
