/**
 * Brain Scanner — Discover conversations from the local brain/ directory.
 *
 * Antigravity stores conversation metadata in ~/.gemini/antigravity/brain/{id}/
 * and encrypted conversation data in ~/.gemini/antigravity/conversations/{id}.pb.
 *
 * This module scans the brain/ directory to build a complete conversation list,
 * extracting titles from markdown files and timestamps from .pb files.
 * No API connection required — works fully offline.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ConversationInfo } from './types';

/** UUID v4 pattern used by Antigravity for conversation IDs. */
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** Files to search for a title, in priority order. */
const TITLE_SOURCE_FILES = ['task.md', 'implementation_plan.md', 'walkthrough.md'];

/** Regex to extract title from markdown: "# Task: Title" or "# Title". */
const TITLE_REGEX = /^#\s*(?:Task:?\s*)?(.+)$/im;

/**
 * Resolve the Antigravity data root directory.
 *
 * On Windows: C:\Users\{user}\.gemini\antigravity\
 * On macOS/Linux: ~/.gemini/antigravity/
 */
export function getAntigravityRoot(): string {
    return path.join(os.homedir(), '.gemini', 'antigravity');
}

/**
 * Try to extract a human-readable title from markdown files inside a brain directory.
 *
 * Searches task.md → implementation_plan.md → walkthrough.md in order,
 * returning the first valid title found, or null if none.
 */
async function extractTitle(brainEntryDir: string): Promise<string | null> {
    for (const file of TITLE_SOURCE_FILES) {
        const filePath = path.join(brainEntryDir, file);
        try {
            await fs.promises.access(filePath);
            const content = await fs.promises.readFile(filePath, 'utf-8');
            const match = content.match(TITLE_REGEX);
            if (match?.[1]) {
                // Remove leading badges like "[Draft]"
                return match[1].trim().replace(/^\[.*?\]\s*/, '');
            }
        } catch {
            // File doesn't exist or can't be read — try next
        }
    }
    return null;
}

/**
 * Scan the local brain/ directory and return a list of discovered conversations.
 *
 * For each UUID subdirectory in brain/:
 * 1. Read timestamps from the corresponding .pb file (preferred) or brain dir itself
 * 2. Extract a title from markdown files (task.md etc.)
 * 3. Fall back to a truncated UUID as the display title
 *
 * @returns Array of ConversationInfo sorted by lastModified (newest first)
 */
export async function scanBrainDirectory(): Promise<ConversationInfo[]> {
    const root = getAntigravityRoot();
    const brainDir = path.join(root, 'brain');
    const convDir = path.join(root, 'conversations');

    if (!fs.existsSync(brainDir)) {
        return [];
    }

    const entries = await fs.promises.readdir(brainDir);

    const jobs = entries.map(async (name): Promise<ConversationInfo | null> => {
        // Only process UUID-named directories
        if (!UUID_PATTERN.test(name)) {
            return null;
        }

        const dirPath = path.join(brainDir, name);
        try {
            const dirStat = await fs.promises.stat(dirPath);
            if (!dirStat.isDirectory()) {
                return null;
            }

            // Timestamps: prefer .pb file (more accurate), fall back to brain dir
            let lastModified = dirStat.mtimeMs;
            const pbPath = path.join(convDir, `${name}.pb`);
            try {
                const pbStat = await fs.promises.stat(pbPath);
                lastModified = pbStat.mtimeMs;
            } catch {
                // .pb file may not exist for some conversations
            }

            // Title: try markdown files, fall back to truncated UUID
            const title = await extractTitle(dirPath) || name.substring(0, 8);

            return {
                id: name,
                title,
                lastModified,
            };
        } catch {
            return null;
        }
    });

    const results = await Promise.all(jobs);

    return results
        .filter((item): item is ConversationInfo => item !== null)
        .sort((a, b) => b.lastModified - a.lastModified);
}
