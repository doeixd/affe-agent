import * as Failpoint from "../internal/failpoint.js"

/**
 * The two durable boundaries of a dispatched job (item 47c): after its
 * submission is launched and its intent says so, and after the run's
 * settlement has committed but before the platform acknowledged the alarm.
 * `test/WorkerDispatchIntents.test.ts` kills the runtime at each on workerd
 * and shows the job ran exactly once either way.
 *
 * Its own module, with no Workers types, so a Node test can name the
 * locations without loading the host.
 */
export const dispatchFailpoints = Failpoint.group("CloudflareDispatch", ["after-launch", "after-settlement"])
