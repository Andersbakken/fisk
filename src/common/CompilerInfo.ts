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

// Bump this to invalidate compiler hashes created with older fingerprint inputs.
export const CompilerFingerprintVersion = 2;

// Bump when the persistent metadata stored with compiler environments changes.
export const EnvironmentInfoVersion = 2;

export function isCompilerInfo(value: unknown): value is CompilerInfo {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const info = value as Partial<CompilerInfo>;
    if (
        typeof info.hash !== "string" ||
        typeof info.input !== "string" ||
        (info.type !== "clang" && info.type !== "gcc" && info.type !== "unknown") ||
        typeof info.version !== "object" ||
        info.version === null
    ) {
        return false;
    }
    const version = info.version as Partial<CompilerVersion>;
    return (
        Number.isInteger(version.major) &&
        Number.isInteger(version.minor) &&
        Number.isInteger(version.patch) &&
        (version.major as number) >= 0 &&
        (version.minor as number) >= 0 &&
        (version.patch as number) >= 0
    );
}
