import * as esbuild from 'esbuild';

/** @type {esbuild.Plugin} */
const engineImportPlugin = {
    name: "engine-import",
    setup(build) {
        // Fix import from playcanvas to use window.pc
        // Comment this out if you are using builds with import(...).
        build.onLoad(
            { filter: /engine\.ts$/ },
            () => ({
                contents: "export default window.pc;",
                loader: "ts",
            })
        );
    },
};

export { engineImportPlugin };