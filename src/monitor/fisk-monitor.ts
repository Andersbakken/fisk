#!/usr/bin/env node

import blessed, { Widgets } from "blessed";
// import fs from "fs";
import {
    BuilderAddedMessage,
    BuilderAddedOrRemovedBase,
    BuilderRemovedMessage
} from "../common-ts/BuilderAddedOrRemovedMessage";
import { JobMonitorMessage, JobMonitorMessageClient } from "../common-ts/JobMonitorMessage";
import { JobMonitorMessageBase } from "../common-ts/JobMonitorMessage";
import WebSocket from "ws";
import assert from "assert";
import humanize, { Unit } from "humanize-duration";
import options, { OptionsFunction } from "@jhanssen/options";

const option: OptionsFunction = options({
    prefix: "fisk/monitor",
    noApplicationPath: true,
    additionalFiles: ["fisk/monitor.conf.override"]
});

function humanizeDuration(age: number): string {
    let units: Unit[] = [];
    if (age < 60000) {
        units = ["s"];
    } else if (age < 60 * 60000) {
        units = ["m", "s"];
    } else if (age < 24 * 60 * 60000) {
        units = ["h", "m"];
    } else if (age < 7 * 24 * 60 * 60000) {
        units = ["d", "h"];
    } else {
        units = ["y", "mo", "w", "d"];
    }
    const options = { units, round: true };
    return humanize(age, options);
}

const scrollbar = {
    ch: " ",
    track: {
        bg: "cyan"
    },
    style: {
        inverse: true
    }
};

const screen = blessed.screen({
    smartCSR: true
});

const builderContainer = blessed.box({
    top: "0%",
    left: "0%",
    width: "50%",
    height: "100%-3",
    border: {
        type: "line"
    }
});

screen.on("resize", () => {
    // log("resize", builderContainer.width, builderContainer.height);

    updateBuilderBox();
    updateClientBox();

    screen.render();
});

const builderHeader = blessed.box({
    top: "0%",
    left: "0%",
    width: "100%-2",
    height: "0%+1",
    tags: true,
    style: {
        border: {
            fg: "#f0f0f0"
        }
    }
});

const prompt = blessed.prompt({
    parent: screen,
    top: "center",
    left: "center",
    height: "shrink",
    width: "shrink",
    keys: true,
    style: {
        fg: "white"
    },
    vi: true,
    mouse: true,
    tags: true,
    border: "line",
    hidden: true
});

const builderBox = blessed.list({
    top: "0%+1",
    left: "0%",
    width: "100%-2",
    height: "100%-3",
    tags: true,
    scrollable: true,
    scrollbar,
    alwaysScroll: true,
    mouse: true,
    keys: true,
    vi: true,
    style: {},
    search: (callback) => {
        prompt.input("Search:", "", (err, value) => {
            if (err) {
                return undefined;
            }
            return callback(null, value);
        });
    }
});

let selectedBuilder: string | undefined;

const headerBoxes = new WeakMap<Widgets.ListElement, Widgets.BoxElement>();

function setHeaderBox(box: Widgets.ListElement, header: Widgets.BoxElement): void {
    headerBoxes.set(box, header);
}

function getHeaderBox(box: Widgets.ListElement): Widgets.BoxElement {
    const ret = headerBoxes.get(box);
    assert(ret);
    return ret;
}
setHeaderBox(builderBox, builderHeader);

const clientContainer = blessed.box({
    top: "0%",
    left: "50%",
    width: "50%",
    height: "100%-3",
    border: {
        type: "line"
    }
});

const clientHeader = blessed.box({
    top: "0%",
    left: "0%",
    width: "100%-2",
    height: "0%+1",
    tags: true,
    style: {
        border: {
            fg: "#f0f0f0"
        }
    }
});

const clientBox = blessed.list({
    top: "0%+1",
    left: "0%",
    width: "100%-2",
    height: "100%-3",
    tags: true,
    scrollable: true,
    scrollbar,
    mouse: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    style: {}
});
setHeaderBox(clientBox, clientHeader);

let selectedClient: string | undefined;

const notificationBox = blessed.box({
    top: "100%-3",
    left: "0%",
    width: "100%",
    height: "0%+3",
    tags: true,
    border: {
        type: "line"
    },
    style: {
        fg: "white",
        bg: "cyan",
        border: {
            fg: "#f0f0f0"
        }
    }
});

builderContainer.append(builderHeader);
builderContainer.append(builderBox);
clientContainer.append(clientHeader);
clientContainer.append(clientBox);
screen.append(builderContainer);
screen.append(clientContainer);
screen.append(notificationBox);

let builderDialogBox: Widgets.BoxElement | undefined;
let clientDialogBox: Widgets.BoxElement | undefined;

function hideDialogBoxes() {
    let ret = false;
    if (builderDialogBox) {
        builderDialogBox.detach();
        builderDialogBox = undefined;
        ret = true;
    }

    if (clientDialogBox) {
        clientDialogBox.detach();
        clientDialogBox = undefined;
        ret = true;
    }
    return ret;
}

builderBox.on("select", (ev: Widgets.BoxElement) => {
    let render = hideDialogBoxes();
    activate(builderBox);
    if (ev) {
        const match = /^ *([^ ]*)/.exec(ev.content);
        assert(match && match[1]);
        const builderKey = match[1];
        const builder = builders.get(builderKey);
        if (builder) {
            // builderBox.current = builderKey;
            let str = "";
            for (const key in builder) {
                const value = builder[key];
                if (Array.isArray(value)) {
                    str += `{bold}${key}{/bold}: ${value[0]}\n`;
                    for (let i = 1; i < value.length; ++i) {
                        const pad = "".padStart(key.length + 2, " ");
                        str += pad + value[i].padStart(key.length + 2, " ") + "\n";
                    }
                } else {
                    str += `{bold}${key}{/bold}: ${value}\n`;
                }
            }
            builderDialogBox = blessed.box({
                top: "center",
                left: "center",
                width: "80%",
                height: "50%",
                content: str,
                tags: true,
                border: {
                    type: "line"
                },
                style: {
                    fg: "white",
                    bg: "#0f0f0f",
                    border: {
                        fg: "#f0f0f0"
                    }
                }
            });
            screen.append(builderDialogBox);
            render = true;
        }
    }
    if (render) {
        screen.render();
    }
});

clientBox.on("select", (ev) => {
    let render = hideDialogBoxes();
    activate(clientBox);
    if (ev) {
        // log("got ev", Object.keys(ev), ev.index, ev.$, ev.data);
        const match = /^ *([^ ]*)/.exec(ev.content);
        assert(match && match[1]);
        const clientKey = match[1];
        const jobs = jobsForClient.get(clientKey);
        // let client = clients.get(clientKey);
        if (jobs) {
            // clientBox.current = clientKey;
            let str = "";
            const data: Array<[string, string, string]> = [["Source file", "Builder", "Start time"]];
            const widest = [data[0][0].length + 1, data[0][1].length + 1];
            const now = Date.now();
            for (const [jobKey, jobValue] of jobs) {
                if (jobKey === "total") {
                    continue;
                }
                widest[0] = Math.max(jobValue.sourceFile.length + 1, widest[0]);
                data.push([
                    jobValue.sourceFile,
                    jobValue.builder.ip + ":" + jobValue.builder.port,
                    humanizeDuration(now - jobValue.time)
                ]);
                widest[1] = Math.max(widest[1], data[data.length - 1][1].length + 1);
            }

            data.sort((a: [string, string, string], b: [string, string, string]) => parseInt(a[2]) - parseInt(b[2]));

            data.forEach((line, idx) => {
                if (!idx) {
                    str += "{bold}";
                }
                str += line[0].padEnd(widest[0]) + "  " + line[1].padEnd(widest[1]) + "  " + line[2] + " ago\n";
                if (!idx) {
                    str += "{/bold}";
                }
            });
            clientDialogBox = blessed.box({
                top: "center",
                left: "center",
                width: "80%",
                height: "50%",
                content: str,
                tags: true,
                border: {
                    type: "line"
                },
                style: {
                    fg: "white",
                    bg: "#0f0f0f",
                    border: {
                        fg: "#f0f0f0"
                    }
                }
            });
            screen.append(clientDialogBox);
            render = true;
        }
    }
    if (render) {
        screen.render();
    }
});

let currentFocus: Widgets.ListElement | undefined;
function activate(box: Widgets.ListElement) {
    if (currentFocus === box) {
        return;
    }

    if (currentFocus) {
        currentFocus.style = {
            selected: {
                bg: "#606060",
                bold: true
            },
            item: {
                bg: "#404040"
            },
            fg: "white",
            bg: "#404040",
            border: {
                fg: "#f0f0f0"
            },
            scrollbar: {
                bg: "#770000"
            }
        };
        const oldHeader = getHeaderBox(currentFocus);
        oldHeader.style.fg = "white";
        oldHeader.style.bg = "#004400";
    }

    currentFocus = box;
    currentFocus.style = {
        selected: {
            bg: "blue",
            bold: true
        },
        item: {
            bg: "black"
        },
        fg: "white",
        bg: "black",
        border: {
            fg: "#f0f0f0"
        },
        scrollbar: {
            bg: "red"
        }
    };
    const newHeader = getHeaderBox(currentFocus);
    newHeader.style.fg = "white";
    newHeader.style.bg = "#00ff00";
    currentFocus.focus();
    screen.render();
}

activate(builderBox);
activate(clientBox);

function focusRight() {
    if (currentFocus === builderBox) {
        activate(clientBox);
    }
}

function focusLeft() {
    if (currentFocus === clientBox) {
        activate(builderBox);
    }
}

// Quit on Escape, q, or Control-C.
screen.key(["C-c"], () => process.exit());
screen.key(["escape", "q"], () => {
    if (builderDialogBox) {
        builderDialogBox.detach();
        builderDialogBox = undefined;
        screen.render();
    } else if (clientDialogBox) {
        clientDialogBox.detach();
        clientDialogBox = undefined;
        screen.render();
    } else {
        process.exit();
    }
});
screen.key(["right", "l"], () => focusRight());
screen.key(["left", "h"], () => focusLeft());

builderBox.on("click", () => {
    activate(builderBox);
});
clientBox.on("click", () => {
    activate(clientBox);
});

screen.render();

let notificationInterval: NodeJS.Timeout | undefined;
const notifications: string[] = [];

function notify(msg: string): void {
    if (notificationInterval) {
        if (notifications.length === 5) {
            notifications.splice(0, 1);
        }
        notifications.push(msg);
        return;
    }

    const notifyNow = (msg?: string) => {
        notificationBox.setContent(msg || "");
        screen.render();
    };

    notificationInterval = setInterval(() => {
        if (notifications.length === 0) {
            clearInterval(notificationInterval);
            notificationInterval = undefined;
            notifyNow();
            return;
        }

        notifyNow(notifications.shift());
    }, 2000);

    notifyNow(msg);
}

let scheduler = String(option("scheduler", "ws://localhost:8097"));
if (scheduler.indexOf("://") === -1) {
    scheduler = "ws://" + scheduler;
}
if (!/:[0-9]+$/.exec(scheduler)) {
    scheduler += ":8097";
}

// function log(...args) {
//     const str = args.map((elem) => (typeof elem === "object" ? JSON.stringify(elem) : elem)).join(" ");
//     fs.appendFileSync("/tmp/fisk-monitor.log", str + "\n");
// }

// try {
// fs.unlinkSync("/tmp/fisk-monitor.log");
// } catch (e) {}

const builders = new Map();
const jobs = new Map();
const jobsForClient = new Map();

function clearData() {
    builders.clear();
    jobs.clear();
    jobsForClient.clear();

    update();
}

function formatCell(str: string, num: number, prefix?: string, suffix?: string): string {
    return (prefix || "") + (" " + str).padEnd(num, " ").substr(0, num) + (suffix || "");
}

let updateTimer: NodeJS.Timeout | undefined;
let timeout = 0;

function updateBuilderBox(): void {
    const builderWidth = (builderContainer.width as number) - 3;

    const data = [];
    const maxWidth = [6, 8, 7, 7, 12, 20];
    let newest = Number.MAX_SAFE_INTEGER;
    const now = Date.now();
    for (const [key, value] of builders) {
        const added = new Date(value.created).valueOf();
        const age = now - added;
        newest = Math.min(newest, age);
        const name = value.name || value.hostname || key;
        const labels = value.labels ? value.labels.join(" ") : "";
        const line = [
            name,
            `${value.active}`,
            `${value.jobsPerformed}`,
            `${value.slots}`,
            `${humanizeDuration(age)}`,
            labels
        ];
        data.push(line);

        for (let i = 0; i < line.length; ++i) {
            maxWidth[i] = Math.max(maxWidth[i], line[i].length + 2);
        }
    }
    data.sort((a, b) => {
        let an = parseInt(a[1]);
        let bn = parseInt(b[1]);
        if (an !== bn) {
            return bn - an;
        }
        an = parseInt(a[2]);
        bn = parseInt(b[2]);
        if (an !== bn) {
            return bn - an;
        }
        return a[0].localeCompare(b[0]);
    });

    let used = 0;
    for (let i = 0; i < maxWidth.length; ++i) {
        if (used + maxWidth[i] > builderWidth) {
            maxWidth[i] = builderWidth - used;
        }
        used += maxWidth[i];
    }
    let header = "";
    header += formatCell("Host", maxWidth[0], "{bold}", "{/bold}");
    header += formatCell("Active", maxWidth[1], "{bold}", "{/bold}");
    header += formatCell("Total", maxWidth[2], "{bold}", "{/bold}");
    header += formatCell("Slots", maxWidth[3], "{bold}", "{/bold}");
    header += formatCell("Uptime", maxWidth[4], "{bold}", "{/bold}");
    header += formatCell("Labels", maxWidth[5], "{bold}", "{/bold}");

    builderHeader.setContent(header);

    const item = builderBox.getItem(selectedBuilder || "");
    let selected: string | undefined;
    if (item) {
        const match = /^ *([^ ]*)/.exec(item.content);
        assert(match && match[1]);
        selected = match[1];
    }
    let current;
    const items = data.map((item, idx) => {
        if (item[0] === selected) {
            current = idx;
        }
        return (
            formatCell(item[0], maxWidth[0]) +
            formatCell(item[1], maxWidth[1]) +
            formatCell(item[2], maxWidth[2]) +
            formatCell(item[3], maxWidth[3]) +
            formatCell(item[4], maxWidth[4]) +
            formatCell(item[5], maxWidth[5])
        );
    });
    builderBox.setItems(items);
    if (current !== undefined) {
        selectedBuilder = current;
    }
    if (currentFocus !== builderBox) {
        builderBox.scrollTo(0);
    }

    if (newest < 60000) {
        setTimeout(update, 1000);
    } else {
        setTimeout(update, 60000);
    }
}

function updateClientBox() {
    const clientWidth = (clientContainer.width as number) - 3;

    const data = [];
    const maxWidth = [6, 6, 7];
    for (const [key, value] of jobsForClient) {
        const line = [key, `${value.size - 1}`, `${value.get("total")}`];
        data.push(line);

        maxWidth[0] = Math.max(maxWidth[0], line[0].length + 2);
        maxWidth[1] = Math.max(maxWidth[1], line[1].length + 2);
        maxWidth[2] = Math.max(maxWidth[2], line[2].length + 2);
    }

    data.sort((a, b) => a[0].localeCompare(b[0]));

    let used = 0;
    for (const i of [1, 2, 0]) {
        if (used + maxWidth[i] > clientWidth) {
            maxWidth[i] = clientWidth - used;
        }
        used += maxWidth[i];
    }

    let header = "";
    header += formatCell("Name", maxWidth[0], "{bold}", "{/bold}");
    header += formatCell("Jobs", maxWidth[1], "{bold}", "{/bold}");
    header += formatCell("Total", maxWidth[2], "{bold}", "{/bold}");
    clientHeader.setContent(header);

    const item = clientBox.getItem(selectedClient || "");
    let selected: string | undefined;
    if (item) {
        const match = /^ *([^ ]*)/.exec(item.content);
        assert(match && match[1]);
        selected = match[1];
    }
    let current;
    const items = data.map((item, idx) => {
        if (item[0] === selected) {
            current = idx;
        }
        return formatCell(item[0], maxWidth[0]) + formatCell(item[1], maxWidth[1]) + formatCell(item[2], maxWidth[2]);
    });

    clientBox.setItems(items);
    if (current !== undefined) {
        selectedClient = current;
    }
    if (currentFocus !== clientBox) {
        clientBox.scrollTo(0);
    }
}

function update() {
    //let data = [];
    if (updateTimer) {
        return;
    }
    updateTimer = setTimeout(() => {
        updateTimer = undefined;
        timeout = 500;

        updateBuilderBox();
        updateClientBox();

        screen.render();
    }, timeout);
}

interface BuilderInfo extends BuilderAddedOrRemovedBase {
    type?: string;
    active?: number;
}

function builderAdded(removed: BuilderAddedMessage) {
    const msg = removed as BuilderInfo;
    msg.active = 0;
    delete msg.type;
    builders.set(msg.ip + ":" + msg.port, msg);
    // console.log("Got builder", msg);
    update();
}

function builderRemoved(msg: BuilderRemovedMessage) {
    const builderKey = msg.ip + ":" + msg.port;

    jobs.forEach((jobValue) => {
        if (jobValue.builder) {
            const jobBuilderKey = `${jobValue.builder.ip}:${jobValue.builder.port}`;
            if (builderKey === jobBuilderKey) {
                deleteJob(jobValue);
            }
        }
    });

    builders.delete(builderKey);
    update();
}

function clientName(client: JobMonitorMessageClient) {
    if (client.name) {
        if (client.name === client.hostname) {
            return "dev:" + (client.user || "nobody") + "@" + client.hostname;
        }
        if (client.name[0] === "-") {
            return "dev:" + (client.user || "nobody") + client.name;
        }
        // try {
        //     const o = JSON.parse(client.name);
        //     if (typeof o === "object" && "name" in o) {
        //         return o.name;
        //     }
        // } catch (e) {
        //     /* */
        // }
        return client.name;
    }
    return client.ip;
}

interface JobData extends JobMonitorMessageBase {
    type?: string;
    time: number;
}

function jobStarted(j: JobMonitorMessage) {
    const job = j as JobData;
    // log(job);
    const builderKey = `${job.builder.ip}:${job.builder.port}`;
    const builder = builders.get(builderKey);
    if (!builder) {
        return;
    }

    const clientKey = clientName(job.client);
    let client = jobsForClient.get(clientKey);
    job.time = Date.now();
    // log("got job started", clientKey);
    if (!client) {
        client = new Map([["total", 1]]);
        jobsForClient.set(clientKey, client);
    } else {
        client.set("total", client.get("total") + 1);
    }
    delete job.type;
    client.set(job.id, job);

    jobs.set(job.id, job);
    ++builder.jobsPerformed;
    ++builder.active;
    update();
}

function deleteJob(job: JobMonitorMessage) {
    const clientKey = clientName(job.client);
    const client = jobsForClient.get(clientKey);
    if (client) {
        client.delete(job.id);
        if (client.size === 1) {
            jobsForClient.delete(clientKey);
        }
    }
}

function jobFinished(job: JobMonitorMessage) {
    const activejob = jobs.get(job.id);
    if (!activejob) {
        return;
    }
    jobs.delete(job.id);

    deleteJob(activejob);

    const key = `${activejob.builder.ip}:${activejob.builder.port}`;
    const builder = builders.get(key);
    if (!builder) {
        return;
    }
    --builder.active;
    update();
}

let ws: WebSocket | undefined;

function connect() {
    const url = `${scheduler}/monitor`;
    notify(`connect ${url}`);
    ws = new WebSocket(url);
    ws.on("open", () => {
        notify("open");
        assert(ws);
        ws.send(JSON.stringify({ type: "sendInfo" }));
    });
    ws.on("error", (err) => {
        notify(`client websocket error ${err.message}`);
    });
    ws.on("message", (msg: Buffer) => {
        //notify(`msg ${msg}`);
        let obj;
        try {
            obj = JSON.parse(msg.toString());
        } catch (e) {
            notify(`msg parse error: ${msg}, ${e}`);
        }
        switch (obj.type) {
            case "builderAdded":
                builderAdded(obj);
                break;
            case "builderRemoved":
                builderRemoved(obj);
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
