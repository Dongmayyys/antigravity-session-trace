import * as vscode from 'vscode';
import * as path from 'path';
import { SessionTreeProvider, SortBy, ViewMode, relativeTime } from './views/sidebarViewProvider';
import { ContentPanel } from './views/contentPanel';
import { scanBrainDirectory, getAntigravityRoot } from './brainScanner';
import { AntigravityClient, ConversationMessage } from './apiClient';
import { ConversationInfo } from './types';
import { summarize, getSummary, setSummary, setApiKey, getApiKey, testConnection, SummaryEntry } from './aiSummarizer';
import { StatsPanel, AiConfigSnapshot, StatsPanelCallbacks } from './views/statsPanel';
import { TokenDashboard, aggregateTokenData } from './views/tokenDashboard';
import { ActiveTokenTracker } from './activeTokenTracker';
import { log } from './logger';

// Shared client instance (reused across refreshes)
let apiClient: AntigravityClient | undefined;

/** In-memory cache for fetched conversation messages (avoids repeated API calls within session) */
const messageCache = new Map<string, ConversationMessage[]>();

/** globalState keys for persisted caches */
const WORKSPACE_CACHE_KEY = 'workspaceCache';
const TITLE_CACHE_KEY = 'titleCache';
const MSG_COUNT_CACHE_KEY = 'messageCountCache';
const SORT_CACHE_KEY = 'sortBy';
const STARRED_CACHE_KEY = 'starredIds';
const VIEW_MODE_CACHE_KEY = 'viewMode';
const ARCHIVED_CACHE_KEY = 'archivedIds';

/** Auto-summarize state */
let autoSummarizeRunning = false;
let autoSummarizeDismissed = false; // "Not now" → skip this VS Code session

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

    // Load summarized IDs and texts from globalState for ✨ badges + tooltip preview
    const summaryCache: Record<string, { text: string; generatedAt: string }> = context.globalState.get('summaryCache', {});
    treeProvider.summarizedIds = new Set(Object.keys(summaryCache));
    treeProvider.summaryTexts = new Map(
        Object.entries(summaryCache).map(([id, entry]) => [id, entry.text]),
    );

    // Load starred conversation IDs from globalState
    const starredArr: string[] = context.globalState.get(STARRED_CACHE_KEY, []);
    treeProvider.starredIds = new Set(starredArr);

    // Restore persisted view mode + set context key for menu when-clauses
    const savedViewMode = context.globalState.get<ViewMode>(VIEW_MODE_CACHE_KEY) || 'sessions';
    treeProvider.setViewMode(savedViewMode);
    vscode.commands.executeCommand('setContext', 'convManager.viewMode', savedViewMode);

    // Detect current workspace to auto-prioritize its group in the tree
    const currentFolder = vscode.workspace.workspaceFolders?.[0]?.name ?? null;
    if (currentFolder) {
        treeProvider.setActiveWorkspace(currentFolder);
        log(`Active workspace detected: ${currentFolder}`);
    }

    // Register native Tree View for the sidebar
    const treeView = vscode.window.createTreeView('convManager.sessions', {
        treeDataProvider: treeProvider,
        showCollapseAll: true,
    });
    context.subscriptions.push(treeView);

    // Active conversation token tracker (status bar)
    const tokenTracker = new ActiveTokenTracker(
        context,
        () => apiClient,
        () => treeProvider.conversations,
    );
    context.subscriptions.push(tokenTracker);

    // Scan and populate on activation, then invalidate stale summaries, then auto-summarize
    loadConversations(context, treeProvider, treeView).then(() => {
        invalidateStaleSummaries(context, treeProvider);
        tryAutoSummarize(context, treeProvider);
        tokenTracker.start();
    });

    // Commands
    context.subscriptions.push(
        vscode.commands.registerCommand('convManager.refresh', () => {
            apiClient?.disconnect();
            apiClient = undefined;
            messageCache.clear();
            loadConversations(context, treeProvider, treeView).then(() => {
                invalidateStaleSummaries(context, treeProvider);
            });
        }),

        vscode.commands.registerCommand('convManager.viewRecent', () => {
            treeProvider.setViewMode('recent');
            context.globalState.update(VIEW_MODE_CACHE_KEY, 'recent');
            vscode.commands.executeCommand('setContext', 'convManager.viewMode', 'recent');
        }),

        vscode.commands.registerCommand('convManager.viewSessions', () => {
            treeProvider.setViewMode('sessions');
            context.globalState.update(VIEW_MODE_CACHE_KEY, 'sessions');
            vscode.commands.executeCommand('setContext', 'convManager.viewMode', 'sessions');
        }),

        vscode.commands.registerCommand('convManager.revealActive', () => {
            // Reveal the active conversation in the tree view (placeholder — just open sidebar)
            vscode.commands.executeCommand('convManager.sessions.focus');
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
                vscode.window.showInformationMessage(vscode.l10n.t('No conversations loaded yet.'));
                return;
            }

            interface SearchItem extends vscode.QuickPickItem {
                session: ConversationInfo;
            }

            const quickPick = vscode.window.createQuickPick<SearchItem>();
            quickPick.placeholder = vscode.l10n.t('Search conversations by title or workspace…');
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
                if (c.messageCount) { infoParts.push(vscode.l10n.t('{0} msgs', c.messageCount)); }
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
                    label: vscode.l10n.t('$(calendar) Last Modified'),
                    description: current === 'date' ? vscode.l10n.t('(current)') : '',
                    detail: vscode.l10n.t('Most recently modified first'),
                    sortKey: 'date',
                },
                {
                    label: vscode.l10n.t('$(clock) Created'),
                    description: current === 'created' ? vscode.l10n.t('(current)') : '',
                    detail: vscode.l10n.t('Most recently created first'),
                    sortKey: 'created',
                },
                {
                    label: vscode.l10n.t('$(case-sensitive) Name'),
                    description: current === 'name' ? vscode.l10n.t('(current)') : '',
                    detail: vscode.l10n.t('Alphabetical by title'),
                    sortKey: 'name',
                },
            ];
            const picked = await vscode.window.showQuickPick(items, {
                title: vscode.l10n.t('Sort Conversations'),
            });
            if (picked) {
                treeProvider.setSortBy(picked.sortKey);
                context.globalState.update(SORT_CACHE_KEY, picked.sortKey);
            }
        }),

        vscode.commands.registerCommand('convManager.filterWorkspace', async () => {
            const workspaces = treeProvider.getUniqueWorkspaces();
            const current = treeProvider.filterWorkspace;
            const starredOnly = treeProvider.showStarredOnly;
            const hidingArchived = treeProvider.hideArchived;
            const archivedCount = treeProvider.conversations.filter(c => c.archived).length;

            interface FilterItem extends vscode.QuickPickItem {
                workspace: string | null;
                starred?: boolean;
                hideArchived?: boolean;
            }

            const items: FilterItem[] = [
                {
                    label: vscode.l10n.t('$(globe) All Workspaces'),
                    description: current === null && !starredOnly && !hidingArchived ? vscode.l10n.t('(current)') : '',
                    workspace: null,
                },
                {
                    label: vscode.l10n.t('$(star-full) Starred Only'),
                    description: starredOnly ? vscode.l10n.t('(current)') : '',
                    detail: vscode.l10n.t('{0} starred', treeProvider.starredIds.size),
                    workspace: null,
                    starred: true,
                },
                {
                    label: vscode.l10n.t('$(archive) Active Only'),
                    description: hidingArchived ? vscode.l10n.t('(current)') : '',
                    detail: vscode.l10n.t('{0} archived hidden', archivedCount),
                    workspace: null,
                    hideArchived: true,
                },
                {
                    label: vscode.l10n.t('$(question) (no workspace)'),
                    description: current === '' && !starredOnly && !hidingArchived ? vscode.l10n.t('(current)') : '',
                    workspace: '',
                },
                ...workspaces.map(ws => ({
                    label: `$(folder) ${ws}`,
                    description: current === ws && !starredOnly && !hidingArchived ? vscode.l10n.t('(current)') : '',
                    workspace: ws,
                })),
            ];
            const picked = await vscode.window.showQuickPick(items, {
                title: vscode.l10n.t('Filter Conversations'),
            });
            if (picked) {
                if (picked.starred) {
                    treeProvider.setShowStarredOnly(true);
                } else if (picked.hideArchived) {
                    treeProvider.setHideArchived(true);
                } else {
                    treeProvider.setFilter(picked.workspace);
                }
            }
        }),

        vscode.commands.registerCommand('convManager.star', (item?: any) => {
            const session: ConversationInfo | undefined = item?.session;
            if (!session) { return; }
            treeProvider.starredIds.add(session.id);
            context.globalState.update(STARRED_CACHE_KEY, [...treeProvider.starredIds]);
            treeProvider.refresh();
        }),

        vscode.commands.registerCommand('convManager.unstar', (item?: any) => {
            const session: ConversationInfo | undefined = item?.session;
            if (!session) { return; }
            treeProvider.starredIds.delete(session.id);
            context.globalState.update(STARRED_CACHE_KEY, [...treeProvider.starredIds]);
            treeProvider.refresh();
        }),

        vscode.commands.registerCommand('convManager.copyId', (item?: any) => {
            const session: ConversationInfo | undefined = item?.session;
            if (!session) { return; }
            vscode.env.clipboard.writeText(session.id);
            vscode.window.showInformationMessage(vscode.l10n.t('Copied: {0}', session.id));
        }),

        vscode.commands.registerCommand('convManager.revealInExplorer', (item?: any) => {
            const session: ConversationInfo | undefined = item?.session;
            if (!session) { return; }
            const brainPath = path.join(getAntigravityRoot(), 'brain', session.id);
            vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(brainPath));
        }),

        vscode.commands.registerCommand('convManager.toggleArchive', (item?: any) => {
            const session: ConversationInfo | undefined = item?.session;
            if (!session) { return; }

            const archivedIds: string[] = context.globalState.get(ARCHIVED_CACHE_KEY, []);
            const archivedSet = new Set(archivedIds);

            if (archivedSet.has(session.id)) {
                archivedSet.delete(session.id);
                session.archived = false;
            } else {
                archivedSet.add(session.id);
                session.archived = true;
            }

            context.globalState.update(ARCHIVED_CACHE_KEY, [...archivedSet]);
            treeProvider.refresh();
        }),

        vscode.commands.registerCommand('convManager.summarize', async (item?: any) => {
            // Accept SessionItem from tree view context menu
            const session: ConversationInfo | undefined = item?.session;
            if (!session) {
                vscode.window.showWarningMessage(vscode.l10n.t('Right-click a conversation to generate an AI summary.'));
                return;
            }

            // Check if already summarized
            const existing = getSummary(context.globalState, session.id);
            if (existing) {
                const btnRegenerate = vscode.l10n.t('Regenerate');
                const btnView = vscode.l10n.t('View');
                const btnCancel = vscode.l10n.t('Cancel');
                const action = await vscode.window.showInformationMessage(
                    vscode.l10n.t('This conversation already has a summary ({0}).', new Date(existing.generatedAt).toLocaleDateString()),
                    btnRegenerate, btnView, btnCancel,
                );
                if (action === btnCancel || !action) { return; }
                if (action === btnView) {
                    ContentPanel.show(session.id, session.title || session.id.substring(0, 8),
                        async () => messageCache.get(session.id) || null, existing.text);
                    return;
                }
                // Regenerate falls through
            }

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: vscode.l10n.t('AI Summary: {0}', session.title || session.id.substring(0, 8)),
                cancellable: false,
            }, async (progress) => {
                try {
                    // Step 1: Get messages
                    progress.report({ message: vscode.l10n.t('Fetching conversation content…') });
                    let messages = messageCache.get(session.id);
                    if (!messages) {
                        if (!apiClient) {
                            apiClient = new AntigravityClient();
                            await apiClient.connect();
                        }
                        if (!apiClient.isConnected) {
                            throw new Error(vscode.l10n.t('Cannot connect to Antigravity API'));
                        }
                        messages = await apiClient.getConversation(session.id) ?? undefined;
                        if (messages && messages.length > 0) {
                            messageCache.set(session.id, messages);
                        }
                    }
                    if (!messages || messages.length === 0) {
                        throw new Error(vscode.l10n.t('Failed to fetch conversation messages'));
                    }

                    // Step 2: Call AI
                    progress.report({ message: vscode.l10n.t('Calling AI to generate summary…') });
                    const summaryText = await summarize(messages, context.secrets);

                    // Step 3: Cache result
                    const entry = { text: summaryText, generatedAt: new Date().toISOString(), messageCount: session.messageCount || 0 };
                    setSummary(context.globalState, session.id, entry);

                    // Step 4: Update tree badge + tooltip preview
                    treeProvider.summarizedIds.add(session.id);
                    treeProvider.summaryTexts.set(session.id, summaryText);
                    treeProvider.refresh();

                    // Step 5: Show in panel
                    ContentPanel.show(session.id, session.title || session.id.substring(0, 8),
                        async () => messages, summaryText);

                    vscode.window.showInformationMessage(vscode.l10n.t('AI summary generated successfully.'));
                } catch (e: unknown) {
                    const msg = e instanceof Error ? e.message : String(e);
                    vscode.window.showErrorMessage(vscode.l10n.t('AI summary failed: {0}', msg));
                }
            });
        }),

        vscode.commands.registerCommand('convManager.showStats', async () => {
            const cfg = vscode.workspace.getConfiguration('convManager.ai');
            const apiKey = await getApiKey(context.secrets);
            const aiConfig: AiConfigSnapshot = {
                minMessages: cfg.get<number>('minMessages') ?? 5,
                cooldownHours: cfg.get<number>('cooldownHours') ?? 2,
                hasApiKey: !!apiKey,
                hasEndpoint: !!cfg.get<string>('endpoint'),
                hasModel: !!cfg.get<string>('model'),
            };

            const showStatsPanel = () => {
                const freshCfg = vscode.workspace.getConfiguration('convManager.ai');
                const freshAiConfig: AiConfigSnapshot = {
                    ...aiConfig,
                    hasApiKey: aiConfig.hasApiKey,
                    hasEndpoint: !!freshCfg.get<string>('endpoint'),
                    hasModel: !!freshCfg.get<string>('model'),
                };
                StatsPanel.show(treeProvider.conversations, treeProvider.summarizedIds, freshAiConfig, callbacks);
            };

            const callbacks: StatsPanelCallbacks = {
                onCleanStale: async () => {
                    const staleConvs = treeProvider.conversations.filter(c => c.stale);
                    if (staleConvs.length === 0) {
                        vscode.window.showInformationMessage(vscode.l10n.t('No stale conversations to clean.'));
                        showStatsPanel();
                        return;
                    }

                    const detail = staleConvs
                        .map(c => `• ${c.title || c.id.substring(0, 8)}`)
                        .join('\n');

                    const btnClean = vscode.l10n.t('Confirm Cleanup');
                    const confirm = await vscode.window.showWarningMessage(
                        vscode.l10n.t('Clean up {0} stale conversations (move to Recycle Bin)', staleConvs.length),
                        { modal: true, detail },
                        btnClean,
                    );
                    if (confirm !== btnClean) {
                        showStatsPanel(); // re-render to reset button state
                        return;
                    }

                    const root = getAntigravityRoot();
                    let cleaned = 0;

                    await vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: vscode.l10n.t('Cleaning stale conversations…'),
                    }, async (progress) => {
                        for (const conv of staleConvs) {
                            progress.report({ message: `${cleaned + 1}/${staleConvs.length}` });

                            // Delete brain/{id}/ directory
                            try {
                                const brainUri = vscode.Uri.file(path.join(root, 'brain', conv.id));
                                await vscode.workspace.fs.delete(brainUri, { recursive: true, useTrash: true });
                            } catch { /* may not exist */ }

                            // Delete conversations/{id}.pb
                            try {
                                const pbUri = vscode.Uri.file(path.join(root, 'conversations', `${conv.id}.pb`));
                                await vscode.workspace.fs.delete(pbUri, { useTrash: true });
                            } catch { /* may not exist */ }

                            // Clean in-memory cache
                            messageCache.delete(conv.id);
                            treeProvider.summarizedIds.delete(conv.id);
                            cleaned++;
                        }
                    });

                    // Clean globalState caches in batch
                    const staleIds = new Set(staleConvs.map(c => c.id));
                    const wsCache: Record<string, string | null> = context.globalState.get(WORKSPACE_CACHE_KEY, {});
                    const titleCacheData: Record<string, string> = context.globalState.get(TITLE_CACHE_KEY, {});
                    const msgCache: Record<string, number> = context.globalState.get(MSG_COUNT_CACHE_KEY, {});
                    const sumCache: Record<string, unknown> = context.globalState.get('summaryCache', {});

                    for (const id of staleIds) {
                        delete wsCache[id];
                        delete titleCacheData[id];
                        delete msgCache[id];
                        delete sumCache[id];
                        treeProvider.starredIds.delete(id);
                    }

                    await context.globalState.update(WORKSPACE_CACHE_KEY, wsCache);
                    await context.globalState.update(TITLE_CACHE_KEY, titleCacheData);
                    await context.globalState.update(MSG_COUNT_CACHE_KEY, msgCache);
                    await context.globalState.update('summaryCache', sumCache);
                    await context.globalState.update(STARRED_CACHE_KEY, [...treeProvider.starredIds]);

                    // Update in-memory conversation list (remove stale) and refresh tree
                    const remaining = treeProvider.conversations.filter(c => !staleIds.has(c.id));
                    treeProvider.setConversations([...remaining]);
                    treeView.badge = { value: remaining.length, tooltip: vscode.l10n.t('{0} conversations', remaining.length) };

                    // Refresh stats panel with updated data
                    showStatsPanel();

                    vscode.window.showInformationMessage(
                        vscode.l10n.t('Cleaned up {0} stale conversations (moved to Recycle Bin)', cleaned),
                    );
                },
            };

            showStatsPanel();
        }),

        vscode.commands.registerCommand('convManager.setApiKey', async () => {
            const current = await getApiKey(context.secrets);
            const hint = current ? vscode.l10n.t('Current: ····{0}', current.slice(-4)) : vscode.l10n.t('Not set');
            const key = await vscode.window.showInputBox({
                title: vscode.l10n.t('Set AI API Key'),
                prompt: vscode.l10n.t('Enter AI API Key ({0})', hint),
                password: true,
                placeHolder: vscode.l10n.t('Leave empty to clear existing key'),
            });
            if (key === undefined) { return; } // cancelled
            await setApiKey(context.secrets, key);

            if (!key) {
                vscode.window.showInformationMessage(vscode.l10n.t('API Key cleared.'));
                return;
            }

            // Auto-test connection after saving
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: vscode.l10n.t('Verifying AI API connectivity…'),
            }, async () => {
                try {
                    const models = await testConnection(context.secrets);
                    vscode.window.showInformationMessage(
                        vscode.l10n.t('\u2705 Connected! Found {0} models{1}', models.length, models.length > 0 ? ` (${models.slice(0, 3).join(', ')}\u2026)` : ''),
                    );
                } catch (e: unknown) {
                    const msg = e instanceof Error ? e.message : String(e);
                    vscode.window.showWarningMessage(vscode.l10n.t('API Key saved, but connection test failed: {0}', msg));
                }
            });
        }),

        vscode.commands.registerCommand('convManager.showTokenDashboard', async () => {
            const dashboard = TokenDashboard.create();

            // Ensure API connection
            if (!apiClient) {
                apiClient = new AntigravityClient();
                await apiClient.connect();
            }
            if (!apiClient.isConnected) {
                vscode.window.showErrorMessage(vscode.l10n.t('Cannot connect to Antigravity API. Make sure Antigravity is running.'));
                return;
            }

            // Fetch metadata for all non-stale conversations
            const conversations = treeProvider.conversations.filter(c => !c.stale);
            const allMetadata: any[][] = [];
            const BATCH_SIZE = 5;

            for (let i = 0; i < conversations.length; i += BATCH_SIZE) {
                const batch = conversations.slice(i, i + BATCH_SIZE);
                const results = await Promise.allSettled(
                    batch.map(c => apiClient!.getTrajectoryMetadata(c.id)),
                );

                for (const r of results) {
                    if (r.status === 'fulfilled' && r.value.length > 0) {
                        allMetadata.push(r.value);
                    }
                }

                dashboard.sendProgress(Math.min(i + BATCH_SIZE, conversations.length), conversations.length);
            }

            // Aggregate and render
            const data = aggregateTokenData(allMetadata);
            dashboard.sendData(data);

            log(`Token Dashboard: ${data.conversationCount} convs, ${data.totalCalls} API calls, ${data.totalInput + data.totalOutput} tokens`);
        }),
    );
}

/**
 * Scan brain/ directory and enrich with API metadata.
 *
 * Three-phase loading strategy:
 *   Phase 1: Local brain/ scan + apply cached workspace mappings (instant)
 *   Phase 2: GetAllCascadeTrajectories — batch title + workspace enrichment
 *   Phase 3: GetCascadeTrajectory per conversation — deep enrichment
 *            (workspace, createdAt, messageCount; batch parallel, cached to globalState)
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
    const archivedCache: string[] = context.globalState.get(ARCHIVED_CACHE_KEY, []);
    const archivedSet = new Set(archivedCache);
    let cacheUpdated = false;
    let titleCacheUpdated = false;
    let msgCountCacheUpdated = false;
    let archivedCacheUpdated = false;

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
            if (archivedSet.has(conv.id)) {
                conv.archived = true;
            }
        }
        treeProvider.setConversations(conversations);
        treeView.badge = { value: conversations.length, tooltip: vscode.l10n.t('{0} conversations', conversations.length) };

        // Phase 2: API metadata enrichment
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
                            conv.stale = false;
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
                        } else {
                            // Not in API response → Antigravity no longer shows this conversation
                            conv.stale = true;
                        }
                    }
                    treeProvider.setConversations(conversations);
                }

                // Phase 3: Deep enrichment via GetCascadeTrajectory
                // Fetch conversations missing workspace, createdAt, or messageCount
                const archiveKeywords: string[] = vscode.workspace.getConfiguration('convManager').get('archiveKeywords', ['@[/close]']);
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
                            batch.map(c => apiClient!.getConversationDetails(c.id, archiveKeywords)),
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
                                if (r.value.archived && !archivedSet.has(batch[j].id)) {
                                    batch[j].archived = true;
                                    archivedSet.add(batch[j].id);
                                    archivedCacheUpdated = true;
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
        vscode.window.showErrorMessage(vscode.l10n.t('Failed to scan conversations: {0}', msg));
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
    if (archivedCacheUpdated) {
        context.globalState.update(ARCHIVED_CACHE_KEY, [...archivedSet]);
    }
}

// ====================== Stale Summary Detection ======================

/**
 * Invalidate summaries that are outdated due to new conversation activity.
 *
 * Compares the message count stored at summarization time with the current
 * message count. If the delta exceeds the configured threshold, the summary
 * is deleted — returning the conversation to "unsummarized" status so it
 * naturally enters the auto-summarize queue.
 */
function invalidateStaleSummaries(
    context: vscode.ExtensionContext,
    treeProvider: SessionTreeProvider,
): void {
    const cfg = vscode.workspace.getConfiguration('convManager.ai');
    const threshold = cfg.get<number>('staleThreshold') ?? 10;
    const cache: Record<string, SummaryEntry> = context.globalState.get('summaryCache', {});
    const conversations = treeProvider.conversations;
    let changed = false;

    for (const conv of conversations) {
        const entry = cache[conv.id];
        if (!entry) { continue; }

        // Skip legacy entries without messageCount (backward-compatible)
        if (entry.messageCount === undefined || conv.messageCount === undefined) { continue; }

        const delta = conv.messageCount - entry.messageCount;
        if (delta >= threshold) {
            delete cache[conv.id];
            treeProvider.summarizedIds.delete(conv.id);
            treeProvider.summaryTexts.delete(conv.id);
            changed = true;
            log(`Summary invalidated: ${conv.title || conv.id.slice(0, 8)} (+${delta} msgs)`);
        }
    }

    if (changed) {
        context.globalState.update('summaryCache', cache);
        treeProvider.refresh();
    }
}

// ====================== Auto-Summarize ======================

/**
 * Try to auto-summarize unsummarized conversations.
 * Called after loadConversations completes.
 *
 * Behavior is controlled by convManager.ai.autoSummarize:
 *   - "ask": Prompt user for confirmation (default)
 *   - "on": Run silently
 *   - "off": Disabled
 */
async function tryAutoSummarize(
    context: vscode.ExtensionContext,
    treeProvider: SessionTreeProvider,
): Promise<void> {
    // Guard: mutex + session dismiss flag
    if (autoSummarizeRunning || autoSummarizeDismissed) { return; }

    // Guard: check config
    const cfg = vscode.workspace.getConfiguration('convManager.ai');
    const mode = cfg.get<string>('autoSummarize') || 'ask';
    if (mode === 'off') { return; }

    // Guard: check API is configured
    const endpoint = cfg.get<string>('endpoint');
    const model = cfg.get<string>('model');
    const apiKey = await getApiKey(context.secrets);
    if (!endpoint || !apiKey || !model) { return; }

    // Find candidates
    const minMessages = cfg.get<number>('minMessages') ?? 5;
    const cooldownHours = cfg.get<number>('cooldownHours') ?? 2;
    const cooldownMs = cooldownHours * 60 * 60 * 1000;
    const conversations = treeProvider.conversations;

    const candidates = conversations.filter(c => {
        if (c.stale) { return false; }
        if (treeProvider.summarizedIds.has(c.id)) { return false; }
        if ((c.messageCount ?? 0) < minMessages) { return false; }
        if (c.lastModified > Date.now() - cooldownMs) { return false; }
        return true;
    });

    if (candidates.length === 0) { return; }

    // "ask" mode: prompt user
    if (mode === 'ask') {
        const btnStart = vscode.l10n.t('Start');
        const btnNotNow = vscode.l10n.t('Not Now');
        const btnDisable = vscode.l10n.t('Don\'t Ask Again');
        const action = await vscode.window.showInformationMessage(
            vscode.l10n.t('Found {0} conversations ready for auto-summary (\u2265{1} messages, inactive for {2}h). Continue?', candidates.length, minMessages, cooldownHours),
            btnStart, btnNotNow, btnDisable,
        );
        if (action === btnNotNow || !action) {
            autoSummarizeDismissed = true;
            return;
        }
        if (action === btnDisable) {
            cfg.update('autoSummarize', 'off', vscode.ConfigurationTarget.Global);
            return;
        }
        // Start falls through
    }

    // Run the queue
    autoSummarizeRunning = true;
    let autoSummarizeCancelled = false;

    const stopCommand = vscode.commands.registerCommand('convManager._stopAutoSummarize', () => {
        autoSummarizeCancelled = true;
    });

    const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    statusItem.command = 'convManager._stopAutoSummarize';
    statusItem.show();

    let success = 0;
    let fail = 0;

    try {
        for (let i = 0; i < candidates.length; i++) {
            if (autoSummarizeCancelled) { break; }

            const conv = candidates[i];
            statusItem.text = `$(sync~spin) ${vscode.l10n.t('Summarizing {0}/{1}…', i + 1, candidates.length)}`;
            statusItem.tooltip = `${conv.title || conv.id.substring(0, 8)} — ${vscode.l10n.t('click to stop')}`;

            try {
                // Fetch messages
                let messages = messageCache.get(conv.id);
                if (!messages) {
                    if (!apiClient) {
                        apiClient = new AntigravityClient();
                        await apiClient.connect();
                    }
                    if (!apiClient.isConnected) {
                        throw new Error(vscode.l10n.t('API unavailable'));
                    }
                    const fetched = await apiClient.getConversation(conv.id);
                    if (fetched && fetched.length > 0) {
                        messages = fetched;
                        messageCache.set(conv.id, fetched);
                    }
                }

                if (!messages || messages.length === 0) {
                    fail++;
                    continue;
                }

                // Call AI
                const summaryText = await summarize(messages, context.secrets);
                const entry = { text: summaryText, generatedAt: new Date().toISOString(), messageCount: conv.messageCount || 0 };
                setSummary(context.globalState, conv.id, entry);

                treeProvider.summarizedIds.add(conv.id);
                treeProvider.summaryTexts.set(conv.id, summaryText);
                success++;

                // Inter-request delay (2s) to avoid rate limiting
                if (i < candidates.length - 1) {
                    await new Promise(r => setTimeout(r, 2000));
                }
            } catch (e: unknown) {
                fail++;
                const msg = e instanceof Error ? e.message : String(e);
                log(`[AutoSummarize] ${conv.id.slice(0, 8)} failed: ${msg}`);

                // Back off on error (5s)
                if (i < candidates.length - 1) {
                    await new Promise(r => setTimeout(r, 5000));
                }
            }
        }
    } finally {
        autoSummarizeRunning = false;
        statusItem.dispose();
        stopCommand.dispose();

        if (autoSummarizeCancelled) {
            treeProvider.refresh();
            vscode.window.showInformationMessage(
                vscode.l10n.t('\u23f9 Auto-summary stopped: {0} completed{1}', success, fail > 0 ? vscode.l10n.t(', {0} failed', fail) : ''),
            );
        } else if (success > 0) {
            treeProvider.refresh();
            vscode.window.showInformationMessage(
                vscode.l10n.t('\u2728 Auto-summary complete: {0} succeeded{1}', success, fail > 0 ? vscode.l10n.t(', {0} failed', fail) : ''),
            );
        } else if (fail > 0) {
            vscode.window.showWarningMessage(vscode.l10n.t('Auto-summary failed for all {0} conversations', fail));
        }
    }
}

export function deactivate() {
    // cleanup
}
