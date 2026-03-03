/**
 * AI Summarizer — Generate conversation summaries via external LLM APIs.
 *
 * Supports two API formats:
 *   - OpenAI: POST {base}/chat/completions with Bearer auth
 *   - Gemini: POST {base}/models/{model}:generateContent with ?key= auth
 *
 * Config is read from VS Code settings (convManager.ai.*).
 * Summaries are persisted in globalState['summaryCache'].
 */

import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { ConversationMessage } from './apiClient';

/** Cached summary entry */
export interface SummaryEntry {
    text: string;
    generatedAt: string;
    /** Message count at the time of summarization (used for staleness detection). */
    messageCount?: number;
}

/** globalState key for summary cache */
const SUMMARY_CACHE_KEY = 'summaryCache';

// ====================== Config Helpers ======================

function getConfig() {
    const cfg = vscode.workspace.getConfiguration('convManager.ai');
    return {
        endpoint: (cfg.get<string>('endpoint') || '').replace(/\/+$/, ''),
        model: cfg.get<string>('model') || '',
        format: cfg.get<string>('format') || 'openai',
        prompt: cfg.get<string>('prompt') || DEFAULT_PROMPT,
    };
}

/**
 * Retrieve API key from VS Code SecretStorage.
 *
 * SecretStorage uses OS-level credential storage (Keychain / DPAPI / libsecret),
 * so the key never appears in settings.json or globalState.
 */
export async function getApiKey(secrets: vscode.SecretStorage): Promise<string> {
    return (await secrets.get('convManager.ai.apiKey')) || '';
}

/** Store API key in SecretStorage. */
export async function setApiKey(secrets: vscode.SecretStorage, key: string): Promise<void> {
    if (key) {
        await secrets.store('convManager.ai.apiKey', key);
    } else {
        await secrets.delete('convManager.ai.apiKey');
    }
}

// ====================== Summary Cache ======================

export function getSummary(state: vscode.Memento, conversationId: string): SummaryEntry | undefined {
    const cache: Record<string, SummaryEntry> = state.get(SUMMARY_CACHE_KEY, {});
    return cache[conversationId];
}

export function setSummary(state: vscode.Memento, conversationId: string, entry: SummaryEntry): void {
    const cache: Record<string, SummaryEntry> = state.get(SUMMARY_CACHE_KEY, {});
    cache[conversationId] = entry;
    state.update(SUMMARY_CACHE_KEY, cache);
}

export function deleteSummary(state: vscode.Memento, conversationId: string): void {
    const cache: Record<string, SummaryEntry> = state.get(SUMMARY_CACHE_KEY, {});
    delete cache[conversationId];
    state.update(SUMMARY_CACHE_KEY, cache);
}

// ====================== API Call ======================

/**
 * Summarize a conversation by calling an external LLM API.
 *
 * @param messages - The conversation messages to summarize
 * @param secrets  - VS Code SecretStorage for API key retrieval
 * @returns The generated summary text
 * @throws Error if config is incomplete or API call fails
 */
export async function summarize(
    messages: ConversationMessage[],
    secrets: vscode.SecretStorage,
): Promise<string> {
    const cfg = getConfig();
    const apiKey = await getApiKey(secrets);

    if (!cfg.endpoint) { throw new Error('请先在设置中配置 AI Endpoint (convManager.ai.endpoint)'); }
    if (!apiKey) { throw new Error('请先设置 API Key (命令面板 → "Conversations: Set AI API Key")'); }
    if (!cfg.model) { throw new Error('请先在设置中配置模型名称 (convManager.ai.model)'); }

    // Build conversation text
    const conversationText = messages
        .map(m => `[${m.role === 'user' ? '用户' : 'AI'}]\n${m.text}`)
        .join('\n\n---\n\n');

    const systemPrompt = cfg.prompt;

    if (cfg.format === 'gemini') {
        return callGemini(cfg.endpoint, apiKey, cfg.model, systemPrompt, conversationText);
    } else {
        return callOpenAI(cfg.endpoint, apiKey, cfg.model, systemPrompt, conversationText);
    }
}

/**
 * Test API connectivity by calling the /models endpoint.
 * Returns a list of available model names on success.
 */
export async function testConnection(secrets: vscode.SecretStorage): Promise<string[]> {
    const cfg = getConfig();
    const apiKey = await getApiKey(secrets);

    if (!cfg.endpoint) { throw new Error('请先配置 Endpoint (convManager.ai.endpoint)'); }
    if (!apiKey) { throw new Error('API Key 未设置'); }

    const base = cfg.endpoint;
    let url: string;
    let headers: Record<string, string> = {};

    if (cfg.format === 'gemini') {
        url = `${base}/models?key=${apiKey}`;
    } else {
        url = `${base}/models`;
        headers = { 'Authorization': `Bearer ${apiKey}` };
    }

    const data = await httpGet(url, headers);
    const result = JSON.parse(data);

    if (cfg.format === 'gemini') {
        return (result.models || []).map((m: any) => (m.name || '').replace('models/', '')).slice(0, 15);
    } else {
        return (result.data || []).map((m: any) => m.id).slice(0, 15);
    }
}

// ====================== API Implementations ======================

async function callOpenAI(
    base: string, apiKey: string, model: string,
    systemPrompt: string, userContent: string,
): Promise<string> {
    const url = `${base}/chat/completions`;
    const body = JSON.stringify({
        model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
        ],
        temperature: 0.3,
    });

    const data = await httpPost(url, body, {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
    });

    const result = JSON.parse(data);
    return result.choices?.[0]?.message?.content || '(AI 未返回内容)';
}

async function callGemini(
    base: string, apiKey: string, model: string,
    systemPrompt: string, userContent: string,
): Promise<string> {
    const url = `${base}/models/${model}:generateContent?key=${apiKey}`;
    const body = JSON.stringify({
        contents: [
            { role: 'user', parts: [{ text: systemPrompt + '\n\n' + userContent }] },
        ],
        generationConfig: { temperature: 0.3 },
    });

    const data = await httpPost(url, body, {
        'Content-Type': 'application/json',
    });

    const result = JSON.parse(data);
    return result.candidates?.[0]?.content?.parts?.[0]?.text || '(AI 未返回内容)';
}

// ====================== HTTP Helper ======================

/**
 * Simple HTTPS/HTTP POST request.
 * Uses Node.js built-in modules (no external dependencies).
 */
function httpPost(url: string, body: string, headers: Record<string, string>): Promise<string> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const mod = parsed.protocol === 'https:' ? https : http;

        const req = mod.request(parsed, {
            method: 'POST',
            headers: {
                ...headers,
                'Content-Length': Buffer.byteLength(body).toString(),
            },
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf-8');
                if (res.statusCode && res.statusCode >= 400) {
                    reject(new Error(`API ${res.statusCode}: ${text.slice(0, 300)}`));
                } else {
                    resolve(text);
                }
            });
        });

        req.on('error', reject);
        req.setTimeout(60000, () => {
            req.destroy(new Error('请求超时 (60s)'));
        });
        req.write(body);
        req.end();
    });
}

/** Simple HTTPS/HTTP GET request. */
function httpGet(url: string, headers: Record<string, string>): Promise<string> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const mod = parsed.protocol === 'https:' ? https : http;

        const req = mod.request(parsed, {
            method: 'GET',
            headers,
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf-8');
                if (res.statusCode && res.statusCode >= 400) {
                    reject(new Error(`API ${res.statusCode}: ${text.slice(0, 300)}`));
                } else {
                    resolve(text);
                }
            });
        });

        req.on('error', reject);
        req.setTimeout(15000, () => {
            req.destroy(new Error('连接超时 (15s)'));
        });
        req.end();
    });
}

// ====================== Default Prompt ======================

const DEFAULT_PROMPT = `你是一个技术会话总结助手。以下是一次 AI 编码助手与用户的对话记录。
请用中文生成结构化总结，包含以下部分：

## 目标
用一句话概括本次对话的核心任务。

## 完成的工作
- 列出所有具体的改动（创建/修改了哪些文件、实现了什么功能、修复了什么问题）
- 每条用一行描述，重点是「做了什么」而非「怎么做的」

## 关键决策
- 列出对话中做出的重要技术选择和取舍（为什么选 A 而不选 B）
- 如果没有明显的决策点，省略此部分

## 发现与踩坑
- 记录对话中发现的重要技术细节、API 行为、意外问题
- 如果没有，省略此部分

## 遗留事项
- 提到但未完成的工作、已知的不足、后续可以改进的方向
- 如果没有，省略此部分

要求：
- 简洁精炼，每个要点一行
- 省略寒暄、重复、调试过程等噪音
- 如果某个部分没有内容，直接省略该部分`;
