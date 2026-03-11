/**
 * Active Token Tracker — monitors the current conversation and shows token usage.
 *
 * Detection strategy:
 *   1. On startup: infer active conversation from lastModified (most recent .pb file)
 *   2. At runtime: fs.watch on conversations/ directory for .pb file changes
 *
 * Token data:
 *   - Fetched via GetCascadeTrajectoryGeneratorMetadata
 *   - Cached to globalState for instant display on next startup
 *   - Refreshed when the active conversation changes
 *
 * Display:
 *   - Status bar item: "$(pulse) 128k tokens · Session Title"
 *   - Click → reveal the conversation in the Tree View
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getAntigravityRoot } from './brainScanner';
import { AntigravityClient } from './apiClient';
import { ConversationInfo } from './types';
import { log } from './logger';

const TOKEN_CACHE_KEY = 'activeTokenCache';

interface TokenCacheEntry {
    conversationId: string;
    /** Input tokens of the most recent LLM call ≈ current context window size */
    contextTokens: number;
    /** Cumulative total (input + output) across all calls */
    totalTokens: number;
    updatedAt: number;
}

export class ActiveTokenTracker implements vscode.Disposable {
    private _statusItem: vscode.StatusBarItem;
    private _watcher: fs.FSWatcher | undefined;
    private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
    private _currentConvId: string | undefined;
    private _disposed = false;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly getApiClient: () => AntigravityClient | undefined,
        private readonly getConversations: () => readonly ConversationInfo[],
    ) {
        this._statusItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left, -100,
        );
        this._statusItem.name = vscode.l10n.t('Active Conversation Tokens');
        this._statusItem.command = 'sessionTrace.revealActive';

        // Instantly infer current conversation from .pb file modification times
        const latestConvId = this._findLatestConversation();
        const cached = this.context.globalState.get<TokenCacheEntry>(TOKEN_CACHE_KEY);

        if (latestConvId) {
            this._currentConvId = latestConvId;
            if (cached && cached.conversationId === latestConvId && cached.contextTokens !== undefined) {
                // Cache matches current conversation — instant display
                this._updateStatusBar(cached.contextTokens, cached.totalTokens, latestConvId);
            } else {
                // Different conversation or no cache — show placeholder, fetch later
                this._statusItem.text = '$(pulse) …';
                this._statusItem.tooltip = vscode.l10n.t('Loading token data…');
                this._statusItem.show();
                // Kick off refresh immediately (apiClient may not be ready yet, but it's async)
                this._refreshTokens(latestConvId);
            }
        }

        // Start watching .pb files immediately — don't wait for loadConversations
        this._startWatcher();
    }

    /**
     * Start tracking: infer current conversation + set up file watcher.
     */
    start(): void {
        // Infer active conversation from lastModified (called after loadConversations)
        const convs = this.getConversations();
        log(`[TokenTracker] start() — ${convs.length} conversations available`);
        if (convs.length > 0) {
            const sorted = [...convs]
                .filter(c => !c.stale)
                .sort((a, b) => b.lastModified - a.lastModified);
            if (sorted.length > 0 && !this._currentConvId) {
                // Only infer if watcher hasn't already detected one
                log(`[TokenTracker] inferred active: ${sorted[0].title || sorted[0].id.substring(0, 8)}`);
                this._setActive(sorted[0].id);
            }
        }
    }

    dispose(): void {
        this._disposed = true;
        this._statusItem.dispose();
        this._watcher?.close();
        if (this._debounceTimer) { clearTimeout(this._debounceTimer); }
    }

    // ====================== Private ======================

    /**
     * Synchronously scan conversations/*.pb to find the most recently modified file.
     * Pure filesystem operation — no API needed, runs in milliseconds.
     */
    private _findLatestConversation(): string | undefined {
        const convDir = path.join(getAntigravityRoot(), 'conversations');
        try {
            if (!fs.existsSync(convDir)) { return undefined; }
            let latestId: string | undefined;
            let latestMtime = 0;
            for (const entry of fs.readdirSync(convDir)) {
                if (!entry.endsWith('.pb')) { continue; }
                try {
                    const stat = fs.statSync(path.join(convDir, entry));
                    if (stat.mtimeMs > latestMtime) {
                        latestMtime = stat.mtimeMs;
                        latestId = entry.replace('.pb', '');
                    }
                } catch { /* skip unreadable files */ }
            }
            return latestId;
        } catch {
            return undefined;
        }
    }

    private _startWatcher(): void {
        const convDir = path.join(getAntigravityRoot(), 'conversations');
        try {
            if (!fs.existsSync(convDir)) { return; }
            this._watcher = fs.watch(convDir, (eventType, filename) => {
                if (!filename || !filename.endsWith('.pb')) { return; }

                // Debounce: .pb files change rapidly during a single response
                if (this._debounceTimer) { clearTimeout(this._debounceTimer); }
                this._debounceTimer = setTimeout(() => {
                    const convId = filename.replace('.pb', '');
                    if (convId !== this._currentConvId) {
                        this._setActive(convId);
                    } else {
                        // Same conversation but new activity — refresh token count
                        this._refreshTokens(convId);
                    }
                }, 3000); // 3s debounce — wait for response to finish
            });
        } catch {
            // Watcher failed — silent fallback to startup inference only
        }
    }

    private _setActive(convId: string): void {
        if (this._disposed) { return; }
        this._currentConvId = convId;

        // Try cached data first for instant display
        // (guard against old cache format missing contextTokens)
        const cached = this.context.globalState.get<TokenCacheEntry>(TOKEN_CACHE_KEY);
        if (cached && cached.conversationId === convId && cached.contextTokens !== undefined) {
            this._updateStatusBar(cached.contextTokens, cached.totalTokens, convId);
        } else {
            this._statusItem.text = '$(pulse) …';
            this._statusItem.tooltip = vscode.l10n.t('Loading token data…');
            this._statusItem.show();
        }

        // Fetch fresh data
        this._refreshTokens(convId);
    }

    private async _refreshTokens(convId: string): Promise<void> {
        const client = this.getApiClient();
        if (!client || !client.isConnected) {
            log(`[TokenTracker] API not available, showing title only`);
            // Still show the conversation title even without token data
            const convTitle = this._getTitle(convId);
            this._statusItem.text = `$(pulse) ${convTitle}`;
            this._statusItem.tooltip = vscode.l10n.t('{0} — token data unavailable (API not connected)', convTitle);
            this._statusItem.show();
            return;
        }

        try {
            const metadata = await client.getTrajectoryMetadata(convId);
            if (this._disposed || convId !== this._currentConvId) { return; }

            let totalInput = 0, totalOutput = 0;
            let lastMainInput = 0;
            let maxInput = 0;
            let mainCallCount = 0;
            let lastMainIdx = -1;

            for (let i = 0; i < metadata.length; i++) {
                const usage = metadata[i].chatModel?.usage;
                if (!usage) { continue; }
                const input = parseInt(usage.inputTokens || '0', 10);
                const output = parseInt(usage.outputTokens || '0', 10);
                totalInput += input;
                totalOutput += output;
                if (input > maxInput) { maxInput = input; }
                // Main conversation calls have large input (full context history)
                // Tool/planning calls are always < 5k; 10k threshold is safe
                if (input > 10_000) {
                    lastMainInput = input;
                    mainCallCount++;
                    lastMainIdx = i;
                }
            }

            const totalTokens = totalInput + totalOutput;
            // Large conversations: use lastMainInput (filters tool calls)
            // Small/new conversations: fall back to maxInput (main call is still the largest)
            const contextTokens = lastMainInput > 0 ? lastMainInput : maxInput;

            log(`[TokenTracker] ${convId.substring(0, 8)}: context=${contextTokens}, total=${totalTokens}, calls=${metadata.length}, mainCalls=${mainCallCount}, lastMain=#${lastMainIdx}`);

            // Cache
            const entry: TokenCacheEntry = {
                conversationId: convId,
                contextTokens, totalTokens,
                updatedAt: Date.now(),
            };
            this.context.globalState.update(TOKEN_CACHE_KEY, entry);

            // Update UI
            this._updateStatusBar(contextTokens, totalTokens, convId);
        } catch (e) {
            log(`[TokenTracker] fetch failed: ${e}`);
            // Show title without token data
            const convTitle = this._getTitle(convId);
            this._statusItem.text = `$(pulse) ${convTitle}`;
            this._statusItem.tooltip = vscode.l10n.t('{0} — failed to load token data', convTitle);
            this._statusItem.show();
        }
    }

    private _updateStatusBar(contextTokens: number, totalTokens: number, convId: string): void {
        if (this._disposed) { return; }

        const formatted = this._formatTokens(contextTokens);
        const convTitle = this._getTitle(convId);

        // Color coding based on context window usage
        // Gemini 2.5 Pro context = 1M, warn at 200k+
        let icon = '$(pulse)';
        if (contextTokens > 500_000) { icon = '$(warning)'; }
        else if (contextTokens > 200_000) { icon = '$(flame)'; }

        this._statusItem.text = `${icon} ${formatted}`;
        this._statusItem.tooltip = new vscode.MarkdownString([
            `**${convTitle}**`,
            '',
            `- ${vscode.l10n.t('Context (est.)')}: **${contextTokens.toLocaleString()}** tokens`,
            `- ${vscode.l10n.t('Cumulative')}: ${totalTokens.toLocaleString()} tokens`,
            `- ${icon === '$(warning)' ? vscode.l10n.t('⚠️ Context window is getting large!') : icon === '$(flame)' ? vscode.l10n.t('🔥 High context usage — consider new window') : vscode.l10n.t('✅ Normal')}`,
            '',
            `_${vscode.l10n.t('Click to reveal in sidebar')}_`,
        ].join('\n'));
        this._statusItem.show();
    }

    private _formatTokens(tokens: number): string {
        if (tokens >= 1_000_000) { return `${(tokens / 1_000_000).toFixed(1)}M`; }
        if (tokens >= 1_000) { return `${Math.round(tokens / 1_000)}k`; }
        return `${tokens}`;
    }

    private _getTitle(convId: string): string {
        const conv = this.getConversations().find(c => c.id === convId);
        return conv?.title || convId.substring(0, 8);
    }
}
