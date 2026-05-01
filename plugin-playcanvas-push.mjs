import * as esbuild from 'esbuild';
import * as cp from 'child_process';

/** @type {esbuild.Plugin} */
const playcanvasPushPlugin = {
    name: 'playcanvas-push',
    setup(build) {
        build.onEnd((result) => {
            
            if (result.errors.length === 0) {

                cp.execSync('node node_modules/playcanvas-sync/pcsync.js pushAll --yes', { stdio: 'inherit' });
            }
        });
    },
}

export { playcanvasPushPlugin };
