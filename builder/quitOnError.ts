import { OptionsFunction } from "@jhanssen/options";

export function quitOnError(option: OptionsFunction): () => void {
    return function () {
        const quitInterval = option.int("quit-on-error-delay", 2000);
        if (quitInterval >= 0) {
            console.log(`Quitting in ${quitInterval}ms`);
            setTimeout(process.exit.bind(process), quitInterval);
        }
    };
}
