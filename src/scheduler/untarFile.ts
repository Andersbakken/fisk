import child_process from "child_process";
import fs from "fs-extra";
import mktemp from "mktemp";
import path from "path";

export function untarFile(archive: string, file: string): Promise<string> {
    return new Promise((resolve, reject) => {
        mktemp.createDir("/tmp/fisk_env_infoXXXX").then((tmpdir: string) => {
            child_process.exec(
                `tar -zxf "${archive}" ${file}`,
                { cwd: tmpdir },
                (err: child_process.ExecException | null) => {
                    if (err) {
                        try {
                            fs.removeSync(tmpdir);
                        } catch (e) {
                            console.error("Got an error removing the temp dir", tmpdir);
                        }
                        reject(err);
                        return;
                    }
                    fs.readFile(
                        path.join(tmpdir, file),
                        "utf8",
                        (error: NodeJS.ErrnoException | null, data: string) => {
                            try {
                                fs.removeSync(tmpdir);
                            } catch (e) {
                                console.error("Got an error removing the temp dir", tmpdir);
                            }
                            if (error) {
                                reject(error);
                            } else {
                                resolve(data);
                            }
                        }
                    );
                }
            );
        });
    });
}
