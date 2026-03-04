/**
 * Shared logger — OutputChannel-based logging for debugging.
 *
 * Creates a "Conv Manager" channel in the Output panel.
 * Usage:
 *   import { log } from './logger';
 *   log('message here');
 */

import * as vscode from 'vscode';

const channel = vscode.window.createOutputChannel('Conv Manager');

/** Log a message to the "Conv Manager" output channel. */
export function log(message: string): void {
    channel.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}
