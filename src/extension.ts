import * as vscode from 'vscode';
import { SidebarViewProvider } from './views/sidebarViewProvider';
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
 * Initializes the sidebar webview, scans the local brain/ directory
 * for conversations, and registers commands.
 */
export function activate(context: vscode.ExtensionContext) {
    const sidebarProvider = new SidebarViewProvider(context.extensionUri);

    // Register the webview view provider for the sidebar
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            SidebarViewProvider.viewId,
            sidebarProvider,
        ),
    );

    // Wire up sidebar callbacks
    sidebarProvider.onOpenSession = (conv) => {
        ContentPanel.show(
            conv.id,
            conv.title || conv.id.substring(0, 8),
            async (id: string): Promise<ConversationMessage[] | null> => {
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
    };

    sidebarProvider.onRefresh = () => {
        apiClient?.disconnect();
        apiClient = undefined;
        loadConversations(context, sidebarProvider);
    };

    // Scan and populate on activation
    loadConversations(context, sidebarProvider);

    // Commands
    context.subscriptions.push(
        vscode.commands.registerCommand('convManager.refresh', () => {
            apiClient?.disconnect();
            apiClient = undefined;
            loadConversations(context, sidebarProvider);
        }),
        vscode.commands.registerCommand('convManager.openSession', () => {
            // Triggered by webview postMessage, handled via callback above
        }),
        vscode.commands.registerCommand('convManager.search', () => {
            // Search is now built into the sidebar webview
            // Focus the sidebar view to reveal the search box
            vscode.commands.executeCommand('convManager.sessions.focus');
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
    sidebarProvider: SidebarViewProvider,
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
        sidebarProvider.setConversations(conversations);

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
                    sidebarProvider.setConversations(conversations);
                }

                // Phase 3: Deep enrichment via GetCascadeTrajectory
                // Fetch conversations missing workspace (and not in cache) or missing createdAt
                const needsEnrichment = conversations.filter(
                    c => (!c.workspace && !(c.id in cache)) || !c.createdAt,
                );

                if (needsEnrichment.length > 0) {
                    const BATCH_SIZE = 5;
                    for (let i = 0; i < needsEnrichment.length; i += BATCH_SIZE) {
                        const batch = needsEnrichment.slice(i, i + BATCH_SIZE);
                        const results = await Promise.allSettled(
                            batch.map(c => apiClient!.getConversationDetails(c.id)),
                        );

                        let changed = false;
                        for (let j = 0; j < batch.length; j++) {
                            const r = results[j];
                            if (r.status === 'fulfilled' && r.value) {
                                if (r.value.workspace) {
                                    cache[batch[j].id] = r.value.workspace;
                                    cacheUpdated = true;
                                    batch[j].workspace = r.value.workspace;
                                    changed = true;
                                }
                                if (r.value.createdAt) {
                                    batch[j].createdAt = r.value.createdAt;
                                    changed = true;
                                }
                            }
                        }

                        if (changed) {
                            sidebarProvider.setConversations(conversations);
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
