import { promises as dnsPromises } from "dns";
import { promises as fsPromises } from "fs";
import { isIP, Socket } from "net";
import { Agent as HttpAgent } from "http";
import { Agent as HttpsAgent } from "https";
import useThrottle from "./useThrottle";

type AddressInfo = { address: string, family: 4 | 6; };
type AddressInfoDetail = AddressInfo & { expireAt: number; };
type LookupCallback<T extends string | AddressInfo[]> = (
    err: NodeJS.ErrnoException,
    address: T,
    family?: 4 | 6
) => void;

type CacheData = Record<string, AddressInfoDetail[]>;

const MIN_TTL_SEC = 10;

const DEFAULT_TTL = MIN_TTL_SEC * 1000;

const hostsThrottle = useThrottle("dnsLookup:loadHostsConfig", DEFAULT_TTL) as any as (p: any) => Promise<CacheData>;
const _createConnection = Symbol("_createConnection");
const Cache: CacheData = {};

var HostsConfig: CacheData;
var timer = setInterval(async () => { // reload hosts file for every 10 seconds.
    HostsConfig = await hostsThrottle(loadHostsConfig);
}, DEFAULT_TTL);

timer.unref(); // allow the process to exit once there are no more pending jobs.

/**
 * @returns return Timestam in sec
 */
function timestamp() {
    return (Date.now() / 1000) | 0
}

const IPV4 = 4 as 4;
const IPV6 = 6 as 6;

async function loadHostsConfig(file: string = ""): Promise<CacheData> {
    if (!file) {
        if (process.platform === "win32") {
            file = "c:\\Windows\\System32\\Drivers\\etc\\hosts";
        } else {
            file = "/etc/hosts";
        }
    }
    const hostFile = await fsPromises.readFile(file, "utf8");
    const expireAt = timestamp() + MIN_TTL_SEC; // mark available for MIN_TTL_SEC seconds
    return hostFile.split(/\r\n|\n/)
        .map(line => line.trim())
        .filter(line => !line.startsWith("#"))
        .map(line => line.split(/\s+/))
        .reduce((configs: CacheData, segments) => {
            const address = segments[0];
            for (let i = 1; i < segments.length; i++) {
                const hostname = segments[i];
                if (hostname.startsWith("#"))
                    break;
                const family = isIP(address) as 0 | 4 | 6;
                if (!family)
                    continue;
                (configs[hostname] || (configs[hostname] = [])).push({
                    address,
                    family,
                    expireAt
                });
            }
            return configs;
        }, {});
}

/**
 * Queries IP addresses of the given hostname, this operation is async and
 * atomic, and uses cache when available. When `family` is omitted, both
 * `A (IPv4)` and `AAAA (IPv6)` records are searched, however only one address
 * will be returned if `options.all` is not set.
 * 
 * NOTE: The internal TTL for an identical query is 10 seconds.
 */
export function lookup(hostname: string, family?: 0 | 4 | 6): Promise<string>;
export function lookup(hostname: string, callback: LookupCallback<string>): void;
export function lookup(
    hostname: string,
    family: 0 | 4 | 6,
    callback: LookupCallback<string>
): void;
export function lookup(
    hostname: string,
    options: { family?: 0 | 4 | 6; }
): Promise<string>;
export function lookup(
    hostname: string,
    options: { family?: 0 | 4 | 6; },
    callback: LookupCallback<string>
): void;
export function lookup(
    hostname: string,
    options: { family?: 0 | 4 | 6; all: true; }
): Promise<AddressInfo[]>;
export function lookup(
    hostname: string,
    options: { family?: 0 | 4 | 6; all: true; },
    callback: LookupCallback<AddressInfo[]>
): void;
export function lookup(
    hostname: string,
    options: any = void 0,
    callback: any = null
): any {
    let family: 0 | 4 | 6 = 0;
    let all = false;

    if (typeof options === "object") {
        family = options.family || 0;
        all = options.all || false;
    } else if (typeof options === "number") {
        family = options as 0 | 4 | 6;
    } else if (typeof options === "function") {
        callback = options;
    }

    const _family = isIP(hostname) as 0 | 4 | 6;

    if (_family) {
        if (all) {
            if (callback) {
                return callback(null, [{ address: hostname, family: _family }]);
            } else {
                return Promise.resolve([{ address: hostname, family: _family }]);
            }
        } else {
            if (callback) {
                return callback(null, hostname, _family);
            } else {
                return Promise.resolve(hostname);
            }
        }
    }

    let query!: Promise<AddressInfo[]>;//  | undefined;

    // If local cache contains records of the target hostname, try to retrieve
    // them and prevent network query.
    if (Cache[hostname]) {
        const now = timestamp();
        let addresses = Cache[hostname].filter(a => a.expireAt > now);

        if (family) {
            addresses = addresses.filter(a => a.family === family);
        }

        if (addresses.length) {
            query = Promise.resolve(addresses);
        }
    }

    // If local cache doesn't contain available records, then goto network
    // query.
    if (!query) {
        const tag = `dnsLookup:${hostname}:${family}:${all}`;

        query = useThrottle<AddressInfo[], any>(tag, DEFAULT_TTL)(async (): Promise<AddressInfo[]> => {
            if (!HostsConfig) {
                HostsConfig = await hostsThrottle(loadHostsConfig);
            }

            let result: AddressInfoDetail[] = HostsConfig[hostname] || [];
            let err4: NodeJS.ErrnoException | undefined;
            let err6: NodeJS.ErrnoException | undefined;

            let v4updated = false;
            async function updateV4() {
                v4updated = true;
                try {
                    const records = await dnsPromises.resolve4(hostname, { ttl: true });
                    const now = timestamp();
                    // In case the DNS refresh the record, we only allow MIN_TTL_SEC seconds for minmum cache time.
                    const v4 = records.map(({ address, ttl }) => ({ address, family: IPV4, expireAt: Math.max(ttl + now, MIN_TTL_SEC) }));
                    result.push(...v4);
                    // Cache the records.
                    let cacheSlot = Cache[hostname];
                    if (cacheSlot) {
                        // remove old values history
                        cacheSlot = cacheSlot.filter(a => a.family !== 4);
                        cacheSlot.push(...v4);
                        Cache[hostname] = cacheSlot;
                    } else {
                        Cache[hostname] = v4;
                    }
                } catch (e) {
                    err4 = e as NodeJS.ErrnoException;
                }
            }

            if (!family || family === 4) {
                await updateV4();
            }
            if (!family || family === 6) {
                try {
                    const records = await dnsPromises.resolve6(hostname, { ttl: true });
                    const now = timestamp();
                    const v6 = records.map(({ address, ttl }) => ({ address, family: IPV6, expireAt: Math.max(ttl + now, MIN_TTL_SEC) }));
                    result.push(...v6);
                    // Cache the records.
                    let cacheSlot = Cache[hostname];
                    if (cacheSlot) {
                        // remove history
                        cacheSlot = cacheSlot.filter(a => a.family !== 6);
                        cacheSlot.push(...v6);
                        cacheSlot = Cache[hostname];
                    } else {
                        Cache[hostname] = v6;
                    }
                } catch (e) {
                    if ((e as any).code === "ENODATA" &&
                        (e as any).syscall === "queryAaaa" &&
                        family === 6
                    ) {
                        try {
                            if (!v4updated) {
                                await updateV4();
                            }
                            let cacheSlot = Cache[hostname];
                            const v4 = cacheSlot.filter(a => a.family !== 4);
                            const v6 = v4.map(({ address, expireAt }) => ({ address: `::ffff:${address}`, family: IPV6, expireAt }))
                            cacheSlot = cacheSlot.filter(a => a.family !== 6);
                            cacheSlot.push(...v6);
                            Cache[hostname] = cacheSlot;
                        } catch (_e) {
                            err6 = e as NodeJS.ErrnoException;
                        }
                    } else {
                        err6 = e as NodeJS.ErrnoException;
                    }
                }
            }

            if (err4 && err6 && !family) {
                throw Object.assign(
                    new Error(`queryA and queryAaaa ENODATA ${hostname}`),
                    {
                        errno: undefined,
                        code: "ENODATA",
                        syscall: undefined,
                        hostname
                    }
                );
            } else if (err4 && family === 4) {
                throw err4;
            } else if (err6 && family === 6) {
                throw err6;
            } else {
                return result;
            }
        });
    }

    if (query) {
        query = query.then(addresses => addresses.map(({ address, family }) => {
            // Make sure the result only contains 'address' and 'family'.
            return { address, family };
        }));
    }

    if (!callback) {
        return query.then(addresses => {
            if (all) {
                if (family) {
                    return addresses.filter(a => a.family === family);
                } else {
                    return addresses;
                }
            } else {
                if (family) {
                    const addresse = addresses.find(a => a.family === family)
                    if (!addresse)
                        throw Error(`No matching IPV${family} available for ${hostname}, ${addresses.length} records in cache`);
                    return addresse.address;
                } else {
                    return addresses[0].address;
                }
            }
        });
    } else {
        query.then(addresses => {
            if (all) {
                if (family) {
                    callback(null, addresses.filter(a => a.family === family));
                } else {
                    callback(null, addresses);
                }
            } else {
                if (family) {
                    const addresse = addresses.find(a => a.family === family);
                    if (!addresse)
                        callback(
                            Error(`No matching IPV${family} available for ${hostname}, ${addresses.length} records in cache`),
                            null,
                            0
                        );
                    else
                        callback(
                            null,
                            addresse.address,
                            family
                        );
                } else {
                    callback(null, addresses[0].address, addresses[0].family);
                }
            }
        }).catch(err => {
            callback(err, void 0);
        });
    }
}

/**
 * Attaches the custom lookup functionality to the given `agent`, the `family` 
 * argument configures the default IP family used to resolve addresses when no
 * `family` option is specified in the `http.request()`, the default value is
 * `0`. 
 */
export function install<T extends HttpAgent | HttpsAgent>(
    agent: T & {
        createConnection?: (options: any, callback: Function) => Socket;
    },
    family: 0 | 4 | 6 = 0
): T {
    let tryAttach = (options: Record<string, any>) => {
        if (!options["lookup"]) {
            options["lookup"] = function (
                hostname: string,
                options: any,
                cb: LookupCallback<string>
            ) {
                return lookup(hostname, options["family"] ?? family, cb);
            };
        }
    };

    if (typeof agent.createConnection === "function") {
        if (!(_createConnection in agent)) {
            (agent as any)[_createConnection] = agent.createConnection;
            agent.createConnection = function (options, callback) {
                tryAttach(options);
                return (agent as any)[_createConnection](options, callback);
            };
        }

        return agent;
    } else if (isHttpsProxyAgent(agent)) {
        tryAttach(agent.proxy);
        return agent;
    } else {
        throw new TypeError("Cannot install lookup function on the given agent");
    }
}

function isHttpsProxyAgent(agent: any): agent is { proxy: Record<string, any>; } {
    return agent.constructor.name === "HttpsProxyAgent"
        && typeof agent.proxy === "object";
}
