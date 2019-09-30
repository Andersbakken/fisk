#!/usr/bin/env node

const option = require('@jhanssen/options')({ prefix: 'fisk/monitor',
                                              applicationPath: false,
                                              additionalFiles: [ "fisk/monitor.conf.override" ] });
const WebSocket = require('ws');
const fs = require('fs');
const blessed = require('blessed');

const screen = blessed.screen({
    smartCSR: true
});

const slaveContainer = blessed.box({
    top: '0%',
    left: '0%',
    width: '50%',
    height: '100%-3',
    border: {
        type: 'line'
    }
});

screen.on("resize", () => {
    // log("resize", slaveContainer.width, slaveContainer.height);

    updateSlaveBox();
    updateClientBox();

    screen.render();
});

const slaveHeader = blessed.box({
    top: '0%',
    left: '0%',
    width: '100%-2',
    height: '0%+1',
    tags: true,
    style: {
        fg: 'white',
        bg: 'blue',
        border: {
            fg: '#f0f0f0'
        }
    }
});

const slaveBox = blessed.box({
    top: '0%+1',
    left: '0%',
    width: '100%-2',
    height: '100%-3',
    tags: true,
    scrollable: true,
    scrollbar: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    style: {
        fg: 'white',
        bg: 'black',
        border: {
            fg: '#f0f0f0'
        },
        scrollbar: {
            bg: 'red',
            fg: 'blue'
        }
    }
});

const clientContainer = blessed.box({
    top: '0%',
    left: '50%',
    width: '50%',
    height: '100%-3',
    border: {
        type: 'line'
    }
});

const clientHeader = blessed.box({
    top: '0%',
    left: '0%',
    width: '100%-2',
    height: '0%+1',
    tags: true,
    style: {
        fg: '#000000',
        bg: '#00ff00',
        border: {
            fg: '#f0f0f0'
        }
    }
});

const clientBox = blessed.box({
    top: '0%+1',
    left: '0%',
    width: '100%-2',
    height: '100%-3',
    tags: true,
    scrollable: true,
    scrollbar: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    style: {
        fg: 'white',
        bg: '#404040',
        border: {
            fg: '#f0f0f0'
        },
        scrollbar: {
            bg: 'red',
            fg: 'blue'
        }
    }
});

const notificationBox = blessed.box({
    top: '100%-3',
    left: '0%',
    width: '100%',
    height: '0%+3',
    tags: true,
    border: {
        type: 'line'
    },
    style: {
        fg: 'white',
        bg: 'cyan',
        border: {
            fg: '#f0f0f0'
        },
        hover: {
            bg: 'green'
        }
    }
});

slaveContainer.append(slaveHeader);
slaveContainer.append(slaveBox);
clientContainer.append(clientHeader);
clientContainer.append(clientBox);
screen.append(slaveContainer);
screen.append(clientContainer);
screen.append(notificationBox);

let currentFocus = slaveBox;
slaveBox.focus();

function activate(box)
{
    if (currentFocus == box)
        return;

    currentFocus.style.bg = '#404040';
    currentFocus = box;

    box.style.bg = '#000000';
    box.focus();
    screen.render();
}

function focusRight()
{
    if (currentFocus == slaveBox) {
        activate(clientBox);
    }
}

function focusLeft()
{
    if (currentFocus == clientBox) {
        activate(slaveBox);
    }
}

// Quit on Escape, q, or Control-C.
screen.key(['escape', 'q', 'C-c'], function(ch, key) {
    return process.exit(0);
});
screen.key(['right', 'l'], function(ch, key) {
    focusRight();
});
screen.key(['left', 'h'], function(ch, key) {
    focusLeft();
});
slaveBox.on('click', function() {
    activate(slaveBox);
});
clientBox.on('click', function() {
    activate(clientBox);
});

screen.render();

let notificationInterval;
let notifications = [];

function notify(msg)
{
    if (notificationInterval) {
        if (notifications.length == 5)
            notifications.splice(0, 1);
        notifications.push(msg);
        return;
    }

    const notifyNow = msg => {
        notificationBox.setContent(msg);
        screen.render();
    };

    notificationInterval = setInterval(() => {
        if (notifications.length == 0) {
            clearInterval(notificationInterval);
            notificationInterval = undefined;
            notifyNow();
            return;
        }

        notifyNow(notifications.shift());
    }, 2000);

    notifyNow(msg);
}

let scheduler = option("scheduler", "ws://localhost:8097");
if (scheduler.indexOf('://') == -1)
    scheduler = "ws://" + scheduler;
if (!/:[0-9]+$/.exec(scheduler))
    scheduler += ":8097";

function log(...args)
{
    const str = args.map(elem => typeof elem === "object" ? JSON.stringify(elem) : elem).join(" ");
    fs.appendFileSync("/tmp/fisk-monitor.log", str + "\n");
}

try {
    fs.unlinkSync("/tmp/fisk-monitor.log");
} catch (e) {
}

const slaves = new Map();
const jobs = new Map();
const jobsForClient = new Map();

function clearData()
{
    slaves.clear();
    jobs.clear();
    jobsForClient.clear();

    update();
}

function formatCell(str, num, prefix, suffix)
{
    return (prefix || "") + (" " + str).padEnd(num, " ").substr(0, num) + (suffix || "");
}

let updateTimer;
let timeout = 0;

function updateSlaveBox()
{
    const slaveWidth = slaveContainer.width - 3;
    log("slave width", slaveWidth);

    let data = [];
    let maxWidth = [6, 8, 7, 7];
    for (let [key, value] of slaves) {
        const line = [key, `${value.active}`, `${value.jobsPerformed}`, `${value.slots}`];
        data.push(line);

        maxWidth[0] = Math.max(maxWidth[0], line[0].length + 2);
        maxWidth[1] = Math.max(maxWidth[1], line[1].length + 2);
        maxWidth[2] = Math.max(maxWidth[2], line[2].length + 2);
        maxWidth[3] = Math.max(maxWidth[3], line[3].length + 2);
    }
    data.sort((a, b) => {
        let an = parseInt(a[1]);
        let bn = parseInt(b[1]);
        if (an != bn)
            return bn - an;
        an = parseInt(a[2]);
        bn = parseInt(b[2]);
        if (an != bn)
            return bn - an;
        return a[0].localeCompare(b[0]);
    });

    let used = 0;
    for (let i = 0; i < maxWidth.length; ++i) {
        if (used + maxWidth[i] > slaveWidth)
            maxWidth[i] = slaveWidth - used;
        used += maxWidth[i];
    }
    let header = "";
    header += formatCell("Host", maxWidth[0], "{bold}", "{/bold}");
    header += formatCell("Active", maxWidth[1], "{bold}", "{/bold}");
    header += formatCell("Total", maxWidth[2], "{bold}", "{/bold}");
    header += formatCell("Slots", maxWidth[3], "{bold}", "{/bold}");
    slaveHeader.setContent(header);
    let str = "";
    for (let i = 0; i < data.length; ++i) {
        str += formatCell(data[i][0], maxWidth[0]);
        str += formatCell(data[i][1], maxWidth[1]);
        str += formatCell(data[i][2], maxWidth[2]);
        str += formatCell(data[i][3], maxWidth[3]);
        if (i + 1 < data.length)
            str += "\n";
    }

    slaveBox.setContent(str);
}

function updateClientBox()
{
    const clientWidth = clientContainer.width - 3;

    let data = [];
    let maxWidth = [6, 6, 7];
    for (let [key, value] of jobsForClient) {
        const line = [key, `${value.size - 1}`, `${value.get("total")}`];
        data.push(line);

        maxWidth[0] = Math.max(maxWidth[0], line[0].length + 2);
        maxWidth[1] = Math.max(maxWidth[1], line[1].length + 2);
        maxWidth[2] = Math.max(maxWidth[2], line[2].length + 2);
    }

    data.sort((a, b) => a[0].localeCompare(b[0]));

    let used = 0;
    for (let i of [1, 2, 0]) {
        if (used + maxWidth[i] > clientWidth)
            maxWidth[i] = clientWidth - used;
        used += maxWidth[i];
    }

    let header = "";
    header += formatCell("Name", maxWidth[0], "{bold}", "{/bold}");
    header += formatCell("Jobs", maxWidth[1], "{bold}", "{/bold}");
    header += formatCell("Total", maxWidth[2], "{bold}", "{/bold}");
    clientHeader.setContent(header);

    let str = "";
    for (let i = 0; i < data.length; ++i) {
        str += formatCell(data[i][0], maxWidth[0]);
        str += formatCell(data[i][1], maxWidth[1]);
        str += formatCell(data[i][2], maxWidth[2]);
        if (i + 1 < data.length)
            str += "\n";
    }

    clientBox.setContent(str);
}

function update()
{
    //let data = [];
    if (updateTimer)
        return;
    updateTimer = setTimeout(() => {
        updateTimer = undefined;
        timeout = 500;

        updateSlaveBox();
        updateClientBox();

        screen.render();
    }, timeout);
}

function slaveAdded(msg)
{
    msg.active = 0;
    slaves.set(msg.ip + ":" + msg.port, msg);
    update();
}

function slaveRemoved(msg)
{
    const slaveKey = msg.ip + ":" + msg.port;

    for (let job of jobs) {
        const jobSlaveKey = `${job.slave.ip}:${job.slave.port}`;
        if (slaveKey === jobSlaveKey) {
            deleteJob(job);
        }
    }

    slaves.delete(slaveKey);
    update();
}

function clientName(client)
{
    if ("name" in client) {
        if (client.name === client.hostname) {
            return "dev:" + (client.user || "nobody") + "@" + client.hostname;
        } else if (client.name.length > 0 && client.name[0] === '-') {
            return "dev:" + (client.user || "nobody") + client.name;
        }
        try {
            const o = JSON.parse(client.name);
            if (typeof o === "object" && "name" in o)
                return o.name;
        } catch (e) {
        }
        return client.name;
    }
    return client.ip;
}

function jobStarted(job)
{
    log(job);
    const slaveKey = `${job.slave.ip}:${job.slave.port}`;
    const slave = slaves.get(slaveKey);
    if (!slave)
        return;

    const clientKey = clientName(job.client);
    let client = jobsForClient.get(clientKey);
    if (!client) {
        client = new Map([["total", 1]]);
        jobsForClient.set(clientKey, client);
    } else {
        client.set("total", client.get("total") + 1);
    }
    client.set(job.id, job);

    jobs.set(job.id, job);
    ++slave.jobsPerformed;
    ++slave.active;
    update();
}

function deleteJob(job)
{
    const clientKey = clientName(job.client);
    let client = jobsForClient.get(clientKey);
    if (client) {
        client.delete(job.id);
        if (client.size == 1) {
            jobsForClient.delete(clientKey);
        }
    }
}

function jobFinished(job)
{
    const activejob = jobs.get(job.id);
    if (!activejob)
        return;
    jobs.delete(job.id);

    deleteJob(activejob);

    const key = `${activejob.slave.ip}:${activejob.slave.port}`;
    const slave = slaves.get(key);
    if (!slave)
        return;
    --slave.active;
    update();
}

let ws;

function send(msg)
{
    if (typeof msg != "string") {
        ws.send(JSON.stringify(msg));
    } else {
        ws.send(msg);
    }
}

function connect()
{
    const url = `${scheduler}/monitor`;
    notify(`connect ${url}`);
    ws = new WebSocket(url);
    ws.on("open", () => {
        notify("open");
        send({ type: "sendInfo" });
    });
    ws.on("error", err => {
        notify(`client websocket error ${err.message}`);
    });
    ws.on("message", msg => {
        //notify(`msg ${msg}`);
        let obj;
        try {
            obj = JSON.parse(msg);
        } catch (e) {
            notify(`msg parse error: ${msg}, ${e}`);
        }
        switch (obj.type) {
        case "slaveAdded":
            slaveAdded(obj);
            break;
        case "slaveRemoved":
            slaveRemoved(obj);
            break;
        case "jobStarted":
            jobStarted(obj);
            break;
        case "jobFinished":
        case "jobAborted":
            jobFinished(obj);
            break;
        default:
            //log(obj);
            break;
        }
    });
    ws.on("close", () => {
        clearData();
        setTimeout(connect, 1000);
    });
}

connect();
