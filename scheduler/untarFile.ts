import child_process from "child_process";
import mktemp from "@josh_stern/mktemp";

export function untarFile(archive: string, file: string): Promise<string> {
    return new Promise((resolve, reject) => {
        mktemp.dir({ prefix: "fisk_env_info" }).then((tmpdir: string) => {
            child_process.exec(
                `tar -zxf "${archive}" ${file}`,
                { cwd: tmpdir },
                (err: NodeJS.ErrnoException, stdout: Buffer, stderr: Buffer) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    fs.readFile(path.join(tmpdir, file), "utf8", (err: NodeJS.ErrnoException, data: string) => {
                        try {
                            fs.removeSync(tmpdir);
                        } catch (e) {
                            console.error("Got an error removing the temp dir", tmpdir);
                        }
                        if (err) {
                            reject(err);
                        } else {
                            resolve(data);
                        }
                    });
                }
            );
        });
    });
}
