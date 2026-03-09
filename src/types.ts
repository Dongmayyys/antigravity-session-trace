/**
 * Conversation metadata displayed in the sidebar and content panel.
 */
export interface ConversationInfo {
    id: string;
    title: string;
    workspace?: string;
    branch?: string;
    /** File mtime from local brain/ or conversations/ directory (epoch ms). */
    lastModified: number;
    /** Creation timestamp from API metadata (epoch ms). */
    createdAt?: number;
    messageCount?: number;
    /**
     * True when the conversation exists locally but is NOT returned by
     * GetAllCascadeTrajectories — i.e. Antigravity no longer displays it.
     * Only set when the API is connected; unset when offline to avoid false positives.
     */
    stale?: boolean;
    /** True when conversation messages contain an archive keyword (e.g. @[/close]). */
    archived?: boolean;
}
