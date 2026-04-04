import { NodeData } from "./NodeData";
import { SHA1Data } from "./SHA1Data";
import { prettySize } from "./prettySize";
import EventEmitter from "events";
import assert from "assert";
import type { Builder } from "./Builder";
import type { ObjectCacheManagerMessage } from "./ObjectCacheManagerMessage";
import type { ObjectCacheMessage } from "../common/ObjectCacheMessage";
import type { Options } from "@jhanssen/options";
import type express from "express";

function addToSHA1Map(bySHA1: Map<string, SHA1Data>, sha1: string, fileSize: number, node: Builder): number {
    const data = bySHA1.get(sha1);
    if (data) {
        if (data.nodes.indexOf(node) === -1) {
            data.nodes.push(node);
        }
        return data.nodes.length;
    }
    bySHA1.set(sha1, new SHA1Data(fileSize, node));
    return 1;
}

function removeFromSHA1Map(bySHA1: Map<string, SHA1Data>, sha1: string, node: Builder): void {
    const data = bySHA1.get(sha1);
    if (data) {
        const idx = data.nodes.indexOf(node);
        if (idx !== -1) {
            data.nodes.splice(idx, 1);
            if (data.nodes.length === 0) {
                bySHA1.delete(sha1);
            }
        } else {
            console.error("We don't have", node.ip + ":" + node.port, "for", sha1);
        }
    } else {
        console.error("We don't have", sha1);
    }
}

function pendingKey(sha1: string, node: Builder): string {
    return sha1 + ":" + node.ip + ":" + node.port;
}

interface CommandType {
    available: number;
    objects: unknown[];
}

export class ObjectCacheManager extends EventEmitter {
    private bySHA1: Map<string, SHA1Data>;
    private byNode: Map<Builder, NodeData>;
    private pendingTransfers: Set<string>;
    private pendingTransferTimers: Map<string, NodeJS.Timeout>;
    private distributeOnInsertion: boolean;
    private distributeOnCacheHit: boolean;
    private redundancy: number;
    private pendingTransferTimeoutMs: number;

    hits: number;

    constructor(option: Options) {
        super();
        this.hits = 0;
        this.bySHA1 = new Map();
        this.byNode = new Map();
        this.pendingTransfers = new Set();
        this.pendingTransferTimers = new Map();
        this.redundancy = option.int("object-cache-redundancy", 1);
        if (this.redundancy <= 0) {
            this.redundancy = 1;
        }
        this.pendingTransferTimeoutMs = option.int("object-cache-transfer-timeout", 5 * 60 * 1000);
        this.distributeOnInsertion = Boolean(option("distribute-object-cache-on-insertion"));
        this.distributeOnCacheHit = Boolean(option("distribute-object-cache-on-cache-hit"));
    }

    clear(): void {
        this.hits = 0;
        for (const timer of this.pendingTransferTimers.values()) {
            clearTimeout(timer);
        }
        this.pendingTransfers.clear();
        this.pendingTransferTimers.clear();
        this.emit("cleared");
    }

    hit(sha1: string): void {
        ++this.hits;
        if (this.distributeOnCacheHit) {
            this.distribute({ sha1: sha1, redundancy: this.redundancy });
        }
    }

    get(sha1: string): SHA1Data | undefined {
        // console.log("looking for", sha1, [ this.bySHA1.keys() ]);
        return this.bySHA1.get(sha1);
    }

    insert(msg: ObjectCacheManagerMessage, node: Builder): void {
        const nodeData = this.byNode.get(node);
        console.log(
            "adding",
            msg.sourcePath,
            msg.sha1,
            "for",
            node.ip + ":" + node.port,
            nodeData ? nodeData.sha1s.length : -1
        );
        if (nodeData) {
            this.clearPendingTransfer(msg.sha1, node);
            if (nodeData.sha1s.indexOf(msg.sha1) === -1) {
                nodeData.sha1s.push(msg.sha1);
            }
            nodeData.size = msg.cacheSize;
            const count = addToSHA1Map(this.bySHA1, msg.sha1, msg.fileSize, node);
            if (this.distributeOnInsertion && count - 1 < this.redundancy) {
                this.distribute({ sha1: msg.sha1, redundancy: this.redundancy });
            }
        } else {
            console.error("insert: We don't seem to have this node", node.ip + ":" + node.port);
        }
    }

    remove(msg: ObjectCacheManagerMessage, node: Builder): void {
        const nodeData = this.byNode.get(node);
        console.log(
            "removing",
            msg.sourcePath,
            msg.sha1,
            "for",
            node.ip + ":" + node.port,
            nodeData ? nodeData.sha1s.length : -1
        );
        if (nodeData) {
            const idx = nodeData.sha1s.indexOf(msg.sha1);
            if (idx !== -1) {
                nodeData.sha1s.splice(idx, 1);
            } else {
                console.error("We don't have", msg.sha1, "on", node.ip + ":" + node.port);
            }
            removeFromSHA1Map(this.bySHA1, msg.sha1, node);
            nodeData.size = msg.cacheSize;
        } else {
            console.error("remove: We don't seem to have this node", node.ip + ":" + node.port);
        }
    }

    addNode(node: Builder, data: ObjectCacheMessage): void {
        console.log(
            "adding object cache node",
            node.ip + ":" + node.port,
            node.name,
            node.hostname,
            "maxSize",
            prettySize(data.maxSize),
            "cacheSize",
            prettySize(data.cacheSize),
            "sha1s",
            data.sha1s.length
        );
        if (this.byNode.get(node)) {
            console.log("We already have", node.ip + ":" + node.port);
            return;
        }
        const sha1s = data.sha1s.map((item) => item.sha1);
        this.byNode.set(node, new NodeData(data.cacheSize, data.maxSize, sha1s));
        data.sha1s.forEach((item) => {
            addToSHA1Map(this.bySHA1, item.sha1, item.fileSize, node);
        });
    }

    removeNode(node: Builder): void {
        console.log("removing node", node.ip + ":" + node.port);
        const nodeData = this.byNode.get(node);
        if (!nodeData) {
            console.error("We don't have", node.ip + ":" + node.port);
            return;
        }
        this.byNode.delete(node);
        this.clearAllPendingForNode(node);
        nodeData.sha1s.forEach((sha1) => {
            removeFromSHA1Map(this.bySHA1, sha1, node);
        });
    }

    dump(query: Record<string, unknown>): unknown {
        if ("clear" in query) {
            this.clear();
        }
        const ret: Record<string, unknown> = {
            hits: this.hits
        };

        if ("nodes" in query) {
            const nodes: Record<string, unknown> = {};
            const verbose = "verbose" in query;
            this.byNode.forEach((value, key) => {
                const data: Record<string, unknown> = {
                    sha1s: verbose ? value.sha1s : value.sha1s.length,
                    maxSize: prettySize(value.maxSize),
                    size: prettySize(value.size)
                };
                if (key.name) {
                    data.name = key.name;
                }
                if (key.hostname) {
                    data.name = key.hostname;
                }
                nodes[key.ip + ":" + key.port] = data;
            });
            ret.nodes = nodes;
        }

        if ("objects" in query) {
            const sha1: Record<string, unknown> = {};
            this.bySHA1.forEach((value, key) => {
                // console.log(key, value);
                sha1[key] = {
                    fileSize: prettySize(value.fileSize),
                    nodes: value.nodes.map((node) => node.ip + ":" + node.port)
                };
            });
            ret.sha1 = sha1;
        }

        return ret;
    }

    distribute(query: Record<string, unknown>, res?: express.Response): void {
        const dry = "dry" in query;
        let redundancy: number = parseInt(String(query.redundancy));
        if (isNaN(redundancy) || redundancy <= 0) {
            redundancy = 1;
        }
        let max: number | undefined = parseInt(String(query.max));
        if (isNaN(max) || max <= 0) {
            max = undefined;
        }
        const sha1 = query.sha1 && typeof query.sha1 === "string" ? query.sha1 : undefined;
        const nodeRestriction = query.node && typeof query.node === "string" ? query.node : undefined;

        let ret: Record<string, unknown> | undefined;
        if (res) {
            ret = { type: "fetch_cache_objects", dry: dry, commands: {} as Record<string, unknown> };
            console.log(
                "distribute called with redundancy of",
                redundancy,
                "and max of",
                max,
                "dry",
                dry,
                "sha1",
                sha1 || "(all)"
            );
        }

        const nodes = Array.from(this.byNode.keys());
        let nodeIdx = 0;
        const commands = new Map<Builder, CommandType>();
        if (!sha1) {
            this.byNode.forEach((value: NodeData, key: Builder) => {
                commands.set(key, { objects: [], available: value.maxSize - value.size });
            });
        }
        let count = 0;
        if (this.byNode.size >= 2) {
            let roundRobinIndex = 0;
            const processObject = (sha: string, value: SHA1Data): void => {
                if (max !== undefined && max <= 0) {
                    return;
                }
                const pendingCount = this.pendingCountForSha1(sha);
                const totalCopies = value.nodes.length + pendingCount;
                const needed = Math.min(redundancy + 1 - totalCopies, this.byNode.size - 1);
                if (needed > 0) {
                    let firstIdx;
                    let found = 0;
                    while (found < needed) {
                        if (++nodeIdx === nodes.length) {
                            nodeIdx = 0;
                        }
                        if (firstIdx === undefined) {
                            firstIdx = nodeIdx;
                        } else if (firstIdx === nodeIdx) {
                            break;
                        }
                        const node = nodes[nodeIdx];
                        if (value.nodes.indexOf(node) !== -1) {
                            continue;
                        }
                        if (this.hasPendingTransfer(sha, node)) {
                            continue;
                        }
                        if (nodeRestriction && node.ip + ":" + node.port !== nodeRestriction) {
                            continue;
                        }
                        let data = commands.get(node);
                        let available;
                        if (data) {
                            available = data.available;
                        } else {
                            const nodeData = this.byNode.get(node);
                            assert(nodeData);
                            available = nodeData.maxSize - nodeData.size;
                        }
                        if (available < value.fileSize) {
                            continue;
                        }
                        if (!data) {
                            data = { objects: [], available: available };
                            commands.set(node, data);
                        }
                        ++found;
                        data.available -= value.fileSize;
                        const src = value.nodes[roundRobinIndex++ % value.nodes.length];
                        data.objects.push({ source: src.ip + ":" + src.port, sha1: sha });
                        if (max !== undefined && !--max) {
                            break;
                        }
                    }
                }
            };
            if (sha1) {
                const val = this.bySHA1.get(sha1);
                if (val) {
                    processObject(sha1, val);
                } else {
                    console.error("Couldn't find sha1", sha1);
                }
            } else {
                this.bySHA1.forEach((value, key) => {
                    processObject(key, value);
                });
            }
        }
        commands.forEach((value, key) => {
            if (value.objects.length) {
                console.log(
                    `sending ${value.objects.length}/${this.bySHA1.size} fetch_cache_objects to ${key.ip}:${key.port}`
                );
                if (ret) {
                    (ret.commands as Record<string, unknown>)[`${key.ip}:${key.port}`] = value.objects;
                }
                count += value.objects.length;
                if (!dry) {
                    for (const obj of value.objects as Array<{ sha1: string }>) {
                        this.addPendingTransfer(obj.sha1, key);
                    }
                    key.send({ type: "fetch_cache_objects", objects: value.objects });
                }
            }
        });
        if (ret && res) {
            ret.count = count;
            res.send(JSON.stringify(ret, null, 4) + "\n");
        }
    }

    private addPendingTransfer(sha1: string, node: Builder): void {
        const key = pendingKey(sha1, node);
        this.pendingTransfers.add(key);
        const timer = setTimeout(() => {
            this.pendingTransfers.delete(key);
            this.pendingTransferTimers.delete(key);
        }, this.pendingTransferTimeoutMs);
        timer.unref();
        this.pendingTransferTimers.set(key, timer);
    }

    private clearPendingTransfer(sha1: string, node: Builder): void {
        const key = pendingKey(sha1, node);
        this.pendingTransfers.delete(key);
        const timer = this.pendingTransferTimers.get(key);
        if (timer) {
            clearTimeout(timer);
            this.pendingTransferTimers.delete(key);
        }
    }

    private clearAllPendingForNode(node: Builder): void {
        const suffix = ":" + node.ip + ":" + node.port;
        for (const key of this.pendingTransfers) {
            if (key.endsWith(suffix)) {
                this.pendingTransfers.delete(key);
                const timer = this.pendingTransferTimers.get(key);
                if (timer) {
                    clearTimeout(timer);
                    this.pendingTransferTimers.delete(key);
                }
            }
        }
    }

    private pendingCountForSha1(sha1: string): number {
        let count = 0;
        for (const key of this.pendingTransfers) {
            if (key.startsWith(sha1 + ":")) {
                ++count;
            }
        }
        return count;
    }

    private hasPendingTransfer(sha1: string, node: Builder): boolean {
        return this.pendingTransfers.has(pendingKey(sha1, node));
    }
}
