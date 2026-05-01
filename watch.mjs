import * as esbuild from 'esbuild';
import { typescriptCheckPlugin } from './plugin-typescript-check.mjs';
import { playcanvasPushPlugin } from './plugin-playcanvas-push.mjs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const thisPackage = require('./package.json');
const entryPoint = 'src/index.ts';
const outFile = thisPackage.module;

let ctx = await esbuild.context({
    entryPoints: [entryPoint],
    outfile: outFile,
    tsconfig: './tsconfig.json',
    format: 'esm',
    bundle: true,
    sourcemap: 'external',
    external: ['playcanvas'],
    plugins: [
        typescriptCheckPlugin,
        // playcanvasPushPlugin
    ]
});

await ctx.watch();

console.log('Watching for changes...');

// Graceful shutdown
process.on('SIGINT', async () => {
    await ctx.dispose();
    process.exit(0);
});