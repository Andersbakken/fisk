import commonjs from "@rollup/plugin-commonjs";
import resolve from "@rollup/plugin-node-resolve";
import typescript from "rollup-plugin-typescript2";
import hashbang from "rollup-plugin-hashbang";

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
        input: "daemon/fisk-daemon.ts",
        plugins,
        external,
        output: {
            file: "dist/fisk-daemon.js",
            format,
            name: "tsimport",
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
            name: "tsimport",
            exports: "named",
            sourcemap: true
        }
    }
];
