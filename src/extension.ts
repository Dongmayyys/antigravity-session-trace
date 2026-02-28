import * as vscode from 'vscode';
import { SessionTreeProvider } from './views/sessionTreeProvider';

/**
 * Extension entry point.
 *
 * Initializes the session tree view and registers commands.
 * Data loading happens lazily when the tree view becomes visible.
 */
export function activate(context: vscode.ExtensionContext) {
    const treeProvider = new SessionTreeProvider();

    // Register the tree view in the Activity Bar
    const treeView = vscode.window.createTreeView('convManager.sessions', {
        treeDataProvider: treeProvider,
        showCollapseAll: true,
    });
    context.subscriptions.push(treeView);

    // Commands
    context.subscriptions.push(
        vscode.commands.registerCommand('convManager.refresh', () => {
            treeProvider.refresh();
        }),
        vscode.commands.registerCommand('convManager.openSession', (item) => {
            // TODO: open content panel webview for selected session
            vscode.window.showInformationMessage(`Open: ${item.label}`);
        }),
        vscode.commands.registerCommand('convManager.search', () => {
            // TODO: implement search via Quick Pick
            vscode.window.showInformationMessage('Search not yet implemented');
        }),
    );
}

export function deactivate() {
    // cleanup
}
