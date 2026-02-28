/**
 * Content Panel — Webview panel for displaying conversation content.
 *
 * Opens in the editor area when a user clicks a conversation in the tree view.
 * Uses a singleton pattern: only one panel exists at a time. Clicking a different
 * conversation updates the existing panel instead of opening a new one.
 *
 * Communication flow:
 *   Extension Host                          Webview
 *   ─────────────                          ───────
 *   show(id) ──► skeleton HTML
 *   apiClient.getConversation(id) ──────►  { type: 'setContent', messages }
 *   error ──────────────────────────────►  { type: 'setError', message }
 */

import * as vscode from 'vscode';
import { ConversationMessage } from '../apiClient';

// ====================== Panel Manager ======================

/**
 * Manages a single webview panel for conversation content display.
 *
 * Usage:
 *   ContentPanel.show(conversationId, title, fetchFn);
 */
export class ContentPanel {
    private static currentPanel: ContentPanel | undefined;
    private static readonly viewType = 'convManager.content';

    private readonly panel: vscode.WebviewPanel;
    private currentConversationId: string | undefined;
    private disposed = false;

    private constructor(panel: vscode.WebviewPanel) {
        this.panel = panel;

        this.panel.onDidDispose(() => {
            this.disposed = true;
            ContentPanel.currentPanel = undefined;
        });
    }

    /**
     * Show conversation content in a webview panel.
     *
     * If a panel already exists, it is revealed and updated with the new conversation.
     * Otherwise, a new panel is created.
     *
     * @param conversationId - UUID of the conversation to display
     * @param title - Display title for the panel tab
     * @param fetchMessages - Async function that fetches conversation messages
     */
    public static async show(
        conversationId: string,
        title: string,
        fetchMessages: (id: string) => Promise<ConversationMessage[] | null>,
    ): Promise<void> {
        // Reuse existing panel if available
        if (ContentPanel.currentPanel && !ContentPanel.currentPanel.disposed) {
            ContentPanel.currentPanel.panel.reveal(vscode.ViewColumn.One, false);

            // Skip reload if already showing this conversation
            if (ContentPanel.currentPanel.currentConversationId === conversationId) {
                return;
            }

            await ContentPanel.currentPanel.loadConversation(conversationId, title, fetchMessages);
            return;
        }

        // Create new panel
        const panel = vscode.window.createWebviewPanel(
            ContentPanel.viewType,
            title,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            },
        );

        ContentPanel.currentPanel = new ContentPanel(panel);
        await ContentPanel.currentPanel.loadConversation(conversationId, title, fetchMessages);
    }

    /**
     * Load a conversation: show skeleton, fetch data, render content.
     */
    private async loadConversation(
        conversationId: string,
        title: string,
        fetchMessages: (id: string) => Promise<ConversationMessage[] | null>,
    ): Promise<void> {
        this.currentConversationId = conversationId;
        this.panel.title = title;

        // Show loading state immediately
        this.panel.webview.html = getLoadingHtml(title);

        try {
            const messages = await fetchMessages(conversationId);

            // Guard: panel may have been disposed or switched to another conversation
            if (this.disposed || this.currentConversationId !== conversationId) {
                return;
            }

            if (!messages || messages.length === 0) {
                this.panel.webview.html = getErrorHtml(
                    title,
                    'No messages found for this conversation.\n\n'
                    + 'The conversation data may be unavailable or the API connection failed.',
                );
                return;
            }

            this.panel.webview.html = getContentHtml(title, messages);
        } catch (e: unknown) {
            if (this.disposed || this.currentConversationId !== conversationId) {
                return;
            }
            const msg = e instanceof Error ? e.message : String(e);
            this.panel.webview.html = getErrorHtml(title, msg);
        }
    }
}

// ====================== HTML Generation ======================

/**
 * Escape HTML special characters to prevent XSS.
 */
function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Convert plain text to basic HTML with line breaks and code block handling.
 *
 * This is intentionally simple — a lightweight alternative to pulling in
 * a full markdown renderer. Handles the most common patterns in AI responses:
 * - Fenced code blocks (```language ... ```)
 * - Inline code (`code`)
 * - Line breaks
 */
function renderMessageText(text: string): string {
    const lines = text.split('\n');
    const result: string[] = [];
    let inCodeBlock = false;
    let codeLanguage = '';
    let codeLines: string[] = [];

    for (const line of lines) {
        if (!inCodeBlock && line.startsWith('```')) {
            inCodeBlock = true;
            codeLanguage = escapeHtml(line.slice(3).trim());
            codeLines = [];
            continue;
        }

        if (inCodeBlock && line.startsWith('```')) {
            inCodeBlock = false;
            const langLabel = codeLanguage
                ? `<span class="code-lang">${codeLanguage}</span>`
                : '';
            result.push(
                `<div class="code-block">${langLabel}<pre><code>${codeLines.join('\n')}</code></pre></div>`,
            );
            continue;
        }

        if (inCodeBlock) {
            codeLines.push(escapeHtml(line));
            continue;
        }

        // Normal line: escape HTML, convert inline code
        let escaped = escapeHtml(line);
        escaped = escaped.replace(/`([^`]+)`/g, '<code>$1</code>');
        result.push(escaped === '' ? '<br>' : `<p>${escaped}</p>`);
    }

    // Flush unclosed code block
    if (inCodeBlock && codeLines.length > 0) {
        const langLabel = codeLanguage
            ? `<span class="code-lang">${codeLanguage}</span>`
            : '';
        result.push(
            `<div class="code-block">${langLabel}<pre><code>${codeLines.join('\n')}</code></pre></div>`,
        );
    }

    return result.join('\n');
}

/**
 * Render a single message bubble.
 */
function renderMessage(msg: ConversationMessage, index: number): string {
    const isUser = msg.role === 'user';
    const roleClass = isUser ? 'user' : 'assistant';
    const roleLabel = isUser ? 'You' : 'Antigravity';
    const roleIcon = isUser ? '👤' : '✦';

    const thinkingHtml = msg.thinking
        ? `<details class="thinking">
               <summary>Thinking process</summary>
               <div class="thinking-content">${renderMessageText(msg.thinking)}</div>
           </details>`
        : '';

    return `
        <div class="message ${roleClass}" style="animation-delay: ${Math.min(index * 0.05, 0.5)}s">
            <div class="message-header">
                <span class="role-icon">${roleIcon}</span>
                <span class="role-label">${roleLabel}</span>
            </div>
            ${thinkingHtml}
            <div class="message-body">${renderMessageText(msg.text)}</div>
        </div>`;
}

// ====================== CSS ======================

/** Shared CSS for all panel states (loading, error, content). */
const BASE_CSS = `
:root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-editor-foreground);
    --border: var(--vscode-panel-border);
    --accent: var(--vscode-button-background);
    --accent-fg: var(--vscode-button-foreground);
    --card-bg: var(--vscode-editor-lineHighlightBackground);
    --text-secondary: var(--vscode-descriptionForeground);
    --link: var(--vscode-textLink-foreground);
    --font: var(--vscode-font-family, 'Segoe UI', sans-serif);
    --font-mono: var(--vscode-editor-font-family, 'Consolas', monospace);
    --font-size: var(--vscode-font-size, 13px);
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
    font-family: var(--font);
    font-size: var(--font-size);
    background: var(--bg);
    color: var(--fg);
    line-height: 1.6;
    padding: 0;
}

.container {
    max-width: 860px;
    margin: 0 auto;
    padding: 24px 32px 64px;
}

/* Header */
.panel-header {
    padding: 16px 0 24px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 24px;
}
.panel-title {
    font-size: 20px;
    font-weight: 600;
    line-height: 1.3;
    word-break: break-word;
}
.panel-meta {
    font-size: 12px;
    color: var(--text-secondary);
    margin-top: 4px;
}

/* Messages */
.message {
    margin-bottom: 20px;
    padding: 16px 20px;
    border-radius: 10px;
    border: 1px solid var(--border);
    animation: fadeIn 0.3s ease-out backwards;
}
.message.user {
    background: rgba(255, 255, 255, 0.03);
    border-left: 3px solid var(--accent);
}
.message.assistant {
    background: var(--card-bg);
}

.message-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    opacity: 0.7;
}
.role-icon { font-size: 14px; }

.message-body p {
    margin-bottom: 6px;
}
.message-body p:last-child {
    margin-bottom: 0;
}

/* Inline code */
code {
    font-family: var(--font-mono);
    font-size: 0.9em;
    background: rgba(255, 255, 255, 0.06);
    padding: 1px 5px;
    border-radius: 3px;
    border: 1px solid rgba(255, 255, 255, 0.08);
}

/* Code blocks */
.code-block {
    position: relative;
    margin: 12px 0;
    border-radius: 8px;
    overflow: hidden;
    border: 1px solid var(--border);
    background: rgba(0, 0, 0, 0.2);
}
.code-lang {
    display: block;
    padding: 6px 14px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    opacity: 0.5;
    border-bottom: 1px solid var(--border);
    background: rgba(255, 255, 255, 0.02);
}
.code-block pre {
    margin: 0;
    padding: 14px;
    overflow-x: auto;
}
.code-block code {
    background: none;
    border: none;
    padding: 0;
    font-size: 12px;
    line-height: 1.5;
}

/* Thinking (collapsible) */
.thinking {
    margin-bottom: 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
}
.thinking summary {
    padding: 8px 12px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    cursor: pointer;
    user-select: none;
    opacity: 0.5;
    transition: opacity 0.2s;
    background: rgba(255, 255, 255, 0.02);
}
.thinking summary:hover { opacity: 0.8; }
.thinking-content {
    padding: 12px;
    font-size: 12px;
    opacity: 0.7;
    border-top: 1px solid var(--border);
    max-height: 400px;
    overflow-y: auto;
}

/* Skeleton animation */
@keyframes shimmer {
    0% { background-position: -200% 0; }
    100% { background-position: 200% 0; }
}
.skeleton {
    background: linear-gradient(90deg,
        rgba(255,255,255,0.04) 25%,
        rgba(255,255,255,0.08) 50%,
        rgba(255,255,255,0.04) 75%);
    background-size: 200% 100%;
    animation: shimmer 1.5s infinite;
    border-radius: 6px;
}

/* Fade-in animation */
@keyframes fadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
}

/* Error state */
.error-container {
    text-align: center;
    padding: 80px 24px;
    animation: fadeIn 0.3s ease-out;
}
.error-icon { font-size: 48px; margin-bottom: 16px; opacity: 0.4; }
.error-title {
    font-size: 16px;
    font-weight: 600;
    margin-bottom: 8px;
}
.error-message {
    font-size: 13px;
    color: var(--text-secondary);
    max-width: 480px;
    margin: 0 auto;
    white-space: pre-wrap;
}

/* Scrollbar */
::-webkit-scrollbar { width: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.15); }
`;

// ====================== HTML Templates ======================

function getLoadingHtml(title: string): string {
    const escapedTitle = escapeHtml(title);

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src 'unsafe-inline';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>${BASE_CSS}</style>
</head>
<body>
    <div class="container">
        <div class="panel-header">
            <div class="panel-title">${escapedTitle}</div>
            <div class="panel-meta">Loading conversation...</div>
        </div>
        ${[1, 2, 3].map((_, i) => `
            <div class="message ${i % 2 === 0 ? 'user' : 'assistant'}" style="opacity: 0.5;">
                <div class="skeleton" style="height: 14px; width: 80px; margin-bottom: 12px;"></div>
                <div class="skeleton" style="height: 14px; width: ${70 + i * 10}%; margin-bottom: 8px;"></div>
                <div class="skeleton" style="height: 14px; width: ${50 + i * 5}%; margin-bottom: 8px;"></div>
                ${i === 1 ? '<div class="skeleton" style="height: 80px; width: 100%; margin-top: 8px;"></div>' : ''}
            </div>
        `).join('')}
    </div>
</body>
</html>`;
}

function getErrorHtml(title: string, errorMessage: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src 'unsafe-inline';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>${BASE_CSS}</style>
</head>
<body>
    <div class="container">
        <div class="panel-header">
            <div class="panel-title">${escapeHtml(title)}</div>
        </div>
        <div class="error-container">
            <div class="error-icon">⚠</div>
            <div class="error-title">Unable to load conversation</div>
            <div class="error-message">${escapeHtml(errorMessage)}</div>
        </div>
    </div>
</body>
</html>`;
}

function getContentHtml(title: string, messages: ConversationMessage[]): string {
    const messagesHtml = messages.map((msg, i) => renderMessage(msg, i)).join('\n');
    const messageCount = messages.length;
    const userCount = messages.filter(m => m.role === 'user').length;
    const assistantCount = messages.filter(m => m.role === 'assistant').length;

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src 'unsafe-inline';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>${BASE_CSS}</style>
</head>
<body>
    <div class="container">
        <div class="panel-header">
            <div class="panel-title">${escapeHtml(title)}</div>
            <div class="panel-meta">${messageCount} messages (${userCount} user, ${assistantCount} assistant)</div>
        </div>
        ${messagesHtml}
    </div>
</body>
</html>`;
}
