import { options } from "@jhanssen/options";

function quitOnError(option: typeof options): void {
    const quitInterval = option.int("quit-on-error-delay", 2000);
    if (quitInterval >= 0) {
        console.log(`Quitting in ${quitInterval}ms`);
        setTimeout(process.exit.bind(process), quitInterval);
    }
}

export { quitOnError };
