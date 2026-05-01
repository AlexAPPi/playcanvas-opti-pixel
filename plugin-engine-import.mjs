import * as esbuild from 'esbuild';

/** @type {esbuild.Plugin} */
const engineImportPlugin = {
    name: "global-import",
    setup(build) {
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