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
}
