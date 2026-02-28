import * as vscode from 'vscode';
import { ConversationInfo } from '../types';

type TreeItem = WorkspaceItem | SessionItem;

/**
 * Tree data provider for the conversation list in Activity Bar.
 *
 * Structure:
 *   ▸ workspace-name (count)
 *     ├ conversation-title
 *     ├ conversation-title
 *   ▸ (no workspace) (count)
 *     ├ conversation-title
 */
export class SessionTreeProvider implements vscode.TreeDataProvider<TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private conversations: ConversationInfo[] = [];

    refresh(): void {
        // TODO: reload from brain scanner
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: TreeItem): Promise<TreeItem[]> {
        if (!element) {
            // Root level: group by workspace
            return this.getRootItems();
        }

        if (element instanceof WorkspaceItem) {
            // Under a workspace: list its conversations
            return element.conversations.map(c => new SessionItem(c));
        }

        return [];
    }

    /**
     * Build workspace groups from conversation list.
     */
    private getRootItems(): WorkspaceItem[] {
        const groups = new Map<string, ConversationInfo[]>();

        for (const conv of this.conversations) {
            const ws = conv.workspace || '(no workspace)';
            if (!groups.has(ws)) {
                groups.set(ws, []);
            }
            groups.get(ws)!.push(conv);
        }

        // Sort: named workspaces first, then "(no workspace)"
        const sorted = [...groups.entries()].sort(([a], [b]) => {
            if (a === '(no workspace)') { return 1; }
            if (b === '(no workspace)') { return -1; }
            return a.localeCompare(b);
        });

        return sorted.map(
            ([name, convs]) => new WorkspaceItem(name, convs)
        );
    }

    /**
     * Update the conversation list and refresh the view.
     */
    setConversations(conversations: ConversationInfo[]): void {
        this.conversations = conversations;
        this._onDidChangeTreeData.fire();
    }
}

/**
 * A workspace group node in the tree.
 */
class WorkspaceItem extends vscode.TreeItem {
    constructor(
        public readonly workspaceName: string,
        public readonly conversations: ConversationInfo[],
    ) {
        super(workspaceName, vscode.TreeItemCollapsibleState.Expanded);
        this.description = `${conversations.length}`;
        this.iconPath = new vscode.ThemeIcon('folder');
        this.contextValue = 'workspace';
    }
}

/**
 * A single conversation node in the tree.
 */
class SessionItem extends vscode.TreeItem {
    constructor(public readonly conversation: ConversationInfo) {
        super(
            conversation.title || conversation.id.substring(0, 8),
            vscode.TreeItemCollapsibleState.None,
        );

        this.description = new Date(conversation.lastModified).toLocaleDateString();
        this.iconPath = new vscode.ThemeIcon('comment-discussion');
        this.contextValue = 'session';

        // Click to open content panel
        this.command = {
            command: 'convManager.openSession',
            title: 'Open Session',
            arguments: [this],
        };
    }
}
