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

    insert(md5, node)
    {
        console.log("adding", md5, "for", node.ip + ":" + node.port);
        this.byNode.get(node).push(md5);
        addToMd5Map(this.byMd5, md5, node);
    }

    remove(md5, node)
    {
        console.log("removing", md5, "for", node.ip + ":" + node.port);
        let md5s = this.byNode.get(node);
        let idx = md5s.indexOf(md5);
        if (idx != -1) {
            md5s.splice(idx, 1);
        } else {
            console.error("We don't have", md5, "on", node.ip + ":" + node.port);
        }
        removeFromMd5Map(this.byMd5, md5, node);
    }

    addNode(node, md5s)
    {
        console.log("adding node", node.ip + ":" + node.port, md5s.length);
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
