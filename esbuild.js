const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const buildOptions = {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    sourcemap: !production,
    minify: production,
};

if (watch) {
    esbuild.context(buildOptions).then(ctx => {
        ctx.watch();
        console.log('👀 Watching for changes...');
    });
} else {
    esbuild.build(buildOptions).catch(() => process.exit(1));
}
