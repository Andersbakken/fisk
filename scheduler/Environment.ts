export class Environment {
    path: string;
    hash: string;
    system: string;
    originalPath: string;
    info?: string;
    size?: number;

    constructor(path: string, hash: string, system: string, originalPath: string) {
        this.path = path;
        this.hash = hash;
        this.system = system;
        this.originalPath = originalPath;
        try {
            this.size = fs.statSync(path).size;
        } catch (err: unknown) {
            /* */
        }
        console.log("Created environment", JSON.stringify(this), originalPath);
    }

    toString(): string {
        return JSON.stringify(this, null, 4);
    }

    get file(): string {
        return `${this.hash}_${this.system}.tar.gz`;
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
