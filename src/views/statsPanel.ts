/**
 * Stats Panel — Diagnostic webview showing conversation statistics.
 *
 * Displays aggregate counts (total, active, stale, summarized, etc.) and
 * lists anomalous conversations for debugging.
 * Supports interactive cleanup of stale conversations via postMessage.
 *
 * Usage:
 *   StatsPanel.show(conversations, summarizedIds, aiConfig, callbacks);
 */

import * as vscode from 'vscode';
import { ConversationInfo } from '../types';

/** AI configuration snapshot for summarizability analysis. */
export interface AiConfigSnapshot {
    minMessages: number;
    cooldownHours: number;
    hasApiKey: boolean;
    hasEndpoint: boolean;
    hasModel: boolean;
}

/** Callbacks from the stats panel to the extension host. */
export interface StatsPanelCallbacks {
    onCleanStale: () => Promise<void>;
}

export class StatsPanel {
    private static readonly viewType = 'convManager.stats';
    private static currentPanel: StatsPanel | undefined;

    private disposed = false;
    private callbacks: StatsPanelCallbacks;

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        callbacks: StatsPanelCallbacks,
    ) {
        this.callbacks = callbacks;

        panel.onDidDispose(() => {
            this.disposed = true;
            StatsPanel.currentPanel = undefined;
        });

        panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.command === 'cleanStale') {
                await this.callbacks.onCleanStale();
            }
        });
    }

    /**
     * Show or refresh the stats panel.
     */
    public static show(
        conversations: readonly ConversationInfo[],
        summarizedIds: Set<string>,
        aiConfig: AiConfigSnapshot,
        callbacks: StatsPanelCallbacks,
    ): void {
        if (StatsPanel.currentPanel && !StatsPanel.currentPanel.disposed) {
            StatsPanel.currentPanel.panel.reveal(vscode.ViewColumn.Two, true);
            StatsPanel.currentPanel.callbacks = callbacks;
            StatsPanel.currentPanel.panel.webview.html = buildHtml(conversations, summarizedIds, aiConfig);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            StatsPanel.viewType,
            'Conversation Stats',
            { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
            { enableScripts: true },
        );

        StatsPanel.currentPanel = new StatsPanel(panel, callbacks);
        panel.webview.html = buildHtml(conversations, summarizedIds, aiConfig);
    }
}

// ====================== HTML Builder ======================

interface UnsummarizableEntry {
    conv: ConversationInfo;
    reason: string;
}

function buildHtml(
    conversations: readonly ConversationInfo[],
    summarizedIds: Set<string>,
    aiConfig: AiConfigSnapshot,
): string {
    const total = conversations.length;
    const active = conversations.filter(c => !c.stale).length;
    const stale = conversations.filter(c => c.stale).length;
    const withWorkspace = conversations.filter(c => c.workspace && !c.stale).length;
    const noWorkspace = conversations.filter(c => !c.workspace && !c.stale).length;
    const withTitle = conversations.filter(c => !c.stale && c.title && !/^[a-f0-9]{8}$/i.test(c.title)).length;
    const withMessages = conversations.filter(c => !c.stale && (c.messageCount ?? 0) > 0).length;
    const summarized = [...summarizedIds].filter(id => conversations.some(c => c.id === id && !c.stale)).length;
    const orphanSummaries = [...summarizedIds].filter(id => !conversations.some(c => c.id === id)).length;

    // Stale conversations list
    const staleList = conversations.filter(c => c.stale);

    // Unsummarizable analysis
    const cooldownMs = aiConfig.cooldownHours * 60 * 60 * 1000;
    const unsummarizable: UnsummarizableEntry[] = [];

    for (const c of conversations) {
        if (summarizedIds.has(c.id)) { continue; }

        let reason: string | null = null;

        if (c.stale) {
            reason = 'Stale (local remnant)';
        } else if (!aiConfig.hasEndpoint || !aiConfig.hasApiKey || !aiConfig.hasModel) {
            reason = 'AI not configured';
        } else if (c.messageCount === undefined) {
            reason = 'Metadata pending';
        } else if (c.messageCount < aiConfig.minMessages) {
            reason = `Too few messages (${c.messageCount} < ${aiConfig.minMessages})`;
        } else if (c.lastModified > Date.now() - cooldownMs) {
            reason = `Recently active (within ${aiConfig.cooldownHours}h)`;
        }

        if (reason) {
            unsummarizable.push({ conv: c, reason });
        }
    }

    const summarizable = total - summarized - unsummarizable.length;

    // ---- Table rows ----

    const staleTableRows = staleList.length > 0
        ? staleList.map(c => `
            <tr>
                <td><code>${c.id.substring(0, 8)}</code></td>
                <td>${escapeHtml(c.title)}</td>
                <td>${c.workspace ? escapeHtml(c.workspace) : '<span class="dim">(none)</span>'}</td>
                <td>${new Date(c.lastModified).toLocaleDateString()}</td>
            </tr>`).join('')
        : '<tr><td colspan="4" class="empty-row">No stale conversations</td></tr>';

    const unsumRows = unsummarizable.length > 0
        ? unsummarizable.map(({ conv: c, reason }) => `
            <tr>
                <td><code>${c.id.substring(0, 8)}</code></td>
                <td>${escapeHtml(c.title)}</td>
                <td>${c.workspace ? escapeHtml(c.workspace) : '<span class="dim">(none)</span>'}</td>
                <td>${c.messageCount !== undefined ? String(c.messageCount) : '<span class="dim">—</span>'}</td>
                <td><span class="reason">${escapeHtml(reason)}</span></td>
            </tr>`).join('')
        : '<tr><td colspan="5" class="empty-row">All conversations are summarizable</td></tr>';

    // ---- AI config status line ----
    const aiStatus = !aiConfig.hasEndpoint ? '❌ Endpoint not set'
        : !aiConfig.hasApiKey ? '❌ API Key not set'
            : !aiConfig.hasModel ? '❌ Model not set'
                : '✅ Configured';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Conversation Stats</title>
<style>
:root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-editor-foreground);
    --border: var(--vscode-widget-border, rgba(127,127,127,0.2));
    --card-bg: var(--vscode-editorWidget-background, rgba(127,127,127,0.06));
    --accent: var(--vscode-textLink-foreground, #4fc1ff);
    --warn: var(--vscode-editorWarning-foreground, #cca700);
    --error: var(--vscode-editorError-foreground, #f14c4c);
    --success: #7ee787;
    --dim: var(--vscode-descriptionForeground, rgba(255,255,255,0.5));
    --font: var(--vscode-font-family, system-ui);
    --font-mono: var(--vscode-editor-font-family, 'Cascadia Code', monospace);
    --btn-bg: var(--vscode-button-background, #0e639c);
    --btn-fg: var(--vscode-button-foreground, #fff);
    --btn-hover: var(--vscode-button-hoverBackground, #1177bb);
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
    font-family: var(--font);
    color: var(--fg);
    background: var(--bg);
    padding: 24px 32px;
    line-height: 1.5;
}
h1 {
    font-size: 22px;
    font-weight: 600;
    margin-bottom: 4px;
}
.subtitle {
    font-size: 13px;
    color: var(--dim);
    margin-bottom: 24px;
}

/* Stats Grid */
.stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 12px;
    margin-bottom: 32px;
}
.stat-card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px 16px;
    text-align: center;
}
.stat-value {
    font-size: 28px;
    font-weight: 700;
    line-height: 1.2;
    font-family: var(--font-mono);
}
.stat-label {
    font-size: 11px;
    color: var(--dim);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-top: 4px;
}
.stat-value.accent { color: var(--accent); }
.stat-value.warn { color: var(--warn); }
.stat-value.error { color: var(--error); }
.stat-value.success { color: var(--success); }

/* Sections */
.section {
    margin-bottom: 28px;
}
.section-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
}
.section-header h2 {
    font-size: 15px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 6px;
}
.section-header h2 .badge {
    font-size: 11px;
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1px 8px;
    font-weight: 400;
}
.section .config-line {
    font-size: 12px;
    color: var(--dim);
    margin-bottom: 10px;
}

/* Buttons */
.btn-danger {
    font-family: var(--font);
    font-size: 12px;
    padding: 4px 12px;
    border-radius: 4px;
    border: 1px solid var(--error);
    background: transparent;
    color: var(--error);
    cursor: pointer;
    transition: all 0.15s;
}
.btn-danger:hover:not(:disabled) {
    background: var(--error);
    color: #fff;
}
.btn-danger:disabled {
    opacity: 0.4;
    cursor: not-allowed;
}

/* Tables */
table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
}
th {
    text-align: left;
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--dim);
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
}
td {
    padding: 6px 10px;
    border-bottom: 1px solid rgba(127,127,127,0.08);
    vertical-align: middle;
}
tr:hover td {
    background: rgba(127,127,127,0.06);
}
code {
    font-family: var(--font-mono);
    font-size: 12px;
    background: rgba(127,127,127,0.12);
    padding: 1px 5px;
    border-radius: 3px;
}
.empty-row {
    color: var(--dim);
    font-style: italic;
    text-align: center;
    padding: 12px;
}
.dim { color: var(--dim); }
.reason {
    font-size: 12px;
    color: var(--warn);
}

/* Bar chart */
.bar-container {
    display: flex;
    height: 8px;
    border-radius: 4px;
    overflow: hidden;
    margin-bottom: 6px;
    background: var(--card-bg);
}
.bar-segment {
    height: 100%;
    transition: width 0.3s ease;
}
.bar-legend {
    display: flex;
    gap: 16px;
    font-size: 11px;
    color: var(--dim);
    flex-wrap: wrap;
}
.bar-legend span::before {
    content: '';
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 2px;
    margin-right: 4px;
    vertical-align: middle;
}
.legend-active::before { background: var(--accent); }
.legend-stale::before { background: var(--error); }
</style>
</head>
<body>
    <h1>📊 Conversation Stats</h1>
    <p class="subtitle">Diagnostic overview · ${new Date().toLocaleString()}</p>

    <!-- Composition bar -->
    <div class="bar-container">
        <div class="bar-segment" style="width: ${pct(active, total)}; background: var(--accent);"></div>
        <div class="bar-segment" style="width: ${pct(stale, total)}; background: var(--error);"></div>
    </div>
    <div class="bar-legend">
        <span class="legend-active">Active ${active}</span>
        <span class="legend-stale">Stale ${stale}</span>
    </div>

    <!-- Stats cards -->
    <div class="stats-grid" style="margin-top: 20px;">
        <div class="stat-card">
            <div class="stat-value">${total}</div>
            <div class="stat-label">Total (local)</div>
        </div>
        <div class="stat-card">
            <div class="stat-value accent">${active}</div>
            <div class="stat-label">Active (API)</div>
        </div>
        <div class="stat-card">
            <div class="stat-value ${stale > 0 ? 'error' : ''}">${stale}</div>
            <div class="stat-label">Stale</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${withWorkspace}</div>
            <div class="stat-label">With Workspace</div>
        </div>
        <div class="stat-card">
            <div class="stat-value ${noWorkspace > 0 ? 'warn' : ''}">${noWorkspace}</div>
            <div class="stat-label">No Workspace</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${withTitle}</div>
            <div class="stat-label">With Title</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${withMessages}</div>
            <div class="stat-label">With Messages</div>
        </div>
        <div class="stat-card">
            <div class="stat-value success">${summarized}</div>
            <div class="stat-label">Summarized</div>
        </div>
        <div class="stat-card">
            <div class="stat-value ${summarizable > 0 ? 'accent' : ''}">${summarizable}</div>
            <div class="stat-label">Summarizable</div>
        </div>
        <div class="stat-card">
            <div class="stat-value ${orphanSummaries > 0 ? 'warn' : ''}">${orphanSummaries}</div>
            <div class="stat-label">Orphan Summaries</div>
        </div>
    </div>

    <!-- Stale conversations -->
    <div class="section">
        <div class="section-header">
            <h2>⚠️ Stale Conversations <span class="badge">${stale}</span></h2>
            <button id="cleanBtn" class="btn-danger" ${stale === 0 ? 'disabled' : ''}>
                🗑️ Clean ${stale} stale
            </button>
        </div>
        <table>
            <thead><tr><th>ID</th><th>Title</th><th>Workspace</th><th>Last Modified</th></tr></thead>
            <tbody>${staleTableRows}</tbody>
        </table>
    </div>

    <!-- Unsummarizable conversations -->
    <div class="section">
        <div class="section-header">
            <h2>🚫 Not Summarizable <span class="badge">${unsummarizable.length}</span></h2>
        </div>
        <p class="config-line">AI: ${aiStatus} · Min messages: ${aiConfig.minMessages} · Cooldown: ${aiConfig.cooldownHours}h</p>
        <table>
            <thead><tr><th>ID</th><th>Title</th><th>Workspace</th><th>Msgs</th><th>Reason</th></tr></thead>
            <tbody>${unsumRows}</tbody>
        </table>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const btn = document.getElementById('cleanBtn');
        btn.addEventListener('click', () => {
            btn.disabled = true;
            btn.textContent = '⏳ Cleaning...';
            vscode.postMessage({ command: 'cleanStale' });
        });
    </script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function pct(value: number, total: number): string {
    if (total === 0) { return '0%'; }
    return `${Math.round((value / total) * 100)}%`;
}
