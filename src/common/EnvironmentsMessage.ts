import type { CompilerInfo } from "./CompilerInfo";

export interface EnvironmentsMessage {
    type: "getEnvironments";
    environments: string[];
    compilerInfo: Record<string, CompilerInfo>;
}
