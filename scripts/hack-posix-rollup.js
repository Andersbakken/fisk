#!/usr/bin/env node

const fs = require("fs/promises");
const path = require("path");

async function hack(file)
{
    let contents = await fs.readFile(file, "utf8");
    const idx = contents.indexOf("posix.node");
    if (idx !== -1) {
        const dotDot = contents.lastIndexOf("'../..'", idx);
        if (dotDot !== -1 && idx - dotDot < 1024) {
            const changed = `${contents.substring(0, dotDot)}'../node_modules/posix'${contents.substring(dotDot + 7)}`;
            console.log("Modified", file);
            await fs.writeFile(file, changed);
       }
    }
}

Promise.all(["scheduler/fisk-scheduler.js", "builder/VM_runtime.js" ].map(hack));
