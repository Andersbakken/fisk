const EventEmitter = require("events");

function prettysize(bytes) {
    const prettysize = require("prettysize");
    return prettysize(bytes, bytes >= 1024); // don't want 0Bytes
}

class NodeData {
    constructor(size, maxSize, sha1s) {
        this.sha1s = sha1s;
        this.size = size;
        this.maxSize = maxSize;
    }
}

class SHA1Data {
    constructor(fileSize, node) {
        this.fileSize = fileSize;
        this.nodes = [node];
    }
}

function addToSHA1Map(bySHA1, sha1, fileSize, node) {
    let data = bySHA1.get(sha1);
    if (data) {
        data.nodes.push(node);
        return data.nodes.length;
    } else {
        bySHA1.set(sha1, new SHA1Data(fileSize, node));
        return 1;
    }
}

function removeFromSHA1Map(bySHA1, sha1, node) {
    let data = bySHA1.get(sha1);
    if (data) {
        let idx = data.nodes.indexOf(node);
        if (idx != -1) {
            data.nodes.splice(idx, 1);
            if (data.nodes.length == 0) {
                bySHA1.delete(sha1);
            }
        } else {
            console.error("We don't have", node.ip + ":" + node.port, "for", sha1);
        }
    } else {
        console.error("We don't have", sha1);
    }
}

class ObjectCacheManager extends EventEmitter {
    constructor(option) {
        super();
        this.hits = 0;
        this.bySHA1 = new Map();
        this.byNode = new Map();
        this.redundancy = option.int("object-cache-redundancy", 1);
        if (this.redundancy <= 0) this.redundancy = 1;
        this.distributeOnInsertion = option("distribute-object-cache-on-insertion") || false;
        this.distributeOnCacheHit = option("distribute-object-cache-on-cache-hit") || false;
    }

    clear() {
        this.hits = 0;
        this.emit("cleared");
    }

    hit(sha1) {
        ++this.hits;
        if (this.distributeOnCacheHit) {
            this.distribute({ sha1: sha1, redundancy: this.redundancy });
        }
    }

    get(sha1) {
        // console.log("looking for", sha1, [ this.bySHA1.keys() ]);
        return this.bySHA1.get(sha1);
    }

    insert(msg, node) {
        let nodeData = this.byNode.get(node);
        console.log(
            "adding",
            msg.sourceFile,
            msg.sha1,
            "for",
            node.ip + ":" + node.port,
            nodeData ? nodeData.sha1s.length : -1
        );
        if (nodeData) {
            nodeData.sha1s.push(msg.sha1);
            nodeData.size = msg.cacheSize;
            const count = addToSHA1Map(this.bySHA1, msg.sha1, msg.fileSize, node);
            if (this.distributeOnInsertion && count - 1 < this.redundancy) {
                this.distribute({ sha1: msg.sha1, redundancy: this.redundancy });
            }
        } else {
            console.error("insert: We don't seem to have this node", node.ip + ":" + node.port);
        }
    }

    remove(msg, node) {
        let nodeData = this.byNode.get(node);
        console.log(
            "removing",
            msg.sourceFile,
            msg.sha1,
            "for",
            node.ip + ":" + node.port,
            nodeData ? nodeData.sha1s.length : -1
        );
        if (nodeData) {
            let idx = nodeData.sha1s.indexOf(msg.sha1);
            if (idx != -1) {
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

    addNode(node, data) {
        console.log(
            "adding object cache node",
            node.ip + ":" + node.port,
            node.name,
            node.hostname,
            "maxSize",
            prettysize(data.maxSize),
            "cacheSize",
            prettysize(data.cacheSize),
            "sha1s",
            data.sha1s.length
        );
        if (this.byNode.get(node)) {
            console.log("We already have", node.ip + ":" + node.port);
            return;
        }
        let sha1s = data.sha1s.map((item) => item.sha1);
        this.byNode.set(node, new NodeData(data.cacheSize, data.maxSize, sha1s));
        data.sha1s.forEach((item) => {
            addToSHA1Map(this.bySHA1, item.sha1, item.fileSize, node);
        });
    }

    removeNode(node) {
        console.log("removing node", node.ip + ":" + node.port);
        let nodeData = this.byNode.get(node);
        if (!nodeData) {
            console.error("We don't have", node.ip + ":" + node.port);
            return;
        }
        this.byNode.delete(node);
        nodeData.sha1s.forEach((sha1) => removeFromSHA1Map(this.bySHA1, sha1, node));
    }

    dump(query) {
        if ("clear" in query) {
            this.clear();
        }
        let ret = {
            hits: this.hits
        };

        if ("nodes" in query) {
            ret.nodes = {};
            const verbose = "verbose" in query;
            this.byNode.forEach((value, key) => {
                let data = {
                    sha1s: verbose ? value.sha1s : value.sha1s.length,
                    maxSize: prettysize(value.maxSize),
                    size: prettysize(value.size)
                };
                if (key.name) data.name = key.name;
                if (key.hostname) data.name = key.hostname;
                ret.nodes[key.ip + ":" + key.port] = data;
            });
        }

        if ("objects" in query) {
            ret.sha1 = {};
            this.bySHA1.forEach((value, key) => {
                // console.log(key, value);
                ret.sha1[key] = {
                    fileSize: prettysize(value.fileSize),
                    nodes: value.nodes.map((node) => node.ip + ":" + node.port)
                };
            });
        }

        return ret;
    }

    distribute(query, res) {
        const dry = "dry" in query;
        let redundancy = parseInt(query.redundancy);
        if (isNaN(redundancy) || redundancy <= 0) redundancy = 1;
        let max = parseInt(query.max);
        if (isNaN(max) || max <= 0) max = undefined;
        const sha1 = query.sha1;

        let ret;
        if (res) {
            ret = { type: "fetch_cache_objects", dry: dry, commands: {} };
            console.log(
                "distribute called with redundancy of",
                redundancy,
                "and max of",
                max,
                "dry",
                dry,
                "sha1",
                sha1
            );
        }

        let that = this;
        let nodes = Array.from(this.byNode.keys());
        let nodeIdx = 0;
        let commands = new Map();
        if (!sha1) {
            this.byNode.forEach((value, key) => {
                commands.set(key, { objects: [], available: value.maxSize - value.size });
            });
        }
        let nodeRestriction = query.node;
        let count = 0;
        // console.log(commands);
        if (this.byNode.size >= 2) {
            // let max = 1;
            let roundRobinIndex = 0;
            function processObject(sha1, value) {
                if (max != undefined && max <= 0) return;
                let needed = Math.min(redundancy + 1 - value.nodes.length, that.byNode.size - 1);
                if (needed > 0) {
                    let needed = redundancy + 1 - value.nodes.length;
                    // console.log("should distribute", key, "to", needed, "nodes");

                    let firstIdx;
                    let found = 0;
                    while (found < needed) {
                        if (++nodeIdx == nodes.length) nodeIdx = 0;
                        if (firstIdx === undefined) {
                            firstIdx = nodeIdx;
                        } else if (firstIdx === nodeIdx) {
                            break;
                        }
                        let node = nodes[nodeIdx];
                        if (value.nodes.indexOf(node) != -1) {
                            continue;
                        }
                        let data = commands.get(node);
                        let available;
                        if (data) {
                            available = data.available;
                        } else {
                            let nodeData = this.byNode[node];
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
                        data.objects.push({ source: src.ip + ":" + src.port, sha1: sha1 });
                        if (max != undefined && !--max) break;
                    }
                    // console.log("found candidates", candidates.map(node => node.ip + ":" + node.port));
                }
            }
            if (sha1) {
                let val = this.bySHA1.get(sha1);
                if (val) {
                    processObject(sha1, val);
                } else {
                    console.error("Couldn't find sha1", sha1);
                }
            } else {
                this.bySHA1.forEach((value, key) => processObject(key, value));
            }
        }
        commands.forEach((value, key) => {
            // console.log(key.ip + ": " + key.port, "will receive", value.objects);
            if (value.objects.length && (!nodeRestriction || key.ip + ":" + key.port == nodeRestriction)) {
                console.log(
                    `sending ${value.objects.length}/${this.bySHA1.size} fetch_cache_objects to ${key.ip}:${key.port}`
                );
                if (ret) ret[`${key.ip}:${key.port}`] = value.objects;
                count += value.objects.length;
                if (!dry) key.send({ type: "fetch_cache_objects", objects: value.objects });
            }
        });
        if (ret) {
            ret["count"] = count;
            res.send(JSON.stringify(ret, null, 4));
        } else if (res) {
        }
    }
}

module.exports = ObjectCacheManager;
