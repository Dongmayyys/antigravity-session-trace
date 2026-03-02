import * as vscode from 'vscode';
import { SessionTreeProvider, SortBy } from './views/sidebarViewProvider';
import { ContentPanel } from './views/contentPanel';
import { scanBrainDirectory } from './brainScanner';
import { AntigravityClient, ConversationMessage } from './apiClient';
import { ConversationInfo } from './types';

// Shared client instance (reused across refreshes)
let apiClient: AntigravityClient | undefined;

/** globalState key for persisted workspace cache */
const WORKSPACE_CACHE_KEY = 'workspaceCache';
const TITLE_CACHE_KEY = 'titleCache';

/**
 * Extension entry point.
 *
 * Initializes the Tree View sidebar, scans the local brain/ directory
 * for conversations, and registers commands.
 */
export function activate(context: vscode.ExtensionContext) {
    const treeProvider = new SessionTreeProvider();

    // Register native Tree View for the sidebar
    const treeView = vscode.window.createTreeView('convManager.sessions', {
        treeDataProvider: treeProvider,
        showCollapseAll: true,
    });
    context.subscriptions.push(treeView);

    // Scan and populate on activation
    loadConversations(context, treeProvider, treeView);

    // Commands
    context.subscriptions.push(
        vscode.commands.registerCommand('convManager.refresh', () => {
            apiClient?.disconnect();
            apiClient = undefined;
            loadConversations(context, treeProvider, treeView);
        }),

        vscode.commands.registerCommand('convManager.openSession', (session?: ConversationInfo) => {
            if (!session) { return; }
            ContentPanel.show(
                session.id,
                session.title || session.id.substring(0, 8),
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
        }),

        vscode.commands.registerCommand('convManager.search', async () => {
            const query = await vscode.window.showInputBox({
                prompt: 'Search conversations by title, workspace, or ID',
                value: treeProvider.searchQuery,
                placeHolder: 'Type to filter…',
            });
            // undefined = cancelled, empty string = clear search
            if (query !== undefined) {
                treeProvider.setSearch(query);
            }
        }),

        vscode.commands.registerCommand('convManager.sortBy', async () => {
            const current = treeProvider.sortBy;
            const items: (vscode.QuickPickItem & { sortKey: SortBy })[] = [
                {
                    label: '$(calendar) Last Modified',
                    description: current === 'date' ? '(current)' : '',
                    detail: 'Most recently modified first',
                    sortKey: 'date',
                },
                {
                    label: '$(clock) Created',
                    description: current === 'created' ? '(current)' : '',
                    detail: 'Most recently created first',
                    sortKey: 'created',
                },
                {
                    label: '$(case-sensitive) Name',
                    description: current === 'name' ? '(current)' : '',
                    detail: 'Alphabetical by title',
                    sortKey: 'name',
                },
            ];
            const picked = await vscode.window.showQuickPick(items, {
                title: 'Sort Conversations',
            });
            if (picked) {
                treeProvider.setSortBy(picked.sortKey);
            }
        }),

        vscode.commands.registerCommand('convManager.filterWorkspace', async () => {
            const workspaces = treeProvider.getUniqueWorkspaces();
            const current = treeProvider.filterWorkspace;
            const items: (vscode.QuickPickItem & { workspace: string | null })[] = [
                {
                    label: '$(globe) All Workspaces',
                    description: current === null ? '(current)' : '',
                    workspace: null,
                },
                {
                    label: '$(question) (no workspace)',
                    description: current === '' ? '(current)' : '',
                    workspace: '',
                },
                ...workspaces.map(ws => ({
                    label: `$(folder) ${ws}`,
                    description: current === ws ? '(current)' : '',
                    workspace: ws,
                })),
            ];
            const picked = await vscode.window.showQuickPick(items, {
                title: 'Filter by Workspace',
            });
            if (picked) {
                treeProvider.setFilter(picked.workspace);
            }
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
    treeView: vscode.TreeView<any>,
): Promise<void> {
    // Load persistent caches
    const cache: Record<string, string | null> = context.globalState.get(WORKSPACE_CACHE_KEY, {});
    const titleCache: Record<string, string> = context.globalState.get(TITLE_CACHE_KEY, {});
    let cacheUpdated = false;
    let titleCacheUpdated = false;

    try {
        // Phase 1: Local scan (instant, works offline)
        const conversations = await scanBrainDirectory();

        // Apply cached data for instant display
        for (const conv of conversations) {
            if (cache[conv.id]) {
                conv.workspace = cache[conv.id]!;
            }
            if (titleCache[conv.id]) {
                conv.title = titleCache[conv.id];
            }
        }
        treeProvider.setConversations(conversations);
        treeView.badge = { value: conversations.length, tooltip: `${conversations.length} conversations` };

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
                            if (meta.title) {
                                conv.title = meta.title;
                                titleCache[conv.id] = meta.title;
                                titleCacheUpdated = true;
                            }
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
    if (titleCacheUpdated) {
        context.globalState.update(TITLE_CACHE_KEY, titleCache);
    }
}

export function deactivate() {
    // cleanup
}
