/**
 * Antigravity API Client — Connect to local Antigravity language_server processes.
 *
 * Antigravity runs one language_server process per VS Code workspace.
 * Each process listens on random HTTPS ports with CSRF token authentication.
 *
 * Discovery flow:
 *   1. Find language_server processes via PowerShell (Get-CimInstance)
 *   2. Extract CSRF token from command line arguments
 *   3. Detect listening ports via netstat
 *   4. Test each port with a Heartbeat request to find the working one
 *   5. Use the working port for API requests
 *
 * Key API methods:
 *   - GetCascadeTrajectory: Fetch full conversation content by ID
 *   - GetAllCascadeTrajectories: List conversations visible to a process
 */

import { execSync } from 'child_process';
import * as https from 'https';
import { log } from './logger';

// ====================== Types ======================

export interface ConnectionInfo {
    port: number;
    csrfToken: string;
}

export interface ConversationMetadata {
    id: string;
    title: string;
    workspace: string | null;
    branch: string | null;
    lastModified: string | null;
}

export interface ConversationMessage {
    role: 'user' | 'assistant';
    text: string;
    thinking?: string;
}

// ====================== Process Detection ======================

const PROCESS_NAME = 'language_server_windows_x64.exe';
const REQUEST_TIMEOUT = 30000;

/**
 * Run a PowerShell command and return stdout.
 * Uses encoded command to handle special characters.
 */
function runPowerShell(command: string): string {
    const encoded = Buffer.from(command, 'utf16le').toString('base64');
    return execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, {
        timeout: 15000,
        encoding: 'utf-8',
    });
}

/**
 * Check if a command line belongs to an Antigravity process.
 */
function isAntigravityProcess(commandLine: string): boolean {
    if (/--app_data_dir\s+antigravity\b/i.test(commandLine)) {
        return true;
    }
    const lower = commandLine.toLowerCase();
    return lower.includes('\\antigravity\\') || lower.includes('/antigravity/');
}

interface DetectedProcess {
    pid: number;
    csrfToken: string;
}

/**
 * Detect running Antigravity language_server processes.
 * Extracts PID and CSRF token from each process's command line.
 */
function detectProcesses(): DetectedProcess[] {
    const psCommand = `Get-CimInstance Win32_Process -Filter "name='${PROCESS_NAME}'" | Select-Object ProcessId,CommandLine | ConvertTo-Json`;

    let stdout: string;
    try {
        stdout = runPowerShell(psCommand);
    } catch {
        return [];
    }

    const trimmed = stdout.trim();
    if (!trimmed) {
        return [];
    }

    let rawData: any;
    try {
        rawData = JSON.parse(trimmed);
    } catch {
        return [];
    }

    const items = Array.isArray(rawData) ? rawData : [rawData];
    const processes: DetectedProcess[] = [];

    for (const item of items) {
        const cmd = item.CommandLine || '';
        if (!isAntigravityProcess(cmd)) {
            continue;
        }
        const tokenMatch = cmd.match(/--csrf_token[=\s]+([a-f0-9-]+)/i);
        if (!tokenMatch?.[1]) {
            continue;
        }
        processes.push({ pid: item.ProcessId, csrfToken: tokenMatch[1] });
    }

    return processes;
}

/**
 * Get listening TCP ports for a given PID via netstat.
 * Returns ports sorted ascending (smallest port first — typically the SSL one).
 */
function getListeningPorts(pid: number): number[] {
    try {
        const stdout = execSync('netstat -ano', { timeout: 5000, encoding: 'utf-8' });
        const ports: number[] = [];
        for (const line of stdout.split('\n')) {
            const trimmed = line.trim();
            if (!/LISTENING/i.test(trimmed)) {
                continue;
            }
            const pidMatch = trimmed.match(/\s+(\d+)$/);
            if (!pidMatch || parseInt(pidMatch[1], 10) !== pid) {
                continue;
            }
            const portMatch = trimmed.match(/(?:127\.0\.0\.1|0\.0\.0\.0|\[::1?])[:.](\d+)/);
            if (portMatch?.[1]) {
                const port = parseInt(portMatch[1], 10);
                if (!ports.includes(port)) {
                    ports.push(port);
                }
            }
        }
        return ports.sort((a, b) => a - b);
    } catch {
        return [];
    }
}

// ====================== API Communication ======================

/**
 * Make an HTTPS request to the Antigravity language_server API.
 */
function apiRequest(port: number, csrfToken: string, method: string, body: object = {}): Promise<any> {
    return new Promise((resolve, reject) => {
        const requestBody = JSON.stringify(body);
        const options: https.RequestOptions = {
            hostname: '127.0.0.1',
            port,
            path: `/exa.language_server_pb.LanguageServerService/${method}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(requestBody),
                'Connect-Protocol-Version': '1',
                'X-Codeium-Csrf-Token': csrfToken,
            },
            rejectUnauthorized: false,
            timeout: REQUEST_TIMEOUT,
        };

        const req = https.request(options, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (d) => chunks.push(d));
            res.on('end', () => {
                const responseBody = Buffer.concat(chunks).toString();
                if (res.statusCode === 200) {
                    try {
                        resolve(JSON.parse(responseBody));
                    } catch {
                        reject(new Error('Failed to parse API response'));
                    }
                } else {
                    reject(new Error(`HTTP ${res.statusCode}`));
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
        req.write(requestBody);
        req.end();
    });
}

/**
 * Test if a port responds to a Heartbeat request.
 */
async function testPort(port: number, csrfToken: string): Promise<boolean> {
    try {
        await apiRequest(port, csrfToken, 'Heartbeat', {
            uuid: '00000000-0000-0000-0000-000000000000',
        });
        return true;
    } catch {
        return false;
    }
}

/**
 * Find the first working port from a list of candidates.
 * SSL typically only works on the smallest port number.
 */
async function findWorkingPort(ports: number[], csrfToken: string): Promise<number | null> {
    for (const port of ports) {
        if (await testPort(port, csrfToken)) {
            return port;
        }
    }
    return null;
}

// ====================== Message Extraction ======================

/**
 * Extract human-readable messages from API trajectory steps.
 *
 * Step types:
 * - CORTEX_STEP_TYPE_USER_INPUT: User message
 * - CORTEX_STEP_TYPE_PLANNER_RESPONSE: AI response + optional thinking
 * - CORTEX_STEP_TYPE_MODEL_RESPONSE: Fallback AI response format
 */
export function extractMessages(steps: any[]): ConversationMessage[] {
    const messages: ConversationMessage[] = [];

    for (const step of steps) {
        let text = '';
        let role: 'user' | 'assistant' = 'user';
        let thinking = '';

        switch (step.type) {
            case 'CORTEX_STEP_TYPE_USER_INPUT': {
                role = 'user';
                const firstItem = step.userInput?.items?.[0];
                if (firstItem) {
                    if (typeof firstItem.text === 'string') {
                        text = firstItem.text;
                    } else if (firstItem.text?.content) {
                        text = firstItem.text.content;
                    }
                }
                if (!text) {
                    text = step.userInput?.userResponse || '';
                }
                break;
            }

            case 'CORTEX_STEP_TYPE_PLANNER_RESPONSE': {
                role = 'assistant';
                text = step.plannerResponse?.response || step.plannerResponse?.modifiedResponse || '';
                thinking = step.plannerResponse?.thinking || '';
                break;
            }

            case 'CORTEX_STEP_TYPE_MODEL_RESPONSE': {
                role = 'assistant';
                if (Array.isArray(step.modelResponse?.content)) {
                    text = step.modelResponse.content
                        .map((c: any) => (typeof c.text === 'string' ? c.text : c.text?.content) || '')
                        .join('\n');
                } else if (step.modelResponse?.text) {
                    text = typeof step.modelResponse.text === 'string'
                        ? step.modelResponse.text
                        : step.modelResponse.text?.content || '';
                }
                break;
            }

            default:
                continue;
        }

        if (!text?.trim()) {
            continue;
        }

        // Merge consecutive messages with the same role (e.g. multiple AI response fragments)
        const last = messages[messages.length - 1];
        if (last && last.role === role) {
            last.text += '\n\n' + text.trim();
            if (thinking) {
                last.thinking = last.thinking
                    ? last.thinking + '\n\n' + thinking.trim()
                    : thinking.trim();
            }
        } else {
            messages.push({
                role,
                text: text.trim(),
                ...(thinking ? { thinking: thinking.trim() } : {}),
            });
        }
    }

    return messages;
}

/**
 * Extract a workspace name from an API workspace object.
 *
 * Tries workspaceFolderAbsoluteUri first (extracts last path segment),
 * falls back to workspaceName or name properties.
 */
function extractWorkspaceName(ws: any): string | null {
    if (ws.workspaceFolderAbsoluteUri) {
        try {
            const decoded = decodeURIComponent(ws.workspaceFolderAbsoluteUri);
            const cleaned = decoded.replace(/^file:\/\/\//, '');
            const segments = cleaned.replace(/\\/g, '/').split('/').filter(Boolean);
            return segments[segments.length - 1] || null;
        } catch {
            // fall through
        }
    }
    return ws.workspaceName || ws.name || null;
}

// ====================== Public API ======================

/**
 * Antigravity API client.
 *
 * Manages connections to local language_server processes and provides
 * methods to fetch conversation data.
 *
 * Usage:
 *   const client = new AntigravityClient();
 *   await client.connect();
 *   const messages = await client.getConversation(id);
 */
export class AntigravityClient {
    private connections: ConnectionInfo[] = [];

    /**
     * Detect Antigravity processes and establish connections.
     * Must be called before any data fetching methods.
     *
     * @returns Number of successfully connected processes
     */
    async connect(): Promise<number> {
        this.connections = [];
        const processes = detectProcesses();

        if (processes.length === 0) {
            return 0;
        }

        for (const proc of processes) {
            const ports = getListeningPorts(proc.pid);
            const port = await findWorkingPort(ports, proc.csrfToken);
            if (port) {
                this.connections.push({ port, csrfToken: proc.csrfToken });
            }
        }

        return this.connections.length;
    }

    /** Whether the client has at least one active connection. */
    get isConnected(): boolean {
        return this.connections.length > 0;
    }

    /**
     * Fetch conversation content by ID.
     * Tries all connections until one succeeds (cross-process fallback).
     *
     * @returns Array of extracted messages, or null if all connections fail
     */
    async getConversation(cascadeId: string): Promise<ConversationMessage[] | null> {
        for (const conn of this.connections) {
            try {
                // Use GetCascadeTrajectorySteps for fuller retrieval
                // (GetCascadeTrajectory truncates steps for large conversations)
                // NOTE: Large conversations may still be truncated — see LEARNINGS.md
                const result = await apiRequest(
                    conn.port, conn.csrfToken,
                    'GetCascadeTrajectorySteps',
                    { cascadeId, startIndex: 0, endIndex: 10000 },
                );
                const steps = result.steps || [];
                const messages = extractMessages(steps);
                log(`getConversation ${cascadeId.slice(0, 8)}: ${steps.length} steps → ${messages.length} msgs`);
                return messages;
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                log(`getConversation ${cascadeId.slice(0, 8)} failed on port ${conn.port}: ${msg}`);
            }
        }
        log(`getConversation ${cascadeId.slice(0, 8)}: all connections failed`);
        return null;
    }

    /**
     * Fetch conversation metadata (title, workspace, branch) from all connected processes.
     * Returns a merged map (union across all processes).
     */
    async getConversationList(): Promise<Map<string, ConversationMetadata>> {
        const metadata = new Map<string, ConversationMetadata>();

        for (const conn of this.connections) {
            try {
                const raw = await apiRequest(
                    conn.port, conn.csrfToken,
                    'GetAllCascadeTrajectories', {}
                );
                const summaries = raw.trajectorySummaries;
                let list: any[] = [];

                if (Array.isArray(summaries)) {
                    list = summaries;
                } else if (summaries && typeof summaries === 'object') {
                    list = Object.entries(summaries).map(([key, value]: [string, any]) => ({
                        ...value, cascadeId: key,
                    }));
                }
                if (list.length === 0 && raw.cascadeTrajectories) {
                    list = raw.cascadeTrajectories;
                }

                for (const item of list) {
                    const id = item.cascadeId || item.id;
                    if (!id || metadata.has(id)) {
                        continue;
                    }

                    let workspace: string | null = null;
                    let branch: string | null = null;

                    if (item.workspaces?.length > 0) {
                        const ws = item.workspaces[0];
                        branch = ws.branchName || null;
                        workspace = extractWorkspaceName(ws);
                    }

                    metadata.set(id, {
                        id,
                        title: item.summary || item.name || item.title || '',
                        workspace,
                        branch,
                        lastModified: item.lastModifiedTime || null,
                    });
                }
            } catch {
                // Single process failure doesn't block the whole list
            }
        }

        return metadata;
    }

    /**
     * Fetch metadata details for a single conversation via GetCascadeTrajectory.
     * Extracts workspace name, creation timestamp, and message count from trajectory.
     *
     * Used for deep enrichment when GetAllCascadeTrajectories didn't cover this conversation.
     *
     * @returns Object with workspace, createdAt, and messageCount, or null if API failed entirely
     */
    async getConversationDetails(cascadeId: string): Promise<{
        workspace: string | null;
        createdAt: number | null;
        messageCount: number;
    } | null> {
        for (const conn of this.connections) {
            try {
                const result = await apiRequest(
                    conn.port, conn.csrfToken,
                    'GetCascadeTrajectory', { cascadeId },
                );
                const meta = result.trajectory?.metadata;

                let workspace: string | null = null;
                if (meta?.workspaces?.length > 0) {
                    workspace = extractWorkspaceName(meta.workspaces[0]);
                }

                let createdAt: number | null = null;
                if (meta?.createdAt) {
                    const ts = new Date(meta.createdAt).getTime();
                    if (!isNaN(ts)) {
                        createdAt = ts;
                    }
                }

                // Count messages from steps (zero extra cost — data already in response)
                const steps = result.trajectory?.steps || [];
                const messageCount = extractMessages(steps).length;

                return { workspace, createdAt, messageCount };
            } catch {
                // Try next connection
            }
        }
        return null;
    }

    /**
     * Fetch token usage metadata for a conversation.
     * Each item in the returned array represents a single LLM API call
     * with token counts, model info, and timing data.
     *
     * @returns Array of raw metadata items, or empty array on failure
     */
    async getTrajectoryMetadata(cascadeId: string): Promise<any[]> {
        for (const conn of this.connections) {
            try {
                const result = await apiRequest(
                    conn.port, conn.csrfToken,
                    'GetCascadeTrajectoryGeneratorMetadata', { cascadeId },
                );
                return result.generatorMetadata || [];
            } catch {
                // Try next connection
            }
        }
        return [];
    }

    /** Reset all connections. */
    disconnect(): void {
        this.connections = [];
    }
}
