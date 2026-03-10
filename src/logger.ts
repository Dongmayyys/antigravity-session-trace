/**
 * Shared logger — OutputChannel-based logging for debugging.
 *
 * Creates a "Session Trace" channel in the Output panel.
 * Usage:
 *   import { log } from './logger';
 *   log('message here');
 */

import * as vscode from 'vscode';

const channel = vscode.window.createOutputChannel('Session Trace');

/** Log a message to the "Session Trace" output channel. */
export function log(message: string): void {
    channel.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}
