import { Option } from "@jhanssen/options";

type Opts = (key: string, defaultValue?: Option) => Option;

function QuitOnError(option: Opts): void {
    return function () {
        const quitInterval = option.int("quit-on-error-delay", 2000);
        if (quitInterval >= 0) {
            console.log(`Quitting in ${quitInterval}ms`);
            setTimeout(process.exit.bind(process), quitInterval);
        }
    };
};

export { QuitOnError } = function (option: Opts) {
    return function () {
        const quitInterval = option.int("quit-on-error-delay", 2000);
        if (quitInterval >= 0) {
            console.log(`Quitting in ${quitInterval}ms`);
            setTimeout(process.exit.bind(process), quitInterval);
        }
    };
};
