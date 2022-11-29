// https://github.dev/hyurl/utils/blob/master/src/timestamp.ts
// @ts-ignore  detect global setImmediate
if (typeof setImmediate === "undefined") {
    // compatible with browsers
    var setImmediate = (cb: () => void) => setTimeout(cb, 0);
}

export default useThrottle;

/**
 * Uses throttle strategy on the given resource and returns a throttle function,
 * if a subsequent call happens within the `interval` time, the previous result
 * will be returned and the current `handle` function will not be invoked.
 * 
 * If `backgroundUpdate` is set, when reaching the `interval` time, the `handle`
 * function will be called in background and updates the result the when it's
 * done, the current call and any calls before the update will return the
 * previous result instead.
 * 
 * NOTE: this function only creates the throttle function once and uses
 * `interval` only once, any later calls on the same `resource` will return the
 * initial throttle function.
 */
function useThrottle<RET, ARGS extends any[]>(resource: any, interval: number, backgroundUpdate = false): (handle: (...args: ARGS) => RET | Promise<RET>, ...args: ARGS) => Promise<RET> {
    if (interval < 1) {
        throw new RangeError(
            "The 'interval' time for throttle must not be smaller than 1"
        );
    } else if (!useThrottle.gcTimer) {
        let { gcInterval, tasks: jobs } = useThrottle;

        useThrottle.gcTimer = setInterval(() => {
            let now = Date.now();

            jobs.forEach(({ interval, lastActive }, key) => {
                if (now - lastActive > Math.max(interval + 5, gcInterval)) {
                    jobs.delete(key);
                }
            });
        }, gcInterval);

        if (typeof useThrottle.gcTimer.unref === "function") {
            useThrottle.gcTimer.unref();
        }
    }

    let task = useThrottle.tasks.get(resource);

    if (!task) {
        useThrottle.tasks.set(
            resource,
            task = createThrottleTask(interval, backgroundUpdate)
        );
    }

    return task.func as (handle: (...args: any) => any | Promise<any>, ...args: any) => Promise<any>;
}

namespace useThrottle {
    export var gcInterval = 30000;
    export let gcTimer: any = void 0;
    export const tasks = new Map<any, ThrottleTask>();
}

type ThrottleTask = {
    interval: number;
    lastActive: number;
    cache?: { value: any, error: any; };
    queue: Set<{ resolve: (value: any) => void, reject: (err: any) => void; }>;
    func?: <RET, ARGS extends any[]>(handle: (...args: ARGS) => RET | Promise<RET>, ...args: ARGS) => Promise<RET>;
};

function createThrottleTask(
    interval: number,
    backgroundUpdate = false
): ThrottleTask {
    let task: ThrottleTask = {
        interval,
        lastActive: 0,
        cache: void 0,
        queue: new Set(),
        func: void 0
    };

    async function throttle<RET, ARGS extends any[]>(this: ThrottleTask, handle: (...args: ARGS) => RET | Promise<RET>, ...args: ARGS): Promise<RET> {
        let now = Date.now();

        if ((now - this.lastActive) >= interval) {
            this.lastActive = now;

            if (backgroundUpdate && this.cache) {
                Promise.resolve(handle(...args)).then(result => {
                    this.cache = { value: result, error: null };
                }).catch(err => {
                    this.cache = { value: void 0, error: err };
                });

                if (this.cache.error)
                    throw this.cache.error;
                else
                    return this.cache.value as RET;
            } else {
                // Clear cache before dispatching the new job.
                this.cache = undefined;

                let result: RET;
                let error: any;

                try {
                    result = await handle(...args);
                    this.cache = { value: result, error: null };
                } catch (err) {
                    this.cache = { value: undefined, error: error = err };
                }

                // Resolve or reject subsequent jobs once the result is ready,
                // and make the procedure asynchronous so that they will be
                // performed after the current job.
                setImmediate(() => {
                    if (this.queue.size) {
                        this.queue.forEach((job) => {
                            error ? job.reject(error) : job.resolve(result);
                            this.queue.delete(job);
                        });
                    }
                });

                if (error)
                    throw error;
                else
                    return result! as RET;
            }
        } else if (this.cache) {
            if (this.cache.error)
                throw this.cache.error;
            else
                return this.cache.value as RET;
        } else {
            return new Promise<RET>((resolve, reject) => {
                this.queue.add({ resolve, reject });
            });
        }
    }

    task.func = throttle.bind(task) as <RET, ARGS extends any[]>(handle: (...args: ARGS) => RET | Promise<RET>, ...args: ARGS) => Promise<RET>;;
    return task;
}
