import { createHash } from "crypto";
import { execFile } from "child_process";
import { promises as fsPromises } from "fs";
import { promisify } from "util";
import path from "path";

const execFileAsync = promisify(execFile);

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

const PROBE_TIMEOUT_MS = 10000;
const PROBE_MAX_BUFFER = 4 * 1024 * 1024;

interface Probe {
    label: string;
    args: readonly string[];
    // If true, a non-zero exit or missing feature is fatal (probe is required).
    required: boolean;
}

const PROBES: readonly Probe[] = [
    { label: "dumpmachine", args: ["-dumpmachine"], required: true },
    { label: "dumpversion", args: ["-dumpversion"], required: true },
    { label: "dumpfullversion", args: ["-dumpfullversion"], required: false },
    { label: "builtins-c", args: ["-x", "c", "-E", "-dM", "/dev/null"], required: true },
    { label: "builtins-cxx", args: ["-x", "c++", "-E", "-dM", "/dev/null"], required: true }
];

async function runProbe(exec: string, probe: Probe): Promise<string | null> {
    try {
        const { stdout, stderr } = await execFileAsync(exec, [...probe.args], {
            timeout: PROBE_TIMEOUT_MS,
            maxBuffer: PROBE_MAX_BUFFER
        });
        return `${stdout}${stderr}`;
    } catch (err) {
        if (probe.required) {
            throw new Error(
                `Probe '${probe.label}' failed for ${exec}: ${err instanceof Error ? err.message : String(err)}`
            );
        }
        return null;
    }
}

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

async function gatherProbes(exec: string): Promise<ProbeOutputs> {
    const results = await Promise.all(PROBES.map((p) => runProbe(exec, p)));
    const [dumpmachine, dumpversion, dumpfullversion, builtinsC, builtinsCxx] = results;
    // The required probes cannot be null because runProbe would have thrown.
    return {
        dumpmachine: (dumpmachine ?? "").trim(),
        dumpversion: (dumpversion ?? "").trim(),
        dumpfullversion: dumpfullversion === null ? null : dumpfullversion.trim(),
        builtinsC: builtinsC ?? "",
        builtinsCxx: builtinsCxx ?? ""
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

export async function createCompilerInfo(exec: string): Promise<CompilerInfo> {
    const probes = await gatherProbes(exec);

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

export class CompilerInfoCache {
    private readonly cache: Map<string, CompilerInfo> = new Map<string, CompilerInfo>();
    private readonly pending: Map<string, Promise<CompilerInfo>> = new Map<string, Promise<CompilerInfo>>();

    async get(compilerPath: string): Promise<CompilerInfo> {
        if (typeof compilerPath !== "string" || compilerPath.length === 0) {
            throw new Error("CompilerInfoCache.get: compilerPath must be a non-empty string");
        }
        // Resolve symlinks so that /usr/bin/clang and /usr/bin/clang-18
        // (when the former is a symlink to the latter) share a cache entry.
        const absPath = await fsPromises.realpath(path.resolve(compilerPath));
        const stat = await fsPromises.stat(absPath);
        const key = `${absPath}:${stat.mtimeMs}`;

        const cached = this.cache.get(key);
        if (cached) {
            return cached;
        }

        const inflight = this.pending.get(key);
        if (inflight) {
            return inflight;
        }

        const compute = CompilerInfoCache.compute(absPath).then((info) => {
            this.cache.set(key, info);
            return info;
        });
        this.pending.set(key, compute);

        // Clean up the pending map on both success and failure so a failed
        // lookup doesn't wedge the key forever.
        compute
            .finally(() => {
                this.pending.delete(key);
            })
            .catch(() => {
                /* rejection observed by caller via the returned promise */
            });

        return compute;
    }

    private static async compute(absPath: string): Promise<CompilerInfo> {
        return createCompilerInfo(absPath);
    }
}
