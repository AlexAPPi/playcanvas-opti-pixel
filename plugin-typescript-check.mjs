import * as esbuild from 'esbuild';
import * as cp from 'child_process';

/** @type {esbuild.Plugin} */
const typescriptCheckPlugin = {
    name: 'typescript-check',
    setup(build) {
        build.onStart(() => {

            try {
                cp.execSync('tsc --noEmit --project tsconfig.json', { stdio: 'inherit' });
            }
            catch (ex) {
                
                return {
                    errors: [{
                        text: "Failed check typescript"
                    }]
                };
            }
        });
    },
}

export { typescriptCheckPlugin };