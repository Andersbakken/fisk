export interface BuilderAddedOrRemovedBase {
    ip: string;
    name: string;
    hostname: string;
    slots: number;
    port: number;
    jobsPerformed: number;
    compileSpeed: number;
    uploadSpeed: number;
    system: string;
    created: string;
    npmVersion: string;
    environments: string[];
    labels?: string[];
}

export interface BuilderAddedMessage extends BuilderAddedOrRemovedBase {
    type: "builderAdded";
}

export interface BuilderRemovedMessage extends BuilderAddedOrRemovedBase {
    type: "builderRemoved";
}
