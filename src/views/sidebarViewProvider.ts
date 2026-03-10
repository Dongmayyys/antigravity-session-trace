/**
 * Session Tree Provider — Native TreeView-based conversation browser.
 *
 * Displays conversations in the Activity Bar sidebar, grouped by workspace.
 * Supports sorting (lastModified / created / name), workspace filtering,
 * and text search via Quick Pick.
 *
 * Tree structure:
 *   CategoryItem (workspace group)
 *     └─ SessionItem (individual conversation)
 *   InfoItem (empty state / status messages)
 */

import * as vscode from 'vscode';
import { ConversationInfo } from '../types';

export type ViewMode = 'sessions' | 'recent';
export type SortBy = 'date' | 'created' | 'name';

type TreeNode = CategoryItem | SessionItem | InfoItem;

export class SessionTreeProvider implements vscode.TreeDataProvider<TreeNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private _conversations: ConversationInfo[] = [];
    private _viewMode: ViewMode = 'sessions';
    private _sortBy: SortBy = 'date';
    private _filterWorkspace: string | null = null; // null = show all
    private _searchQuery = '';
    private _showStarredOnly = false;
    private _hideArchived = false;
    private _activeWorkspace: string | null = null;

    /** IDs of conversations that have AI summaries (set by extension.ts). */
    summarizedIds: Set<string> = new Set();

    /** Summary texts keyed by conversation ID (set by extension.ts for tooltip preview). */
    summaryTexts: Map<string, string> = new Map();

    /** IDs of starred conversations (set by extension.ts, persisted in globalState). */
    starredIds: Set<string> = new Set();

    get viewMode(): ViewMode { return this._viewMode; }
    get sortBy(): SortBy { return this._sortBy; }
    get filterWorkspace(): string | null { return this._filterWorkspace; }
    get showStarredOnly(): boolean { return this._showStarredOnly; }
    get hideArchived(): boolean { return this._hideArchived; }
    get searchQuery(): string { return this._searchQuery; }
    get conversations(): readonly ConversationInfo[] { return this._conversations; }

    /**
     * Replace the conversation list and refresh the tree.
     * Called by the three-phase loading pipeline in extension.ts.
     */
    setConversations(conversations: ConversationInfo[]): void {
        this._conversations = conversations;
        this._onDidChangeTreeData.fire();
    }

    setViewMode(mode: ViewMode): void {
        this._viewMode = mode;
        this._onDidChangeTreeData.fire();
    }

    setSortBy(sort: SortBy): void {
        this._sortBy = sort;
        this._onDidChangeTreeData.fire();
    }

    setFilter(workspace: string | null): void {
        this._filterWorkspace = workspace;
        this._showStarredOnly = false;
        this._hideArchived = false;
        this._onDidChangeTreeData.fire();
    }

    setShowStarredOnly(show: boolean): void {
        this._showStarredOnly = show;
        this._hideArchived = false;
        if (show) { this._filterWorkspace = null; }
        this._onDidChangeTreeData.fire();
    }

    setHideArchived(hide: boolean): void {
        this._hideArchived = hide;
        if (hide) {
            this._filterWorkspace = null;
            this._showStarredOnly = false;
        }
        this._onDidChangeTreeData.fire();
    }

    setSearch(query: string): void {
        this._searchQuery = query;
        this._onDidChangeTreeData.fire();
    }

    /**
     * Set the active workspace name (detected from the current VS Code window).
     * The matching group will be sorted first and expanded by default.
     */
    setActiveWorkspace(workspace: string | null): void {
        this._activeWorkspace = workspace;
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    /** Return distinct workspace names for the filter Quick Pick. */
    getUniqueWorkspaces(): string[] {
        const set = new Set<string>();
        for (const c of this._conversations) {
            if (c.workspace) { set.add(c.workspace); }
        }
        return [...set].sort();
    }

    getTreeItem(element: TreeNode): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: TreeNode): Promise<TreeNode[]> {
        if (!element) {
            if (this._viewMode === 'recent') {
                return this._getRecentChildren();
            }
            return this._getRootChildren();
        }
        if (element instanceof CategoryItem) {
            return element.sessions.map(s => new SessionItem(s, this.summarizedIds, this.summaryTexts, this.starredIds));
        }
        return [];
    }

    // ====================== Private ======================

    private _getRootChildren(): TreeNode[] {
        let filtered = this._conversations;

        // Text search
        if (this._searchQuery) {
            const q = this._searchQuery.toLowerCase();
            filtered = filtered.filter(c =>
                (c.title || '').toLowerCase().includes(q) ||
                (c.workspace || '').toLowerCase().includes(q) ||
                c.id.toLowerCase().includes(q),
            );
        }

        // Starred filter
        if (this._showStarredOnly) {
            filtered = filtered.filter(c => this.starredIds.has(c.id));
        }

        // Archived filter
        if (this._hideArchived) {
            filtered = filtered.filter(c => !c.archived);
        }

        // Workspace filter
        if (this._filterWorkspace !== null) {
            if (this._filterWorkspace === '') {
                filtered = filtered.filter(c => !c.workspace);
            } else {
                filtered = filtered.filter(c => c.workspace === this._filterWorkspace);
            }
        }

        // Sort
        const sorted = [...filtered];
        this._applySort(sorted);

        if (sorted.length === 0) {
            const hint = this._searchQuery
                ? vscode.l10n.t('No matches — try a different search term')
                : this._showStarredOnly
                    ? vscode.l10n.t('No starred conversations')
                    : this._filterWorkspace !== null
                        ? vscode.l10n.t('No conversations in this workspace')
                        : vscode.l10n.t('No conversations found');
            return [new InfoItem(hint, '', 'info')];
        }

        // When filtering to a single workspace or starred-only, flatten (no grouping)
        if (this._filterWorkspace !== null || this._showStarredOnly) {
            return sorted.map(s => new SessionItem(s, this.summarizedIds, this.summaryTexts, this.starredIds));
        }

        // Group by workspace
        const grouped = new Map<string, ConversationInfo[]>();
        for (const c of sorted) {
            const key = c.workspace || vscode.l10n.t('(no workspace)');
            if (!grouped.has(key)) { grouped.set(key, []); }
            grouped.get(key)!.push(c);
        }

        const activeWs = this._activeWorkspace;
        const sortedKeys = [...grouped.keys()].sort((a, b) => {
            // Active workspace always first
            if (activeWs) {
                if (a === activeWs) { return -1; }
                if (b === activeWs) { return 1; }
            }
            if (a === vscode.l10n.t('(no workspace)')) { return 1; }
            if (b === vscode.l10n.t('(no workspace)')) { return -1; }
            return a.localeCompare(b);
        });

        return sortedKeys.map(key => {
            const sessions = grouped.get(key)!;
            const icon = key === vscode.l10n.t('(no workspace)') ? 'globe' : 'folder';
            const expanded = key === activeWs;
            return new CategoryItem(key, sessions, icon, expanded);
        });
    }

    /**
     * Recent mode: flat list sorted by lastModified DESC.
     * No workspace grouping, stale excluded.
     */
    private _getRecentChildren(): TreeNode[] {
        let filtered = this._conversations.filter(c => !c.stale);

        // Starred filter still applies in recent mode
        if (this._showStarredOnly) {
            filtered = filtered.filter(c => this.starredIds.has(c.id));
        }

        // Archived filter
        if (this._hideArchived) {
            filtered = filtered.filter(c => !c.archived);
        }

        // Always sort by lastModified DESC in recent mode
        const sorted = [...filtered].sort((a, b) => b.lastModified - a.lastModified);

        if (sorted.length === 0) {
            return [new InfoItem(vscode.l10n.t('No recent conversations'), '', 'info')];
        }

        return sorted.map(
            s => new SessionItem(s, this.summarizedIds, this.summaryTexts, this.starredIds),
        );
    }

    private _applySort(conversations: ConversationInfo[]): void {
        switch (this._sortBy) {
            case 'date':
                conversations.sort((a, b) => b.lastModified - a.lastModified);
                break;
            case 'created':
                conversations.sort((a, b) =>
                    (b.createdAt || b.lastModified) - (a.createdAt || a.lastModified),
                );
                break;
            case 'name':
                conversations.sort((a, b) => {
                    const aName = (a.title || a.id).toLowerCase();
                    const bName = (b.title || b.id).toLowerCase();
                    return aName.localeCompare(bName);
                });
                break;
        }

        // Starred conversations float to top (stable sort preserves primary order within groups)
        if (this.starredIds.size > 0) {
            conversations.sort((a, b) => {
                const as = this.starredIds.has(a.id) ? 0 : 1;
                const bs = this.starredIds.has(b.id) ? 0 : 1;
                return as - bs;
            });
        }
    }
}

// ====================== Helpers ======================

export function relativeTime(ts: number): string {
    const diff = Date.now() - ts;
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) { return vscode.l10n.t('just now'); }
    if (minutes < 60) { return vscode.l10n.t('{0}m ago', minutes); }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) { return vscode.l10n.t('{0}h ago', hours); }
    const days = Math.floor(hours / 24);
    if (days < 30) { return vscode.l10n.t('{0}d ago', days); }
    return vscode.l10n.t('{0}mo ago', Math.floor(days / 30));
}

// ====================== Tree Item Classes ======================

/**
 * Workspace group node — collapsible container for sessions.
 */
class CategoryItem extends vscode.TreeItem {
    constructor(
        public readonly workspaceKey: string,
        public readonly sessions: ConversationInfo[],
        icon: string = 'folder',
        expanded: boolean = false,
    ) {
        super(
            `${workspaceKey} (${sessions.length})`,
            expanded
                ? vscode.TreeItemCollapsibleState.Expanded
                : vscode.TreeItemCollapsibleState.Collapsed,
        );
        this.id = `category:${workspaceKey}`;
        this.iconPath = new vscode.ThemeIcon(icon);
        this.contextValue = 'category';
    }
}

/**
 * Individual conversation node.
 *
 * - description: "5 msgs · 2h ago" or just "2h ago"
 * - icon: color-coded by message count (red > 20, yellow > 5)
 * - tooltip: Markdown with metadata
 * - click: opens conversation in ContentPanel
 */
export class SessionItem extends vscode.TreeItem {
    constructor(
        public readonly session: ConversationInfo,
        summarizedIds?: Set<string>,
        summaryTexts?: Map<string, string>,
        starredIds?: Set<string>,
    ) {
        const MAX_TITLE_LEN = 25;
        const rawLabel = session.title || session.id.substring(0, 8);
        const label = rawLabel.length > MAX_TITLE_LEN
            ? rawLabel.substring(0, MAX_TITLE_LEN) + '…'
            : rawLabel;
        super(label, vscode.TreeItemCollapsibleState.None);

        this.id = `session:${session.id}`;

        const rel = relativeTime(session.lastModified);
        const turns = session.messageCount;
        const hasSummary = summarizedIds?.has(session.id) ?? false;
        const isStarred = starredIds?.has(session.id) ?? false;

        if (session.stale) {
            // Stale: local remnant not shown by Antigravity
            this.description = `(${vscode.l10n.t('stale')}) · ${rel}`;
            this.iconPath = new vscode.ThemeIcon(
                'circle-slash',
                new vscode.ThemeColor('disabledForeground'),
            );
            this.tooltip = new vscode.MarkdownString([
                `**${rawLabel}**`,
                '',
                vscode.l10n.t('⚠️ *Stale — exists locally but not shown in Antigravity*'),
                '',
                `- **${vscode.l10n.t('Last modified')}**: ${new Date(session.lastModified).toLocaleString()}`,
                `- **ID**: \`${session.id}\``,
            ].join('\n'));
        } else {
            // Normal conversation
            this.description = turns ? `${turns} ${vscode.l10n.t('msgs')} · ${rel}` : rel;

            // Markdown tooltip with metadata
            // Tooltip: summary-only when available, metadata fallback otherwise
            const summaryText = summaryTexts?.get(session.id);
            if (summaryText) {
                const metaParts: string[] = [`**${rawLabel}**`];
                if (session.workspace) { metaParts.push(`📁 ${session.workspace}`); }
                if (turns) { metaParts.push(`💬 ${turns}`); }
                metaParts.push(rel);
                const metaLine = metaParts.join(' · ');
                const preview = summaryText.length > 800
                    ? summaryText.substring(0, 800) + '…'
                    : summaryText;
                this.tooltip = new vscode.MarkdownString(`${metaLine}\n\n---\n\n${preview}`);
            } else {
                this.tooltip = new vscode.MarkdownString([
                    `**${rawLabel}**`,
                    '',
                    `- **${vscode.l10n.t('Workspace')}**: ${session.workspace || vscode.l10n.t('(none)')}`,
                    `- **${vscode.l10n.t('Last modified')}**: ${new Date(session.lastModified).toLocaleString()}`,
                    session.createdAt ? `- **${vscode.l10n.t('Created')}**: ${new Date(session.createdAt).toLocaleString()}` : '',
                    turns !== undefined ? `- **${vscode.l10n.t('Messages')}**: ${turns}` : '',
                    `- **ID**: \`${session.id}\``,
                ].filter(Boolean).join('\n'));
            }

            // Icon: status-based (starred > archived > normal)
            if (isStarred) {
                this.iconPath = new vscode.ThemeIcon('star-full', new vscode.ThemeColor('charts.yellow'));
            } else if (session.archived) {
                this.iconPath = new vscode.ThemeIcon('archive');
            } else {
                this.iconPath = new vscode.ThemeIcon('comment-unresolved');
            }
        }

        this.contextValue = session.stale ? 'sessionStale' : isStarred ? 'sessionStarred' : 'session';

        this.command = {
            command: 'convManager.openSession',
            title: 'Open Session',
            arguments: [session],
        };
    }
}

/**
 * Non-interactive status / empty-state node.
 */
class InfoItem extends vscode.TreeItem {
    constructor(label: string, description: string, icon: string) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.description = description;
        this.iconPath = new vscode.ThemeIcon(icon);
        this.contextValue = 'info';
    }
}
