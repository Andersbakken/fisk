import type { Options } from "@jhanssen/options";

export function quitOnError(option: Options): () => void {
    return () => {
        const quitInterval = option.int("quit-on-error-delay", 2000);
        if (quitInterval >= 0) {
            console.log(`Quitting in ${quitInterval}ms`);
            setTimeout(process.exit.bind(process), quitInterval);
        }
    };
}
