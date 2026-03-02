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

export type SortBy = 'date' | 'created' | 'name';

type TreeNode = CategoryItem | SessionItem | InfoItem;

export class SessionTreeProvider implements vscode.TreeDataProvider<TreeNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private _conversations: ConversationInfo[] = [];
    private _sortBy: SortBy = 'date';
    private _filterWorkspace: string | null = null; // null = show all
    private _searchQuery = '';

    get sortBy(): SortBy { return this._sortBy; }
    get filterWorkspace(): string | null { return this._filterWorkspace; }
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

    setSortBy(sort: SortBy): void {
        this._sortBy = sort;
        this._onDidChangeTreeData.fire();
    }

    setFilter(workspace: string | null): void {
        this._filterWorkspace = workspace;
        this._onDidChangeTreeData.fire();
    }

    setSearch(query: string): void {
        this._searchQuery = query;
        this._onDidChangeTreeData.fire();
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
            return this._getRootChildren();
        }
        if (element instanceof CategoryItem) {
            return element.sessions.map(s => new SessionItem(s));
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
                ? 'No matches — try a different search term'
                : this._filterWorkspace !== null
                    ? 'No conversations in this workspace'
                    : 'No conversations found';
            return [new InfoItem(hint, '', 'info')];
        }

        // When filtering to a single workspace, flatten (no grouping)
        if (this._filterWorkspace !== null) {
            return sorted.map(s => new SessionItem(s));
        }

        // Group by workspace
        const grouped = new Map<string, ConversationInfo[]>();
        for (const c of sorted) {
            const key = c.workspace || '(no workspace)';
            if (!grouped.has(key)) { grouped.set(key, []); }
            grouped.get(key)!.push(c);
        }

        const sortedKeys = [...grouped.keys()].sort((a, b) => {
            if (a === '(no workspace)') { return 1; }
            if (b === '(no workspace)') { return -1; }
            return a.localeCompare(b);
        });

        return sortedKeys.map(key => {
            const sessions = grouped.get(key)!;
            const icon = key === '(no workspace)' ? 'globe' : 'folder';
            return new CategoryItem(key, sessions, icon);
        });
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
    }
}

// ====================== Helpers ======================

export function relativeTime(ts: number): string {
    const diff = Date.now() - ts;
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) { return 'just now'; }
    if (minutes < 60) { return `${minutes}m ago`; }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) { return `${hours}h ago`; }
    const days = Math.floor(hours / 24);
    if (days < 30) { return `${days}d ago`; }
    return `${Math.floor(days / 30)}mo ago`;
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
    ) {
        super(`${workspaceKey} (${sessions.length})`, vscode.TreeItemCollapsibleState.Expanded);
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
    constructor(public readonly session: ConversationInfo) {
        const label = session.title || session.id.substring(0, 8);
        super(label, vscode.TreeItemCollapsibleState.None);

        this.id = `session:${session.id}`;

        const rel = relativeTime(session.lastModified);
        const turns = session.messageCount;
        this.description = turns ? `${turns} msgs · ${rel}` : rel;

        // Markdown tooltip with metadata
        this.tooltip = new vscode.MarkdownString([
            `**${label}**`,
            '',
            `- **Workspace**: ${session.workspace || '(none)'}`,
            `- **Last modified**: ${new Date(session.lastModified).toLocaleString()}`,
            session.createdAt ? `- **Created**: ${new Date(session.createdAt).toLocaleString()}` : '',
            turns !== undefined ? `- **Messages**: ${turns}` : '',
            `- **ID**: \`${session.id}\``,
        ].filter(Boolean).join('\n'));

        // Icon color coding by message count
        if (turns !== undefined && turns > 0) {
            this.iconPath = new vscode.ThemeIcon(
                turns > 100 ? 'comment-unresolved' : 'comment',
                turns > 100
                    ? new vscode.ThemeColor('charts.red')
                    : turns > 60
                        ? new vscode.ThemeColor('charts.yellow')
                        : undefined,
            );
        } else {
            this.iconPath = new vscode.ThemeIcon('comment');
        }

        this.contextValue = 'session';

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
