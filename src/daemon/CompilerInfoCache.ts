import { createHash } from "crypto";

export type CompilerType = "clang" | "gcc" | "unknown";

export interface CompilerVersion {
    major: number;
    minor: number;
    patch: number;
}

export interface CompilerInfo {
    hash: string;
    input: string;
    type: CompilerType;
    version: CompilerVersion;
}

// Fingerprinting strategy:
//
// A compiler's "identity" for distributed-compile purposes is the set of
// behaviours that determine what code the frontend accepts and what the
// backend produces. It is NOT the bytes of the driver executable, because
// GCC and Clang bake absolute install paths into the driver at build time
// (STANDARD_EXEC_PREFIX / GCC_INSTALL_PREFIX / CLANG_RESOURCE_DIR /
// DEFAULT_SYSROOT / ...). Two machines that installed the same conan
// package for llvm end up with byte-different driver binaries whose paths
// point into per-machine conan caches, but the compilers are functionally
// identical. A file hash would say they are different; the scheduler would
// then be unable to match clients to builders.
//
// Instead, we hash the compiler's answers to a small set of probes that
// (a) are switch-independent, (b) do not embed absolute paths, and
// (c) fully determine frontend behaviour:
//
//   -dumpmachine                    default target triple
//   -dumpversion                    version number
//   -x c   -E -dM /dev/null         all builtin macros for C
//   -x c++ -E -dM /dev/null         all builtin macros for C++
//
// The macro dumps include __clang_version__ / __GNUC__ / __GNUC_MINOR__ /
// __GNUC_PATCHLEVEL__ / __VERSION__ / target width macros / feature-test
// macros. Those strings are frozen at compiler-build time, not install
// time, so they are identical across machines that installed the same
// compiler package.
//
// Who runs the probes:
//
// The daemon never executes a compiler. The compiler generally lives inside
// the client's container and its path does not resolve in the daemon's mount
// namespace, so the daemon cannot stat it let alone run it. Instead the daemon
// asks one client to run the probes and send the raw output back, and the
// daemon does the parsing and hashing here. Keeping canonicalisation on this
// side means there is exactly one implementation of it -- a second one in the
// client would eventually diverge and silently break client/builder matching.

export const PROBE_TIMEOUT_MS = 10000;

export interface Probe {
    label: string;
    args: readonly string[];
    // If false, the probe may fail (or the feature may be missing) without
    // failing the whole fingerprint.
    required: boolean;
}

export const PROBES: readonly Probe[] = [
    { label: "dumpmachine", args: ["-dumpmachine"], required: true },
    { label: "dumpversion", args: ["-dumpversion"], required: true },
    { label: "dumpfullversion", args: ["-dumpfullversion"], required: false },
    { label: "builtins-c", args: ["-x", "c", "-E", "-dM", "/dev/null"], required: true },
    { label: "builtins-cxx", args: ["-x", "c++", "-E", "-dM", "/dev/null"], required: true }
];

// Raw probe output as reported by a client: label -> combined stdout+stderr,
// or null when a non-required probe did not run.
export type ProbeResults = Record<string, string | null>;

// Emulate the C++ sscanf cascade "%d.%d.%d" -> "%d.%d" -> "%d".
function parseVersion(text: string): CompilerVersion {
    const three = /^(\d+)\.(\d+)\.(\d+)/.exec(text);
    if (three) {
        return { major: parseInt(three[1], 10), minor: parseInt(three[2], 10), patch: parseInt(three[3], 10) };
    }
    const two = /^(\d+)\.(\d+)/.exec(text);
    if (two) {
        return { major: parseInt(two[1], 10), minor: parseInt(two[2], 10), patch: 0 };
    }
    const one = /^(\d+)/.exec(text);
    if (one) {
        return { major: parseInt(one[1], 10), minor: 0, patch: 0 };
    }
    return { major: 0, minor: 0, patch: 0 };
}

function detectTypeFromMacros(macros: string): CompilerType {
    // clang defines __clang__ even under GCC compatibility mode.
    if (/^#define __clang__ /m.test(macros)) {
        return "clang";
    }
    // GCC defines __GNUC__ but so does clang; require __GNUC__ *without* __clang__.
    if (/^#define __GNUC__ /m.test(macros)) {
        return "gcc";
    }
    return "unknown";
}

function macroValue(macros: string, name: string): string | null {
    const m = new RegExp(`^#define ${name} (.*)$`, "m").exec(macros);
    return m ? m[1].trim() : null;
}

function stripQuotes(s: string): string {
    if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
        return s.substring(1, s.length - 1);
    }
    return s;
}

// Extract a version tuple from the compiler's own macros. This is stable
// across install locations because these macros are frozen at compiler
// build time.
function versionFromMacros(macros: string, type: CompilerType): CompilerVersion {
    if (type === "clang") {
        const v = macroValue(macros, "__clang_version__");
        if (v) {
            return parseVersion(stripQuotes(v));
        }
        const major = macroValue(macros, "__clang_major__");
        const minor = macroValue(macros, "__clang_minor__");
        const patch = macroValue(macros, "__clang_patchlevel__");
        if (major !== null) {
            return {
                major: parseInt(major, 10) || 0,
                minor: minor !== null ? parseInt(minor, 10) || 0 : 0,
                patch: patch !== null ? parseInt(patch, 10) || 0 : 0
            };
        }
    }
    if (type === "gcc") {
        const major = macroValue(macros, "__GNUC__");
        const minor = macroValue(macros, "__GNUC_MINOR__");
        const patch = macroValue(macros, "__GNUC_PATCHLEVEL__");
        if (major !== null) {
            return {
                major: parseInt(major, 10) || 0,
                minor: minor !== null ? parseInt(minor, 10) || 0 : 0,
                patch: patch !== null ? parseInt(patch, 10) || 0 : 0
            };
        }
    }
    return { major: 0, minor: 0, patch: 0 };
}

interface ProbeOutputs {
    dumpmachine: string;
    dumpversion: string;
    dumpfullversion: string | null;
    builtinsC: string;
    builtinsCxx: string;
}

// Turn a client's reported results into the shape the fingerprint wants,
// failing if a required probe is missing. A client that reports nothing for a
// required probe is telling us it could not identify the compiler, which must
// not silently become a fingerprint of empty strings -- every such compiler
// would hash the same.
function toProbeOutputs(results: ProbeResults): ProbeOutputs {
    for (const probe of PROBES) {
        if (probe.required && !results[probe.label]) {
            throw new Error(`Required probe '${probe.label}' produced no output`);
        }
    }
    const value = (label: string): string => results[label] ?? "";
    const full = results.dumpfullversion;
    return {
        dumpmachine: value("dumpmachine").trim(),
        dumpversion: value("dumpversion").trim(),
        dumpfullversion: full ? full.trim() : null,
        builtinsC: value("builtins-c"),
        builtinsCxx: value("builtins-cxx")
    };
}

// Build the canonical fingerprint blob whose SHA becomes the compiler hash.
// Fields are separated by NUL to avoid ambiguity if any probe output
// contains our field label as a substring. Field labels are included so
// that adding a new probe in a later version deterministically changes the
// hash for the same compiler (the label acts as a schema version bump).
function canonicalFingerprint(p: ProbeOutputs): Buffer {
    const parts: string[] = [
        "fisk-compiler-fingerprint-v1",
        "dumpmachine",
        p.dumpmachine,
        "dumpversion",
        p.dumpversion,
        "dumpfullversion",
        p.dumpfullversion ?? "",
        "builtins-c",
        p.builtinsC,
        "builtins-cxx",
        p.builtinsCxx
    ];
    return Buffer.from(parts.join("\0"), "utf8");
}

export function createCompilerInfo(results: ProbeResults): CompilerInfo {
    const probes = toProbeOutputs(results);

    const type = detectTypeFromMacros(probes.builtinsC);
    const versionFromMac = versionFromMacros(probes.builtinsC, type);
    const version =
        versionFromMac.major !== 0
            ? versionFromMac
            : parseVersion(probes.dumpfullversion ?? probes.dumpversion);

    const blob = canonicalFingerprint(probes);
    const hash = createHash("sha1").update(blob).digest("hex").toUpperCase();

    // `input` is retained for debug/traceability: it lets a human see what
    // went into the hash without needing to re-probe the compiler. Keep it
    // small: just the identifying strings, not the full macro dumps.
    const input = [
        `type=${type}`,
        `target=${probes.dumpmachine}`,
        `version=${version.major}.${version.minor}.${version.patch}`,
        `dumpversion=${probes.dumpversion}`,
        probes.dumpfullversion ? `dumpfullversion=${probes.dumpfullversion}` : ""
    ]
        .filter((s) => s.length > 0)
        .join("\n");

    return { hash, input, type, version };
}

// A client that can be asked to run the probes on our behalf.
export interface CompilerInfoRequester {
    readonly id: number;
    requestCompilerInfo(key: string, probes: readonly Probe[], timeoutMs: number): void;
}

// A client-supplied key must not be trusted to be small: it lands in a Map
// that lives as long as the daemon.
const MAX_KEY_LENGTH = 256;

interface Waiter {
    requester: CompilerInfoRequester;
    resolve: (info: CompilerInfo) => void;
    reject: (err: Error) => void;
}

function clearTimer(entry: Pending): void {
    if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = undefined;
    }
}

interface Pending {
    waiters: Waiter[];
    // Client currently asked to probe, if any.
    electedId?: number;
    // Clients already asked and found wanting, so re-election makes progress
    // instead of cycling.
    triedIds: Set<number>;
    timer?: NodeJS.Timeout;
}

// Caches compiler fingerprints, obtaining them from clients rather than by
// running anything.
//
// The key is opaque here and comes from the client -- it identifies "the same
// compiler file" well enough to decide whether to re-probe. It deliberately is
// not the fingerprint: we need something cheap to compute *before* probing.
//
// Only one client is asked per key. Everyone else waits on the same answer,
// which is what keeps a cold parallel build from probing the same compiler
// once per job. Callers get a promise, so the daemon's existing "await the
// info, then hand back a slot" flow already holds those clients' slots for
// the duration without any extra slot bookkeeping.
export class CompilerInfoStore {
    private readonly cache: Map<string, CompilerInfo> = new Map<string, CompilerInfo>();
    private readonly pending: Map<string, Pending> = new Map<string, Pending>();

    constructor(
        private readonly timeoutMs: number = PROBE_TIMEOUT_MS * 2,
        private readonly log: (...args: unknown[]) => void = (): void => {
            /* quiet by default */
        }
    ) {}

    get(key: string, requester: CompilerInfoRequester): Promise<CompilerInfo> {
        if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_LENGTH) {
            return Promise.reject(new Error("compiler key must be a non-empty string of sane length"));
        }

        const cached = this.cache.get(key);
        if (cached) {
            return Promise.resolve(cached);
        }

        return new Promise<CompilerInfo>((resolve, reject) => {
            let entry = this.pending.get(key);
            if (!entry) {
                entry = { waiters: [], triedIds: new Set<number>() };
                this.pending.set(key, entry);
            }
            entry.waiters.push({ requester, resolve, reject });

            // Someone is already probing this compiler; just wait for them.
            if (entry.electedId === undefined) {
                this.elect(key, entry);
            }
        });
    }

    // The elected client reported probe output.
    provide(key: string, results: ProbeResults): void {
        const entry = this.pending.get(key);
        let info: CompilerInfo;
        try {
            info = createCompilerInfo(results);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.log("compilerInfo for", key, "was unusable:", message);
            if (entry) {
                this.reelect(key, entry, message);
            }
            return;
        }

        this.cache.set(key, info);
        if (!entry) {
            return;
        }
        this.finish(key, entry);
        for (const waiter of entry.waiters) {
            waiter.resolve(info);
        }
    }

    // The elected client could not probe the compiler.
    fail(key: string, error: string): void {
        const entry = this.pending.get(key);
        if (entry) {
            this.reelect(key, entry, error);
        }
    }

    // A client went away. If it owed us an answer, ask someone else.
    clientGone(requester: CompilerInfoRequester): void {
        for (const [key, entry] of this.pending) {
            entry.waiters = entry.waiters.filter((w) => w.requester.id !== requester.id);
            if (entry.electedId === requester.id) {
                this.reelect(key, entry, "client disconnected before reporting compiler info");
            } else if (!entry.waiters.length) {
                this.finish(key, entry);
            }
        }
    }

    private elect(key: string, entry: Pending): void {
        const next = entry.waiters.find((w) => !entry.triedIds.has(w.requester.id));
        if (!next) {
            // Nobody left who has not already failed us.
            const waiters = entry.waiters;
            this.finish(key, entry);
            const err = new Error("no client could provide compiler info");
            for (const waiter of waiters) {
                waiter.reject(err);
            }
            return;
        }

        entry.electedId = next.requester.id;
        entry.triedIds.add(next.requester.id);
        entry.timer = setTimeout(() => {
            this.log("compilerInfo probe timed out for", key, "client", next.requester.id);
            this.reelect(key, entry, "timed out waiting for compiler info");
        }, this.timeoutMs);
        // Do not let a pending probe hold the process open.
        entry.timer.unref?.();

        this.log("asking client", next.requester.id, "to probe compiler", key);
        try {
            next.requester.requestCompilerInfo(key, PROBES, PROBE_TIMEOUT_MS);
        } catch (err) {
            this.log("failed to ask client", next.requester.id, err);
            this.reelect(key, entry, "could not ask client to probe");
        }
    }

    private reelect(key: string, entry: Pending, why: string): void {
        this.log("re-electing for", key, "-", why);
        clearTimer(entry);
        entry.electedId = undefined;
        this.elect(key, entry);
    }

    private finish(key: string, entry: Pending): void {
        clearTimer(entry);
        this.pending.delete(key);
    }
}
