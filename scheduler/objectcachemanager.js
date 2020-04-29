const EventEmitter = require('events');

function prettysize(bytes)
{
    const prettysize = require('prettysize');
    return prettysize(bytes, bytes >= 1024); // don't want 0Bytes
}

class NodeData
{
    constructor(size, maxSize, md5s)
    {
        this.md5s = md5s;
        this.size = size;
        this.maxSize = maxSize;
    }
};

class Md5Data
{
    constructor(fileSize, node)
    {
        this.fileSize = fileSize;
        this.nodes = [ node ];
    }
};

function addToMd5Map(byMd5, md5, fileSize, node)
{
    let data = byMd5.get(md5);
    if (data) {
        data.nodes.push(node);
        return data.nodes.length;
    } else {
        byMd5.set(md5, new Md5Data(fileSize, node));
        return 1;
    }
}

function removeFromMd5Map(byMd5, md5, node)
{
    let data = byMd5.get(md5);
    if (data) {
        let idx = data.nodes.indexOf(node);
        if (idx != -1) {
            data.nodes.splice(idx, 1);
            if (data.nodes.length == 0) {
                byMd5.delete(md5);
            }
        } else {
            console.error("We don't have", node.ip + ":" + node.port, "for", md5);
        }
    } else {
        console.error("We don't have", md5);
    }
}

class ObjectCacheManager extends EventEmitter
{
    constructor(option)
    {
        super();
        this.hits = 0;
        this.byMd5 = new Map();
        this.byNode = new Map();
        this.redundancy = option.int("object-cache-redundancy", 1);
        if (this.redundancy <= 0)
            this.redundancy = 1;
        this.distributeOnInsertion = option("distribute-object-cache-on-insertion") || false;
        this.distributeOnCacheHit = option("distribute-object-cache-on-cache-hit") || false;
    }

    clear()
    {
        this.hits = 0;
        this.emit("cleared");
    }

    hit(md5)
    {
        ++this.hits;
        if (this.distributeOnCacheHit) {
            this.distribute({ md5: md5, redundancy: this.redundancy });
        }
    }

    get(md5)
    {
        // console.log("looking for", md5, [ this.byMd5.keys() ]);
        return this.byMd5.get(md5);
    }

    insert(msg, node)
    {
        let nodeData = this.byNode.get(node);
        console.log("adding", msg.sourceFile, msg.md5, "for", node.ip + ":" + node.port, nodeData ? nodeData.md5s.length : -1);
        if (nodeData) {
            nodeData.md5s.push(msg.md5);
            nodeData.size = msg.cacheSize;
            const count = addToMd5Map(this.byMd5, msg.md5, msg.fileSize, node);
            if (this.distributeOnInsertion && count - 1 < this.redundancy) {
                this.distribute({ md5: msg.md5, redundancy: this.redundancy });
            }
        } else {
            console.error("insert: We don't seem to have this node", node.ip + ":" + node.port);
        }
    }

    remove(msg, node)
    {
        let nodeData = this.byNode.get(node);
        console.log("removing", msg.sourceFile, msg.md5, "for", node.ip + ":" + node.port, nodeData ? nodeData.md5s.length : -1);
        if (nodeData) {
            let idx = nodeData.md5s.indexOf(msg.md5);
            if (idx != -1) {
                nodeData.md5s.splice(idx, 1);
            } else {
                console.error("We don't have", msg.md5, "on", node.ip + ":" + node.port);
            }
            removeFromMd5Map(this.byMd5, msg.md5, node);
            nodeData.size = msg.cacheSize;
        } else {
            console.error("remove: We don't seem to have this node", node.ip + ":" + node.port);
        }
    }

    addNode(node, data)
    {
        console.log("adding object cache node",
                    node.ip + ":" + node.port,
                    node.name, node.hostname,
                    "maxSize", prettysize(data.maxSize),
                    "cacheSize", prettysize(data.cacheSize),
                    "md5s", data.md5s.length);
        if (this.byNode.get(node)) {
            console.log("We already have", node.ip + ":" + node.port);
            return;
        }
        let md5s = data.md5s.map(item => item.md5);
        this.byNode.set(node, new NodeData(data.cacheSize, data.maxSize, md5s));
        data.md5s.forEach(item => {
            addToMd5Map(this.byMd5, item.md5, item.fileSize, node);
        });
    }

    removeNode(node)
    {
        console.log("removing node", node.ip + ":" + node.port);
        let nodeData = this.byNode.get(node);
        if (!nodeData) {
            console.error("We don't have", node.ip + ":" + node.port);
            return;
        }
        this.byNode.delete(node);
        nodeData.md5s.forEach(md5 => removeFromMd5Map(this.byMd5, md5, node));
    }

    dump(query)
    {
        if ("clear" in query) {
            this.clear();
        }
        let ret = {
            hits: this.hits,
        };

        if ("nodes" in query) {
            ret.nodes = {};
            const verbose = "verbose" in query;
            this.byNode.forEach((value, key) => {
                let data =  {
                    md5s: verbose ? value.md5s : value.md5s.length,
                    maxSize: prettysize(value.maxSize),
                    size: prettysize(value.size)
                };
                if (key.name)
                    data.name = key.name;
                if (key.hostname)
                    data.name = key.hostname;
                ret.nodes[key.ip + ":" + key.port] = data;
            });
        }

        if ("objects" in query) {
            ret.md5 = {};
            this.byMd5.forEach((value, key) => {
                // console.log(key, value);
                ret.md5[key] = { fileSize: prettysize(value.fileSize), nodes: value.nodes.map(node => node.ip + ":" + node.port) };
            });
        }

        return ret;
    }

    distribute(query, res)
    {
        const dry = "dry" in query;
        let redundancy = parseInt(query.redundancy);
        if (isNaN(redundancy) || redundancy <= 0)
            redundancy = 1;
        let max = parseInt(query.max);
        if (isNaN(max) || max <= 0)
            max = undefined;
        const md5 = query.md5;

        let ret;
        if (res) {
            ret = { type: "fetch_cache_objects", "dry": dry, commands: {} };
            console.log("distribute called with redundancy of", redundancy, "and max of", max, "dry", dry, "md5", md5);
        }

        let that = this;
        let nodes = Array.from(this.byNode.keys());
        let nodeIdx = 0;
        let commands = new Map();
        if (!md5) {
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
            function processObject(md5, value)
            {
                if (max != undefined && max <= 0)
                    return;
                let needed = Math.min(redundancy + 1 - value.nodes.length, that.byNode.size - 1);
                if (needed > 0) {
                    let needed = redundancy + 1 - value.nodes.length;
                    // console.log("should distribute", key, "to", needed, "nodes");

                    let firstIdx;
                    let found = 0;
                    while (found < needed) {
                        if (++nodeIdx == nodes.length)
                            nodeIdx = 0;
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
                        data.objects.push({ source: src.ip + ":" + src.port, md5: md5 });
                        if (max != undefined && !--max)
                            break;
                    }
                    // console.log("found candidates", candidates.map(node => node.ip + ":" + node.port));
                }
            }
            if (md5) {
                let val = this.byMd5.get(md5);
                if (val) {
                    processObject(md5, val);
                } else {
                    console.error("Couldn't find md5", md5);
                }
            } else {
                this.byMd5.forEach((value, key) => processObject(key, value));
            }
        }
        commands.forEach((value, key) => {
            // console.log(key.ip + ": " + key.port, "will receive", value.objects);
            if (value.objects.length && (!nodeRestriction || (key.ip + ":" + key.port) == nodeRestriction)) {
                console.log(`sending ${value.objects.length}/${this.byMd5.size} fetch_cache_objects to ${key.ip}:${key.port}`);
                if (ret)
                    ret[`${key.ip}:${key.port}`] = value.objects;
                count += value.objects.length;
                if (!dry)
                    key.send({ type: "fetch_cache_objects", objects: value.objects });
            }
        });
        if (ret) {
            ret["count"] = count;
            res.send(JSON.stringify(ret, null, 4));
        } else if (res) {

        }
    }
};

module.exports = ObjectCacheManager;
