/**
 * Type declaration for CSS module imports.
 *
 * With esbuild's `loader: { '.css': 'text' }`, importing a .css file
 * returns its contents as a plain string. This declaration tells TypeScript
 * to accept such imports without errors.
 */
declare module '*.css' {
    const content: string;
    export default content;
}
