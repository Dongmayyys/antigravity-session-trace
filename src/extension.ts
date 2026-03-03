import * as vscode from 'vscode';
import { SessionTreeProvider, SortBy, relativeTime } from './views/sidebarViewProvider';
import { ContentPanel } from './views/contentPanel';
import { scanBrainDirectory } from './brainScanner';
import { AntigravityClient, ConversationMessage } from './apiClient';
import { ConversationInfo } from './types';
import { summarize, getSummary, setSummary, setApiKey, getApiKey } from './aiSummarizer';

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

    // Load summarized IDs from globalState for ✨ badges
    const summaryCache: Record<string, unknown> = context.globalState.get('summaryCache', {});
    treeProvider.summarizedIds = new Set(Object.keys(summaryCache));

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
            const existingSummary = getSummary(context.globalState, session.id);
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
                existingSummary?.text,
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

        vscode.commands.registerCommand('convManager.summarize', async (item?: any) => {
            // Accept SessionItem from tree view context menu
            const session: ConversationInfo | undefined = item?.session;
            if (!session) {
                vscode.window.showWarningMessage('请右键点击一条会话来生成 AI 总结。');
                return;
            }

            // Check if already summarized
            const existing = getSummary(context.globalState, session.id);
            if (existing) {
                const action = await vscode.window.showInformationMessage(
                    `此会话已有总结 (${new Date(existing.generatedAt).toLocaleDateString()})。`,
                    '重新生成', '查看', '取消',
                );
                if (action === '取消' || !action) { return; }
                if (action === '查看') {
                    ContentPanel.show(session.id, session.title || session.id.substring(0, 8),
                        async () => messageCache.get(session.id) || null, existing.text);
                    return;
                }
                // '重新生成' falls through
            }

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `AI 总结: ${session.title || session.id.substring(0, 8)}`,
                cancellable: false,
            }, async (progress) => {
                try {
                    // Step 1: Get messages
                    progress.report({ message: '获取会话内容...' });
                    let messages = messageCache.get(session.id);
                    if (!messages) {
                        if (!apiClient) {
                            apiClient = new AntigravityClient();
                            await apiClient.connect();
                        }
                        if (!apiClient.isConnected) {
                            throw new Error('无法连接 Antigravity API');
                        }
                        messages = await apiClient.getConversation(session.id);
                        if (messages && messages.length > 0) {
                            messageCache.set(session.id, messages);
                        }
                    }
                    if (!messages || messages.length === 0) {
                        throw new Error('无法获取会话消息');
                    }

                    // Step 2: Call AI
                    progress.report({ message: '调用 AI 生成总结...' });
                    const summaryText = await summarize(messages, context.secrets);

                    // Step 3: Cache result
                    const entry = { text: summaryText, generatedAt: new Date().toISOString() };
                    setSummary(context.globalState, session.id, entry);

                    // Step 4: Update tree badge
                    treeProvider.summarizedIds.add(session.id);
                    treeProvider.refresh();

                    // Step 5: Show in panel
                    ContentPanel.show(session.id, session.title || session.id.substring(0, 8),
                        async () => messages, summaryText);

                    vscode.window.showInformationMessage('AI 总结生成完成。');
                } catch (e: unknown) {
                    const msg = e instanceof Error ? e.message : String(e);
                    vscode.window.showErrorMessage(`AI 总结失败: ${msg}`);
                }
            });
        }),

        vscode.commands.registerCommand('convManager.setApiKey', async () => {
            const current = await getApiKey(context.secrets);
            const hint = current ? `当前: ····${current.slice(-4)}` : '未设置';
            const key = await vscode.window.showInputBox({
                title: 'Set AI API Key',
                prompt: `输入 AI API Key (${hint})`,
                password: true,
                placeHolder: '留空清除已有 key',
            });
            if (key === undefined) { return; } // cancelled
            await setApiKey(context.secrets, key);
            vscode.window.showInformationMessage(key ? 'API Key 已保存。' : 'API Key 已清除。');
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
