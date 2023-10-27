import fs from "fs";

export class Environment {
    info?: string;
    size?: number;

    constructor(readonly path: string, readonly hash: string, readonly system: string, readonly originalPath: string) {
        try {
            this.size = fs.statSync(path).size;
        } catch (err: unknown) {
            /* */
        }
        console.log("Created environment", JSON.stringify(this), originalPath);
    }

    get file(): string {
        return `${this.hash}_${this.system}.tar.gz`;
    }

    toString(): string {
        return JSON.stringify(this, null, 4);
    }

    canRun(system: string): boolean {
        switch (system) {
            case "Linux i686":
            case "Darwin i686": // ### this is not really a thing
                return this.system === system;
            case "Linux x86_64":
                return Boolean(/^Linux /.exec(this.system));
            case "Darwin x86_64":
                return Boolean(/^Darwin /.exec(this.system));
            case "Darwin arm64":
                return Boolean(/^Darwin /.exec(this.system));
            default:
                console.error("Unknown system", system);
                return false;
        }
    }
}
