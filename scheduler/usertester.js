#!/usr/bin/env node

const WebSocket = require("ws");
const crypto = require("crypto");
const argv = require("minimist")(process.argv.slice(2));

// console.log("shit");
const ws = new WebSocket((argv.scheduler || "ws://localhost:8097") + "/monitor");
ws.on("upgrade", res => {
    // console.log("GOT HEADERS", res.headers);
    ws.nonce = res.headers["x-fisk-nonce"];
});
ws.on("open", () => {
    console.log("got open", argv, ws.nonce);
    if (argv.addUser) {
        console.log("addUser");
        ws.send(JSON.stringify({type: "addUser", user: "agbakken@gmail.com", password: "ball1"}));
    } else if (argv.cookie) {
        let hmac = crypto.createHmac("sha512", Buffer.from(argv.cookie, "base64"));
        hmac.write(ws.nonce);
        hmac.end();
        const msg = { type: "login", user: "agbakken@gmail.com", hmac: hmac.read().toString("base64") };
        ws.send(JSON.stringify(msg));
        console.log(`cookie login ${JSON.stringify(msg, null, 4)}`);
    } else if (argv.login) {
        ws.send(JSON.stringify({type: "login", user: "agbakken@gmail.com", password: "ball1"}));
        console.log("login");
    } else if (argv.removeUser) {
        ws.send(JSON.stringify({type: "login", "user": "agbakken@gmail.com", "password": "ball1"}));
        setTimeout(() => {
            ws.send(JSON.stringify({type: "removeUser", "user": "agbakken@gmail.com"}));
            console.log("removeUser");
        }, 2000);
    }
});
ws.on("headers", (headers, res) => {
    console.log("Got headers", headers);
});
// setInterval(() => {
//     console.log("fuck");
// }, 1000);
ws.on("error", err => {
    console.log("got error", err);
});
ws.on("message", msg => {
    console.log("Got message", JSON.stringify(JSON.parse(msg), null, 4));
});







