import commonjs from "@rollup/plugin-commonjs";
import resolve from "@rollup/plugin-node-resolve";
import json from "@rollup/plugin-json";
import typescript from "rollup-plugin-typescript2";
import hashbang from "rollup-plugin-hashbang";

const plugins = [
    resolve({ preferBuiltins: true }),
    commonjs({ ignoreDynamicRequires: true }),
    typescript({
        tsconfig: `tsconfig.json`,
        cacheRoot: ".cache"
    }),
    hashbang(),
    json()
];

function onwarn(warning) {
    if (warning.code === "CIRCULAR_DEPENDENCY" && warning.importer.startsWith("node_modules/@andersbakken/blessed/")) {
        return;
    }

    console.warn(warning.message);
}

// Define forms
const format = "cjs";

export default [
    {
        input: "src/daemon/fisk-daemon.ts",
        plugins,
        output: {
            file: "daemon/fisk-daemon.js",
            format,
            name: "fisk-daemon",
            exports: "named",
            sourcemap: true
        }
    },
    {
        input: "src/builder/fisk-builder.ts",
        plugins,
        output: {
            file: "builder/fisk-builder.js",
            format,
            name: "fisk-builder",
            exports: "named",
            sourcemap: true
        }
    },
    {
        input: "src/builder/VM_runtime/VM_runtime.ts",
        plugins,
        external: ["posix"],
        output: {
            file: "builder/VM_runtime.js",
            format,
            name: "fisk-builder-VM_runtime",
            exports: "named",
            sourcemap: true
        }
    },
    {
        input: "src/scheduler/fisk-scheduler.ts",
        plugins,
        external: ["posix"],
        output: {
            file: "scheduler/fisk-scheduler.js",
            format,
            name: "fisk-scheduler",
            exports: "named",
            sourcemap: true
        }
    },
    {
        input: "src/monitor/fisk-monitor.ts",
        onwarn,
        plugins,
        external: ["@andersbakken/blessed"],
        output: {
            file: "monitor/fisk-monitor.js",
            format,
            name: "fisk-monitor",
            exports: "named",
            sourcemap: true
        }
    }
];
