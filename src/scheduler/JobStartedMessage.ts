import { JobScheduledMessage } from "./JobScheduledMessage";

export interface JobStartedMessage extends JobScheduledMessage {
    sha1: string;
}
