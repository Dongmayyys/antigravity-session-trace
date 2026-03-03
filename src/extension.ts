import * as vscode from 'vscode';
import { SessionTreeProvider, SortBy, relativeTime } from './views/sidebarViewProvider';
import { ContentPanel } from './views/contentPanel';
import { scanBrainDirectory } from './brainScanner';
import { AntigravityClient, ConversationMessage } from './apiClient';
import { ConversationInfo } from './types';

// Shared client instance (reused across refreshes)
let apiClient: AntigravityClient | undefined;

/** In-memory cache for fetched conversation messages (avoids repeated API calls within session) */
const messageCache = new Map<string, ConversationMessage[]>();

/** globalState keys for persisted caches */
const WORKSPACE_CACHE_KEY = 'workspaceCache';
const TITLE_CACHE_KEY = 'titleCache';
const MSG_COUNT_CACHE_KEY = 'messageCountCache';
const SORT_CACHE_KEY = 'sortBy';

/**
 * Extension entry point.
 *
 * Initializes the Tree View sidebar, scans the local brain/ directory
 * for conversations, and registers commands.
 */
export function activate(context: vscode.ExtensionContext) {
    const treeProvider = new SessionTreeProvider();

    // Restore persisted sort order
    const savedSort = context.globalState.get<SortBy>(SORT_CACHE_KEY);
    if (savedSort) {
        treeProvider.setSortBy(savedSort);
    }

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
            messageCache.clear();
            loadConversations(context, treeProvider, treeView);
        }),

        vscode.commands.registerCommand('convManager.openSession', (session?: ConversationInfo) => {
            if (!session) { return; }
            ContentPanel.show(
                session.id,
                session.title || session.id.substring(0, 8),
                async (id: string): Promise<ConversationMessage[] | null> => {
                    // Return cached messages if available (avoids repeated API calls)
                    const cached = messageCache.get(id);
                    if (cached) { return cached; }

                    if (!apiClient) {
                        apiClient = new AntigravityClient();
                        await apiClient.connect();
                    }
                    if (!apiClient.isConnected) {
                        throw new Error('Cannot connect to Antigravity API.\n\nMake sure Antigravity is running.');
                    }
                    const messages = await apiClient.getConversation(id);
                    if (messages && messages.length > 0) {
                        messageCache.set(id, messages);
                    }
                    return messages;
                },
            );
        }),

        vscode.commands.registerCommand('convManager.search', () => {
            const conversations = treeProvider.conversations;
            if (conversations.length === 0) {
                vscode.window.showInformationMessage('No conversations loaded yet.');
                return;
            }

            interface SearchItem extends vscode.QuickPickItem {
                session: ConversationInfo;
            }

            const quickPick = vscode.window.createQuickPick<SearchItem>();
            quickPick.placeholder = 'Search conversations by title or workspace…';
            quickPick.matchOnDescription = true;

            // Build items from all conversations (sorted by lastModified)
            const sorted = [...conversations].sort((a, b) => b.lastModified - a.lastModified);
            quickPick.items = sorted.map(c => {
                const title = c.title || c.id.substring(0, 8);
                const timeAgo = relativeTime(c.lastModified);

                // description: only workspace (matched by Quick Pick)
                const description = c.workspace ? `$(folder) ${c.workspace}` : '';

                // detail: time + message count (visible but not matched)
                const infoParts: string[] = [];
                if (c.messageCount) { infoParts.push(`${c.messageCount} msgs`); }
                infoParts.push(timeAgo);
                const detail = infoParts.join(' · ');

                return {
                    label: `$(comment) ${title}`,
                    description,
                    detail,
                    session: c,
                };
            });

            quickPick.onDidAccept(() => {
                const selected = quickPick.selectedItems[0];
                if (selected) {
                    quickPick.dispose();
                    // Clear tree search filter and open the selected conversation
                    treeProvider.setSearch('');
                    vscode.commands.executeCommand('convManager.openSession', selected.session);
                }
            });

            quickPick.onDidHide(() => quickPick.dispose());
            quickPick.show();
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
                context.globalState.update(SORT_CACHE_KEY, picked.sortKey);
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
    const msgCountCache: Record<string, number> = context.globalState.get(MSG_COUNT_CACHE_KEY, {});
    let cacheUpdated = false;
    let titleCacheUpdated = false;
    let msgCountCacheUpdated = false;

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
            if (msgCountCache[conv.id] !== undefined) {
                conv.messageCount = msgCountCache[conv.id];
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
                // Fetch conversations missing workspace, createdAt, or messageCount
                const needsEnrichment = conversations.filter(
                    c => (!c.workspace && !(c.id in cache))
                        || !c.createdAt
                        || c.messageCount === undefined,
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
                                if (r.value.messageCount > 0) {
                                    batch[j].messageCount = r.value.messageCount;
                                    msgCountCache[batch[j].id] = r.value.messageCount;
                                    msgCountCacheUpdated = true;
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
    if (msgCountCacheUpdated) {
        context.globalState.update(MSG_COUNT_CACHE_KEY, msgCountCache);
    }
}

export function deactivate() {
    // cleanup
}
