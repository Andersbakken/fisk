import commonjs from "@rollup/plugin-commonjs";
import resolve from "@rollup/plugin-node-resolve";
import typescript from "rollup-plugin-typescript2";
import hashbang from "rollup-plugin-hashbang";

const output = "dist/fisk-daemon.js";
const input = "daemon/fisk-daemon.ts";

const plugins = [
    resolve({
        preferBuiltins: true
    }),
    commonjs(),
    typescript({
        tsconfig: `tsconfig.json`,
        cacheRoot: ".cache"
    }),
    hashbang()
];

// Define forms
const format = "cjs";
const external = ["fs", "assert"];

export default [
    {
        input,
        plugins,
        external,
        output: {
            file: output,
            format,
            name: "tsimport",
            exports: "named",
            sourcemap: true
        }
    }
];
