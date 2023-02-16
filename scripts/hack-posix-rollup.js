#!/usr/bin/env node

const fs = require("fs/promises");
const path = require("path");

async function hack(file)
{
    const contents = await fs.readFile(file, "utf8");
    const idx = contents.indexOf("posix.node");
    if (idx === -1)
        return;
    const dotDot = contents.lastIndexOf("'../..'", idx);
    if (dotDot === -1 || idx - dotDot >= 1024)
        return;

    const changed = `${contents.substring(0, dotDot)}'../../posix'${contents.substring(dotDot + 7)}`;
    await fs.writeFile(file, changed);
    console.log("changed", file);
}

(async () => Promise.all((await fs.readdir("dist")).map(x => hack(path.join("dist", x)))))();
