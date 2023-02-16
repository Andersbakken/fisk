import commonjs from "@rollup/plugin-commonjs";
import resolve from "@rollup/plugin-node-resolve";
import json from "@rollup/plugin-json";
import typescript from "rollup-plugin-typescript2";
import hashbang from "rollup-plugin-hashbang";

const plugins = [
    resolve({
        preferBuiltins: true
    }),
    commonjs({
        ignoreDynamicRequires: true
    }),
    typescript({
        tsconfig: `tsconfig.json`,
        cacheRoot: ".cache"
    }),
    hashbang(),
    json()
];

// Define forms
const format = "cjs";
const external = ["fs", "assert"];

export default [
    {
        input: "daemon/fisk-daemon.ts",
        plugins,
        external,
        output: {
            file: "dist/fisk-daemon.js",
            format,
            name: "fisk-daemon",
            exports: "named",
            sourcemap: true
        }
    },
    {
        input: "builder/fisk-builder.ts",
        plugins,
        external,
        output: {
            file: "dist/fisk-builder.js",
            format,
            name: "fisk-builder",
            exports: "named",
            sourcemap: true
        }
    },
    {
        input: "builder/VM_runtime/VM_runtime.ts",
        plugins,
        external,
        output: {
            file: "dist/VM_runtime.js",
            format,
            name: "fisk-builder-VM_runtime",
            exports: "named",
            sourcemap: true
        }
    },
    {
        input: "scheduler/fisk-scheduler.ts",
        plugins,
        external,
        output: {
            file: "dist/fisk-scheduler.js",
            format,
            name: "fisk-scheduler",
            exports: "named",
            sourcemap: true
        }
    }
];
