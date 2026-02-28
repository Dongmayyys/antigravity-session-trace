/**
 * Sidebar View Provider — Webview-based conversation browser in the Activity Bar.
 *
 * Replaces the native TreeView with a full HTML sidebar that supports:
 *   - Workspace-grouped conversation list
 *   - Click to open conversation in ContentPanel
 *   - Sort toggle (recent / created)
 *   - Visual badges and time-colored timestamps
 *
 * Communication: extension host ←→ webview via postMessage.
 *
 * Messages FROM extension → webview:
 *   { type: 'setConversations', conversations: ConversationInfo[] }
 *
 * Messages FROM webview → extension:
 *   { type: 'openSession', id: string }
 *   { type: 'refresh' }
 */

import * as vscode from 'vscode';
import { ConversationInfo } from '../types';

export class SidebarViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewId = 'convManager.sessions';

    private _view?: vscode.WebviewView;
    private _conversations: ConversationInfo[] = [];

    /** Callback invoked when user clicks a conversation. */
    public onOpenSession?: (conversation: ConversationInfo) => void;

    /** Callback invoked when user requests a refresh. */
    public onRefresh?: () => void;

    constructor(private readonly _extensionUri: vscode.Uri) { }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = this._getHtml();

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage((msg) => {
            switch (msg.type) {
                case 'openSession': {
                    const conv = this._conversations.find(c => c.id === msg.id);
                    if (conv && this.onOpenSession) {
                        this.onOpenSession(conv);
                    }
                    break;
                }
                case 'refresh':
                    if (this.onRefresh) {
                        this.onRefresh();
                    }
                    break;
            }
        });

        // Push current data if we already have it
        if (this._conversations.length > 0) {
            this._postConversations();
        }
    }

    /**
     * Update the conversation list and push to webview.
     */
    setConversations(conversations: ConversationInfo[]): void {
        this._conversations = conversations;
        this._postConversations();
    }

    private _postConversations(): void {
        this._view?.webview.postMessage({
            type: 'setConversations',
            conversations: this._conversations,
        });
    }

    // ====================== HTML ======================

    private _getHtml(): string {
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
${SIDEBAR_CSS}
</style>
</head>
<body>
    <div class="toolbar">
        <div class="search-box">
            <span class="search-icon">🔍</span>
            <input type="text" id="searchInput" placeholder="Search conversations...">
        </div>
        <div class="sort-group">
            <button class="sort-btn active" data-sort="lastModified" title="Sort by last modified">Recent</button>
            <button class="sort-btn" data-sort="created" title="Sort by creation time">Created</button>
        </div>
    </div>
    <div class="list-container" id="listContainer">
        <div class="empty-state">Loading...</div>
    </div>
<script>
${SIDEBAR_JS}
</script>
</body>
</html>`;
    }
}

// ====================== CSS ======================

const SIDEBAR_CSS = /* css */ `
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    height: 100vh;
}

/* Toolbar */
.toolbar {
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex-shrink: 0;
    border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
}
.search-box {
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px;
    padding: 3px 8px;
}
.search-box:focus-within {
    border-color: var(--vscode-focusBorder);
}
.search-icon {
    font-size: 11px;
    opacity: 0.6;
}
.search-box input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    color: var(--vscode-input-foreground);
    font-family: inherit;
    font-size: 12px;
}
.search-box input::placeholder {
    color: var(--vscode-input-placeholderForeground);
}
.sort-group {
    display: flex;
    gap: 1px;
    background: var(--vscode-sideBarSectionHeader-border);
    border-radius: 4px;
    overflow: hidden;
}
.sort-btn {
    flex: 1;
    padding: 3px 0;
    font-size: 11px;
    font-family: inherit;
    background: var(--vscode-sideBar-background);
    color: var(--vscode-descriptionForeground);
    border: none;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
}
.sort-btn:hover {
    background: var(--vscode-list-hoverBackground);
}
.sort-btn.active {
    background: var(--vscode-button-secondaryBackground, var(--vscode-list-activeSelectionBackground));
    color: var(--vscode-button-secondaryForeground, var(--vscode-list-activeSelectionForeground));
    font-weight: 500;
}

/* List */
.list-container {
    flex: 1;
    overflow-y: auto;
}
.list-container::-webkit-scrollbar { width: 4px; }
.list-container::-webkit-scrollbar-thumb {
    background: var(--vscode-scrollbarSlider-background);
    border-radius: 4px;
}
.list-container::-webkit-scrollbar-thumb:hover {
    background: var(--vscode-scrollbarSlider-hoverBackground);
}

/* Workspace group */
.ws-group {
    margin-bottom: 2px;
}
.ws-header {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    color: var(--vscode-sideBarSectionHeader-foreground);
    background: var(--vscode-sideBarSectionHeader-background);
    cursor: pointer;
    user-select: none;
    position: sticky;
    top: 0;
    z-index: 1;
}
.ws-header:hover {
    background: var(--vscode-list-hoverBackground);
}
.ws-chevron {
    font-size: 9px;
    transition: transform 0.15s;
    display: inline-block;
    width: 12px;
    text-align: center;
}
.ws-group.collapsed .ws-chevron {
    transform: rotate(-90deg);
}
.ws-group.collapsed .ws-items {
    display: none;
}
.ws-count {
    margin-left: auto;
    font-size: 10px;
    font-weight: 400;
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    padding: 0 5px;
    border-radius: 8px;
    min-width: 16px;
    text-align: center;
}

/* Conversation item */
.conv-item {
    padding: 6px 10px 6px 20px;
    cursor: pointer;
    border-left: 2px solid transparent;
    transition: background 0.1s;
}
.conv-item:hover {
    background: var(--vscode-list-hoverBackground);
}
.conv-item.active {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
    border-left-color: var(--vscode-focusBorder);
}
.conv-title {
    font-size: 12px;
    line-height: 1.4;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.conv-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    margin-top: 2px;
}
.conv-time {
    margin-left: auto;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
}

/* Empty state */
.empty-state {
    padding: 30px 16px;
    text-align: center;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
}

/* Match highlight */
mark {
    background: var(--vscode-editor-findMatchHighlightBackground, rgba(255,200,0,0.3));
    color: inherit;
    border-radius: 2px;
}
`;

// ====================== JavaScript ======================

const SIDEBAR_JS = /* js */ `
(function() {
    const vscode = acquireVsCodeApi();
    let conversations = [];
    let sortMode = 'lastModified';
    let searchQuery = '';
    let selectedId = null;
    let collapsedWs = {};
    let debounceTimer = null;

    // ---- Helpers ----
    function escHtml(s) {
        if (!s) return '';
        return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function highlight(text, q) {
        if (!q || !text) return escHtml(text);
        const escaped = q.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
        return escHtml(text).replace(
            new RegExp('(' + escaped + ')', 'gi'),
            '<mark>$1</mark>'
        );
    }

    function relTime(ts) {
        if (!ts) return '';
        const diff = Date.now() - ts;
        const h = diff / 3600000;
        if (h < 1) return 'just now';
        if (h < 24) return Math.floor(h) + 'h';
        const d = Math.floor(h / 24);
        if (d < 7) return d + 'd';
        if (d < 30) return Math.floor(d / 7) + 'w';
        return Math.floor(d / 30) + 'mo';
    }

    function timeColor(ts) {
        if (!ts) return 'inherit';
        const h = (Date.now() - ts) / 3600000;
        if (h < 1)   return 'var(--vscode-charts-green, #3fb950)';
        if (h < 24)  return 'var(--vscode-charts-blue, #58a6ff)';
        if (h < 168) return 'var(--vscode-charts-purple, #bc8cff)';
        return 'inherit';
    }

    // ---- Filter & Sort ----
    function getFiltered() {
        let list = conversations;
        if (searchQuery) {
            const q = searchQuery.toLowerCase();
            list = list.filter(c =>
                (c.title || '').toLowerCase().includes(q) ||
                (c.workspace || '').toLowerCase().includes(q) ||
                c.id.toLowerCase().includes(q)
            );
        }
        const sorted = [...list];
        sorted.sort((a, b) => {
            if (sortMode === 'lastModified') return b.lastModified - a.lastModified;
            // createdAt falls back to lastModified
            return (b.createdAt || b.lastModified) - (a.createdAt || a.lastModified);
        });
        return sorted;
    }

    // ---- Render ----
    function render() {
        const container = document.getElementById('listContainer');
        const filtered = getFiltered();
        if (!filtered.length) {
            container.innerHTML = '<div class="empty-state">'
                + (conversations.length === 0 ? 'No conversations found' : 'No matches')
                + '</div>';
            return;
        }

        // Group by workspace
        const groups = new Map();
        for (const c of filtered) {
            const ws = c.workspace || '(no workspace)';
            if (!groups.has(ws)) groups.set(ws, []);
            groups.get(ws).push(c);
        }

        // Sort groups: named first, "(no workspace)" last
        const sortedGroups = [...groups.entries()].sort(([a], [b]) => {
            if (a === '(no workspace)') return 1;
            if (b === '(no workspace)') return -1;
            return a.localeCompare(b);
        });

        let html = '';
        for (const [ws, convs] of sortedGroups) {
            const collapsed = collapsedWs[ws] ? ' collapsed' : '';
            html += '<div class="ws-group' + collapsed + '" data-ws="' + escHtml(ws) + '">';
            html += '<div class="ws-header" data-toggle-ws="' + escHtml(ws) + '">'
                + '<span class="ws-chevron">▼</span>'
                + '<span>' + escHtml(ws) + '</span>'
                + '<span class="ws-count">' + convs.length + '</span>'
                + '</div>';
            html += '<div class="ws-items">';
            for (const c of convs) {
                const active = c.id === selectedId ? ' active' : '';
                const title = searchQuery
                    ? highlight(c.title || c.id.substring(0, 8), searchQuery)
                    : escHtml(c.title || c.id.substring(0, 8));
                html += '<div class="conv-item' + active + '" data-id="' + c.id + '">'
                    + '<div class="conv-title">' + title + '</div>'
                    + '<div class="conv-meta">'
                    + '<span class="conv-time" style="color:' + timeColor(c.lastModified) + '">'
                    + relTime(c.lastModified)
                    + '</span>'
                    + '</div>'
                    + '</div>';
            }
            html += '</div></div>';
        }
        container.innerHTML = html;
    }

    // ---- Events ----
    document.getElementById('searchInput').addEventListener('input', (e) => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            searchQuery = e.target.value.trim();
            render();
        }, 150);
    });

    document.querySelectorAll('.sort-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            sortMode = btn.dataset.sort;
            document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            render();
        });
    });

    document.getElementById('listContainer').addEventListener('click', (e) => {
        // Workspace collapse toggle
        const wsToggle = e.target.closest('[data-toggle-ws]');
        if (wsToggle) {
            const ws = wsToggle.dataset.toggleWs;
            collapsedWs[ws] = !collapsedWs[ws];
            const group = wsToggle.closest('.ws-group');
            if (group) group.classList.toggle('collapsed');
            return;
        }

        // Conversation click
        const item = e.target.closest('.conv-item');
        if (item) {
            selectedId = item.dataset.id;
            document.querySelectorAll('.conv-item').forEach(el => el.classList.remove('active'));
            item.classList.add('active');
            vscode.postMessage({ type: 'openSession', id: selectedId });
        }
    });

    // ---- Message from extension ----
    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg.type === 'setConversations') {
            conversations = msg.conversations;
            render();
        }
    });
})();
`;
