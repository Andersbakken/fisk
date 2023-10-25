import child_process from "child_process";
import util from "util";

export const exec = util.promisify(child_process.exec);
