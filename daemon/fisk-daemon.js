#!/usr/bin/env node

const option = require("@jhanssen/options")("fisk/daemon", require('minimist')(process.argv.slice(2)));
const request = require("request");
const ws = require('ws');
const common = require("../common")(option);
const Server = require("./server");
const Client = require("./client");

process.on('unhandledRejection', (reason, p) => {
    console.log('Unhandled Rejection at: Promise', p, 'reason:', reason.stack);
    if (client)
        client.send("log", { message: `Unhandled Rejection at: Promise ${p}, reason: ${reason.stack}` });

});

process.on('uncaughtException', err => {
    console.error("Uncaught exception", err);
    if (client)
        client.send("log", { message: `Uncaught exception ${err.toString()} ${err.stack}` });
});


const debug = option("debug");
const client = new Client(option, common.Version);

let connectInterval;
client.on("quit", message => {
    process.exit(message.code);
});

client.on("connect", () => {
    console.log("connected");
    if (connectInterval) {
        clearInterval(connectInterval);
        connectInterval = undefined;
    }
});

client.on("error", err => {
    console.error("client error", err);
});

client.on("close", () => {
    console.log("client closed");
    if (!connectInterval) {
        connectInterval = setInterval(() => {
            console.log("Reconnecting...");
            client.connect(Object.keys(environments));
        }, 1000);
    }
});

const server = new Server(option, common);
server.listen().then(() => {
    console.log("listening");
});

// server.on("message

server.on("error", (err) => {
    console.error("server error", err);
});

process.on('exit', () => {
    server.close();
});

process.on('SIGINT', sig => {
    server.close();
});
