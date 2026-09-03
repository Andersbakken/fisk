import type { ClientSocket } from "./Client";

// One fiskc job on a daemon's shared connection. Everything the scheduler sends
// to "its client" is framed onto that connection by relay(), and closing it (a
// version mismatch, Client.error()) has to be reported to the daemon rather than
// dropping a TCP connection, or the fiskc process would wait for its watchdog.
export class DaemonJobSocket implements ClientSocket {
    private open: boolean;

    constructor(
        private readonly relay: (message: string) => void,
        private readonly closed: (reason: string) => void
    ) {
        this.open = true;
    }

    send(data: unknown): void {
        if (!this.open) {
            return;
        }
        if (typeof data === "string") {
            this.relay(data);
        } else if (data instanceof Buffer) {
            this.relay(data.toString("utf8"));
        } else {
            console.error("Unexpected payload for a daemon job", typeof data);
        }
    }

    close(code?: number, reason?: string | Buffer): void {
        if (!this.open) {
            return;
        }
        this.open = false;
        this.closed(String(reason || `closed with ${code === undefined ? 1000 : code}`));
    }

    // eslint-disable-next-line class-methods-use-this
    ping(): void {
        // Liveness is a property of the daemon's connection, not of a single job.
    }

    terminate(): void {
        this.close(1006, "terminated");
    }
}
