const EventEmitter = require('events');

function addToMd5Map(byMd5, md5, node)
{
    let nodes = byMd5.get(md5);
    if (nodes) {
        nodes.push(node);
    } else {
        byMd5.set(md5, [ node ]);
    }
}

function removeFromMd5Map(byMd5, md5, node)
{
    let nodes = byMd5.get(md5);
    if (nodes) {
        let idx = nodes.indexOf(node);
        if (idx != -1) {
            nodes.splice(idx, 1);
            if (nodes.length == 0) {
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
        let md5s = this.byNode.get(node);
        console.log("adding", msg.sourceFile, msg.md5, "for", node.ip + ":" + node.port, md5s ? md5s.length : -1);
        if (md5s) {
            md5s.push(msg.md5);
            addToMd5Map(this.byMd5, msg.md5, node);
        } else {
            console.error("insert: We don't seem to have this node", node.ip + ":" + node.port);
        }
    }

    remove(msg, node)
    {
        let md5s = this.byNode.get(node);
        console.log("removing", msg.sourceFile, msg.md5, "for", node.ip + ":" + node.port, md5s ? md5s.length : -1);
        if (md5s) {
            let idx = md5s.indexOf(msg.md5);
            if (idx != -1) {
                md5s.splice(idx, 1);
            } else {
                console.error("We don't have", msg.md5, "on", node.ip + ":" + node.port);
            }
            removeFromMd5Map(this.byMd5, msg.md5, node);
        } else {
            console.error("remove: We don't seem to have this node", node.ip + ":" + node.port);
        }
    }

    addNode(node, md5s)
    {
        console.log("adding object cache node", node.ip + ":" + node.port, node.name, node.hostname, md5s.length);
        if (this.byNode.get(node)) {
            console.log("We already have", node.ip + ":" + node.port);
            return;
        }
        this.byNode.set(node, md5s);
        md5s.forEach(md5 => {
            addToMd5Map(this.byMd5, md5, node);
        });
    }

    removeNode(node)
    {
        console.log("removing node", node.ip + ":" + node.port);
        let md5s = this.byNode.get(node);
        if (!md5s) {
            console.error("We don't have", node.ip + ":" + node.port);
            return;
        }
        this.byNode.delete(node);
        md5s.forEach(md5 => removeFromMd5Map(this.byMd5, md5, node));
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
            this.byNode.forEach((value, key) => {
                ret.nodes[key.ip + ":" + key.port] = value;
            });
        }

        if ("objects" in query) {
            ret.md5 = {};
            this.byMd5.forEach((value, key) => {
                ret.md5[key] = value.map(node => node.ip + ":" + node.port);
            });
        }

        return ret;
    }
};

module.exports = ObjectCacheManager;
