import * as vscode from 'vscode';
import { SessionTreeProvider } from './views/sessionTreeProvider';
import { ContentPanel } from './views/contentPanel';
import { scanBrainDirectory } from './brainScanner';
import { AntigravityClient, ConversationMessage } from './apiClient';

// Shared client instance (reused across refreshes)
let apiClient: AntigravityClient | undefined;

/** globalState key for persisted workspace cache */
const WORKSPACE_CACHE_KEY = 'workspaceCache';

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
    loadConversations(context, treeProvider);

    // Commands
    context.subscriptions.push(
        vscode.commands.registerCommand('convManager.refresh', () => {
            // Force re-detect processes on manual refresh
            apiClient?.disconnect();
            apiClient = undefined;
            loadConversations(context, treeProvider);
        }),
        vscode.commands.registerCommand('convManager.openSession', (item) => {
            const conv = item.conversation;
            if (!conv) { return; }

            ContentPanel.show(
                conv.id,
                conv.title || conv.id.substring(0, 8),
                async (id: string): Promise<ConversationMessage[] | null> => {
                    // Lazily connect API client if needed
                    if (!apiClient) {
                        apiClient = new AntigravityClient();
                        await apiClient.connect();
                    }
                    if (!apiClient.isConnected) {
                        throw new Error('Cannot connect to Antigravity API.\n\nMake sure Antigravity is running.');
                    }
                    return apiClient.getConversation(id);
                },
            );
        }),
        vscode.commands.registerCommand('convManager.search', () => {
            // TODO: implement search via Quick Pick
            vscode.window.showInformationMessage('Search not yet implemented');
        }),
    );
}

/**
 * Scan brain/ directory and enrich with API metadata.
 *
 * Three-phase loading strategy:
 *   Phase 1: Local brain/ scan + apply cached workspace mappings (instant)
 *   Phase 2: GetAllCascadeTrajectories — batch metadata (~20% workspace coverage)
 *   Phase 3: GetCascadeTrajectory per conversation — deep workspace enrichment
 *            (batch parallel, progressive tree updates, results cached to globalState)
 */
async function loadConversations(
    context: vscode.ExtensionContext,
    treeProvider: SessionTreeProvider,
): Promise<void> {
    // Load persistent workspace cache
    const cache: Record<string, string | null> = context.globalState.get(WORKSPACE_CACHE_KEY, {});
    let cacheUpdated = false;

    try {
        // Phase 1: Local scan (instant, works offline)
        const conversations = await scanBrainDirectory();

        // Apply cached workspace data for instant grouping
        for (const conv of conversations) {
            const cached = cache[conv.id];
            if (cached) {
                conv.workspace = cached;
            }
        }
        treeProvider.setConversations(conversations);

        // Phase 2: API metadata enrichment (limited coverage ~20%)
        try {
            if (!apiClient) {
                apiClient = new AntigravityClient();
                await apiClient.connect();
            }

            if (apiClient.isConnected) {
                const metadata = await apiClient.getConversationList();

                if (metadata.size > 0) {
                    for (const conv of conversations) {
                        const meta = metadata.get(conv.id);
                        if (meta) {
                            if (meta.title) { conv.title = meta.title; }
                            if (meta.workspace) {
                                conv.workspace = meta.workspace;
                                cache[conv.id] = meta.workspace;
                                cacheUpdated = true;
                            }
                            if (meta.branch) { conv.branch = meta.branch; }
                        }
                    }
                    treeProvider.setConversations(conversations);
                }

                // Phase 3: Deep workspace enrichment via GetCascadeTrajectory
                // Only fetch conversations not in cache and still missing workspace
                const needsEnrichment = conversations.filter(
                    c => !c.workspace && !(c.id in cache),
                );

                if (needsEnrichment.length > 0) {
                    const BATCH_SIZE = 5;
                    for (let i = 0; i < needsEnrichment.length; i += BATCH_SIZE) {
                        const batch = needsEnrichment.slice(i, i + BATCH_SIZE);
                        const results = await Promise.allSettled(
                            batch.map(c => apiClient!.getConversationWorkspace(c.id)),
                        );

                        let changed = false;
                        for (let j = 0; j < batch.length; j++) {
                            const r = results[j];
                            if (r.status === 'fulfilled' && r.value) {
                                cache[batch[j].id] = r.value;
                                cacheUpdated = true;
                                batch[j].workspace = r.value;
                                changed = true;
                            }
                        }

                        if (changed) {
                            treeProvider.setConversations(conversations);
                        }
                    }
                }
            }
        } catch {
            // API unavailable — local data + cache still shown
        }
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`Failed to scan conversations: ${msg}`);
    }

    // Persist cache updates
    if (cacheUpdated) {
        context.globalState.update(WORKSPACE_CACHE_KEY, cache);
    }
}

export function deactivate() {
    // cleanup
}
