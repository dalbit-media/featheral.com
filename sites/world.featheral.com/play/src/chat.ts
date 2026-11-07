export const chatCapacity = 1000;
export const chatHistoryLimit = 100;
export const chatMessageLimit = 300;
export const chatProfileChangedEvent = 'featheral-profile-changed';
export const chatProfileSettingsEvent = 'featheral-profile-settings';
export const chatUnreadChangedEvent = 'featheral-chat-unread';
export const chatPresenceChangedEvent = 'featheral-chat-presence';
export const chatVisibilityChangedEvent = 'featheral-chat-visibility';
import type { TitleItem } from './customization.ts';
export interface ChatProfile { id: string; nickname: string; address?: string; title?: TitleItem }
export interface ChatMessage { id: number; author: string; nickname: string; text: string; time: number; title?: TitleItem }
export interface ChatInfo { profile: ChatProfile | null; online: number; capacity: number; connected: boolean; serverTime: number }
export interface ChatSubmission { id: string; text: string; createdAt: number }
export interface ChatRoom { id: string; kind: 'explore' | 'settlement' | 'federation'; name: string; settlement?: string }
export interface ChatSettlement { id: string; name: string; x: number; y: number; population: number; federation: string | null; own: boolean; regionName?: string }
export interface ChatDirectory { rooms: ChatRoom[]; settlements: ChatSettlement[]; ownSettlement: string | null }
export interface RoomChatInfo extends ChatInfo, ChatDirectory { room: ChatRoom }
