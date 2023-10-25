import { exec } from "./exec";
import { options } from "./options";

export function sha1(command: string): Promise<string> {
    return exec(`${options().fiskc} --fisk-dump-sha1 --fisk-compiler=${command}`).then(
        (result: { stdout: string; stderr: string }) => {
            const stdout = result.stdout;
            if (stdout.endsWith("\n")) {
                return stdout.substring(0, stdout.length - 1);
            }
            return stdout;
        }
    );
}
