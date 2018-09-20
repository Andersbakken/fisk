#!/usr/bin/env node

const WebSocket = require("ws");
const argv = require("minimist")(process.argv.slice(2));

const ws = new WebSocket((argv.scheduler || "ws://localhost:8097") + "/monitor");
ws.on("open", () => {
    console.log("got open", argv);
    if (argv.addUser) {
        console.log("addUser");
        ws.send(JSON.stringify({type: "addUser", "user": "agbakken@gmail.com", "password": "ball1"}));
    } else if (argv.login) {
        ws.send(JSON.stringify({type: "login", "user": "agbakken@gmail.com", "password": "ball1"}));
        console.log("login");
    } else if (argv.removeUser) {
        ws.send(JSON.stringify({type: "login", "user": "agbakken@gmail.com", "password": "ball1"}));
        setTimeout(() => {
            ws.send(JSON.stringify({type: "removeUser", "user": "agbakken@gmail.com"}));
            console.log("removeUser");
        }, 2000);
    }
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







