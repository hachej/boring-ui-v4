// Scheduled tasks on Cloudflare: the backend of schedules.mjs bound to agents' own `Scheduler` (agents/schedules, experimental),
// a LifecycleCapability installed on the object's existing Lifecycle, so its jobs share the one alarm and job loop. This adds no
// alarm, table or registry of its own: each schedule is one Scheduler job whose payload is the schedule record (without its id,
// which is the job id). One callback, `wake`, registered when the object is constructed, as the Scheduler requires.
import { Scheduler } from 'agents/schedules';

const WAKE = 'wake';
const recordOf = schedule => { const { key: _key, ...record } = schedule.payload ?? {}; return { id: schedule.id, ...record }; };

/**
 * @param {object} options
 * @param {(record: import('./schedules.mjs').ScheduleRecord, due: number) => Promise<unknown>} options.onDue runs one due occurrence
 *   (`fireSchedule`); a throw is retried by the Scheduler (3 attempts) and the request ID keeps a retry from submitting twice
 */
export function createCloudflareSchedules({ onDue }) {
  const scheduler = new Scheduler({
    callbacks: { [WAKE]: (payload, schedule) => onDue(recordOf({ id: schedule.id, payload }), schedule.time * 1000) },
    onError: error => console.error('scheduled task failed', String(error?.message ?? error).slice(0, 200)),
  });
  const ours = async () => (await scheduler.list()).filter(schedule => schedule.callback === WAKE);
  /** @type {import('./schedules.mjs').ScheduleBackend} */
  const backend = {
    set: async (record, { key }) => {
      // A replayed tool call finds the schedule it already made.
      const existing = (await ours()).find(schedule => schedule.payload?.key === key);
      if (existing) return recordOf(existing);
      // The cron given to the Scheduler is the UTC superset; `fireSchedule` keeps only the local occurrences.
      const when = record.when.kind === 'cron' ? record.when.utc : new Date(record.when.at);
      return recordOf(await scheduler.set(when, WAKE, { ...record, key }, { idempotent: false }));
    },
    list: async () => (await ours()).map(recordOf),
    cancel: async id => (await scheduler.get(id))?.callback === WAKE ? scheduler.cancel(id) : false,
  };
  return { scheduler, backend };
}
