#!/usr/bin/env node

// npm does not fail when a path listed in "files" is absent -- it just leaves it
// out of the tarball. That is how 5.0.16 reached the registry containing nothing
// but LICENSE, README.md and package.json, which made every scheduler spawn its
// entrypoint from a directory that did not exist and take the fleet down. Build
// output is untracked, so a clean checkout publishes an empty package silently.
// This turns that into a failed publish instead.

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const { files, name, version } = require(path.join(root, "package.json"));

if (!Array.isArray(files) || !files.length) {
    console.error(`${name}: package.json has no "files" array, refusing to publish blind.`);
    process.exit(1);
}

const problems = [];
for (const relative of files) {
    const absolute = path.join(root, relative);
    let stat;
    try {
        stat = fs.statSync(absolute);
    } catch (err) {
        problems.push(`${relative}: missing`);
        continue;
    }
    if (!stat.isFile()) {
        problems.push(`${relative}: not a regular file`);
    } else if (!stat.size) {
        problems.push(`${relative}: empty`);
    }
}

if (problems.length) {
    console.error(`Refusing to publish ${name}@${version} -- run "npm run build" first:`);
    for (const problem of problems) {
        console.error(`    ${problem}`);
    }
    process.exit(1);
}

console.log(`${name}@${version}: all ${files.length} published files present.`);
