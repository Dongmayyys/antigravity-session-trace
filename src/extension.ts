import * as vscode from 'vscode';
import { SessionTreeProvider } from './views/sessionTreeProvider';
import { scanBrainDirectory } from './brainScanner';
import { AntigravityClient } from './apiClient';

// Shared client instance (reused across refreshes)
let apiClient: AntigravityClient | undefined;

/**
 * Extension entry point.
 *
 * Initializes the session tree view, scans the local brain/ directory
 * for conversations, and registers commands.
 */
export function activate(context: vscode.ExtensionContext) {
    const treeProvider = new SessionTreeProvider();

    // Register the tree view in the Activity Bar
    const treeView = vscode.window.createTreeView('convManager.sessions', {
        treeDataProvider: treeProvider,
        showCollapseAll: true,
    });
    context.subscriptions.push(treeView);

    // Scan and populate tree view on activation
    loadConversations(treeProvider);

    // Commands
    context.subscriptions.push(
        vscode.commands.registerCommand('convManager.refresh', () => {
            // Force re-detect processes on manual refresh
            apiClient?.disconnect();
            apiClient = undefined;
            loadConversations(treeProvider);
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

/**
 * Scan brain/ directory and update the tree view with results.
 * Then attempt to connect to the API for metadata enrichment (workspace, better titles).
 */
async function loadConversations(treeProvider: SessionTreeProvider): Promise<void> {
    try {
        // Phase 1: Local scan (instant, works offline)
        const conversations = await scanBrainDirectory();
        treeProvider.setConversations(conversations);

        // Phase 2: API metadata enrichment (async, non-blocking)
        try {
            if (!apiClient) {
                apiClient = new AntigravityClient();
                await apiClient.connect();
            }

            if (apiClient.isConnected) {
                const metadata = await apiClient.getConversationList();

                if (metadata.size > 0) {
                    // Merge API metadata into local data
                    for (const conv of conversations) {
                        const meta = metadata.get(conv.id);
                        if (meta) {
                            if (meta.title) { conv.title = meta.title; }
                            if (meta.workspace) { conv.workspace = meta.workspace; }
                            if (meta.branch) { conv.branch = meta.branch; }
                        }
                    }
                    // Re-render with enriched data
                    treeProvider.setConversations(conversations);
                }
            }
        } catch {
            // API unavailable — local data is still shown, just without workspace grouping
        }
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`Failed to scan conversations: ${msg}`);
    }
}

export function deactivate() {
    // cleanup
}
