import { Client, ClientType } from "./Client";
import type { ClientSocket } from "./Client";
import type { Options } from "@jhanssen/options";


export class Compile extends Client {
    builder?: string;

    // A job relayed by a daemon cannot stream an environment tarball to us: it is
    // one multiplexed stream on a connection shared with every other compile on
    // that host. Such a client reconnects directly to upload instead.
    canUploadEnvironment: boolean = true;

    constructor(
        ws: ClientSocket,
        ip: string,
        readonly environment: string,
        readonly sourcePath: string,
        readonly sha1?: string,
        option?: Options
    ) {
        super(ClientType.Compile, ws, ip, option);
    }
}
