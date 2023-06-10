import { options } from "./options";
import http from "http";

export function post(path: string, body: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const match = /(https?:\/\/)?([^:]*)(:[0-9]+)\/?/.exec(options().scheduler);
        if (!match) {
            reject(new Error("Failed to parse scheduler"));
            return;
        }
        const opts: http.RequestOptions = {
            host: match[2] || "",
            port: match[3] ? match[3].substring(1) : 80,
            path,
            method: "POST"
        };

        const req = http.request(opts, (res: http.IncomingMessage) => {
            res.setEncoding("utf8");
            let response = "";
            res.on("data", (chunk) => {
                // console.log('Response: ' + chunk);
                response += chunk;
            });
            res.on("end", () => {
                resolve(response.trim());
            });
        });

        req.write(body);
        req.end();
    });
}
