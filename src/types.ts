import * as vscode from 'vscode';

/**
 * Conversation data shown in the tree view.
 */
export interface ConversationInfo {
    id: string;
    title: string;
    workspace?: string;
    branch?: string;
    lastModified: number;
    messageCount?: number;
}
