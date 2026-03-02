/**
 * Content Panel — Webview panel for displaying conversation content.
 *
 * Opens in the editor area when a user clicks a conversation in the tree view.
 * Uses a singleton pattern: only one panel exists at a time. Clicking a different
 * conversation updates the existing panel instead of opening a new one.
 *
 * Rendering pipeline (all in extension host, Webview receives pre-rendered HTML):
 *   1. marked.js  — full Markdown → HTML (headings, bold, lists, tables, links)
 *   2. Copy button — inline JS injected into Webview for clipboard interaction
 *   3. All styling uses VS Code CSS variables for automatic theme adaptation
 */

import * as vscode from 'vscode';
import { ConversationMessage } from '../apiClient';
import { Marked } from 'marked';


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

// ====================== Markdown Rendering ======================

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
 * Configured marked instance for Markdown → HTML rendering.
 *
 * - Fenced code blocks get a wrapper div with language label (no syntax coloring;
 *   styled via VS Code CSS variables to match the active theme)
 * - All other Markdown features (headings, bold, italic, lists, tables,
 *   links, images, blockquotes) are rendered natively by marked
 */
const marked = new Marked({
    renderer: {
        // Override code block rendering to add language label wrapper
        code({ text, lang }) {
            const langLabel = lang
                ? `<span class="code-lang">${escapeHtml(lang)}</span>`
                : '';
            return `<div class="code-block">${langLabel}<pre><code>${escapeHtml(text)}</code></pre></div>`;
        },

        // Links get a title for hover preview
        link({ href, text }) {
            return `<a href="${href}" title="${escapeHtml(href)}">${text}</a>`;
        },
    },
    gfm: true,     // GitHub Flavored Markdown: tables, strikethrough, etc.
    breaks: true,  // Convert single newlines to <br> (matches AI response style)
});

/**
 * Render Markdown text to HTML using marked.
 */
function renderMessageText(text: string): string {
    return marked.parse(text) as string;
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

/* Markdown content inside message-body */
.message-body p {
    margin-bottom: 8px;
}
.message-body p:last-child {
    margin-bottom: 0;
}
.message-body h1, .message-body h2, .message-body h3,
.message-body h4, .message-body h5, .message-body h6 {
    margin: 16px 0 8px;
    line-height: 1.3;
}
.message-body h1 { font-size: 1.4em; }
.message-body h2 { font-size: 1.25em; }
.message-body h3 { font-size: 1.1em; }
.message-body ul, .message-body ol {
    margin: 8px 0;
    padding-left: 24px;
}
.message-body li {
    margin-bottom: 4px;
}
.message-body blockquote {
    margin: 8px 0;
    padding: 8px 16px;
    border-left: 3px solid var(--accent);
    opacity: 0.85;
    background: rgba(255, 255, 255, 0.02);
    border-radius: 0 6px 6px 0;
}
.message-body table {
    border-collapse: collapse;
    margin: 12px 0;
    width: 100%;
    font-size: 0.92em;
}
.message-body th, .message-body td {
    padding: 6px 12px;
    border: 1px solid var(--border);
    text-align: left;
}
.message-body th {
    background: rgba(255, 255, 255, 0.04);
    font-weight: 600;
}
.message-body hr {
    border: none;
    border-top: 1px solid var(--border);
    margin: 16px 0;
}
.message-body a {
    color: var(--link);
    text-decoration: none;
}
.message-body a:hover {
    text-decoration: underline;
}
.message-body strong { font-weight: 600; }
.message-body em { font-style: italic; }
.message-body del { text-decoration: line-through; opacity: 0.6; }
.message-body img {
    max-width: 100%;
    border-radius: 6px;
    margin: 8px 0;
}

/* Inline code */
code {
    font-family: var(--font-mono);
    font-size: 0.9em;
    background: var(--vscode-textCodeBlock-background, rgba(127, 127, 127, 0.15));
    padding: 1px 5px;
    border-radius: 3px;
}

/* Code blocks — uses VS Code theme variables for automatic dark/light adaptation */
.code-block {
    position: relative;
    margin: 12px 0;
    border-radius: 8px;
    overflow: hidden;
    border: 1px solid var(--border);
    background: var(--vscode-textCodeBlock-background, rgba(127, 127, 127, 0.1));
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
    color: var(--fg);
}

/* Copy button on code blocks */
.copy-btn {
    position: absolute;
    top: 6px;
    right: 6px;
    padding: 4px 8px;
    font-size: 11px;
    font-family: var(--font);
    color: var(--text-secondary);
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid var(--border);
    border-radius: 4px;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.2s, background 0.2s;
    z-index: 2;
}
.code-block:hover .copy-btn { opacity: 1; }
.copy-btn:hover {
    background: rgba(255, 255, 255, 0.12);
    color: var(--fg);
}
.copy-btn.copied {
    color: #7ee787;
    border-color: #7ee787;
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

/** Inline JS for copy-to-clipboard buttons on code blocks. */
const COPY_BUTTON_JS = `
<script>
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.copy-btn');
        if (!btn) return;
        const block = btn.closest('.code-block');
        const code = block?.querySelector('code');
        if (!code) return;
        navigator.clipboard.writeText(code.textContent || '').then(() => {
            btn.textContent = 'Copied!';
            btn.classList.add('copied');
            setTimeout(() => {
                btn.textContent = 'Copy';
                btn.classList.remove('copied');
            }, 2000);
        });
    });

    // Inject copy buttons into all code blocks after DOM load
    document.querySelectorAll('.code-block').forEach(block => {
        if (block.querySelector('.copy-btn')) return;
        const btn = document.createElement('button');
        btn.className = 'copy-btn';
        btn.textContent = 'Copy';
        btn.setAttribute('aria-label', 'Copy code to clipboard');
        block.appendChild(btn);
    });
</script>
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
          content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
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
    ${COPY_BUTTON_JS}
</body>
</html>`;
}
