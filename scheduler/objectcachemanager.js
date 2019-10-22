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
    } else {
        byMd5.set(md5, new Md5Data(fileSize, node));
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
    constructor()
    {
        super();
        this.hits = 0;
        this.byMd5 = new Map();
        this.byNode = new Map();
    }

    clear()
    {
        this.hits = 0;
        this.emit("cleared");
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
            addToMd5Map(this.byMd5, msg.md5, msg.fileSize, node);
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
            nodeData.size = msg.size;
        } else {
            console.error("remove: We don't seem to have this node", node.ip + ":" + node.port);
        }
    }

    addNode(node, data)
    {
        console.log("adding object cache node",
                    node.ip + ":" + node.port,
                    node.name, node.hostname,
                    "maxSize", data.maxSize,
                    "cacheSize", data.cacheSize,
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
                    md5s: verbose ? value.md5s : (value.md5s.length + " entries"),
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

    distribute(redundancy)
    {
        let nodes = Array.from(this.byNode.keys());
        let nodeIdx = 0;
        function nextNode(disqualified, size)
        {
            const oldIdx = nodeIdx;
        }
        this.byMd5.forEach((value, key) => {
            // if (value.length < redundancy + 1) {
                // if (
            // }
        });
    }
};

module.exports = ObjectCacheManager;
