// Flow F. Provider IDs and phone numbers stay in the family inbox, never in glasses state.
export type MessageContact = { id: string; phone: string; name: string; relation: string; approved: boolean }
export type IncomingMessage = { id: string; providerId: string; from: string; text: string; receivedAt: string; allowedOnArrival: boolean; dismissed: boolean; demo: boolean }
export type MessageReply = { id: string; messageId: string; to: string; text: string; createdAt: string; expiresAt: string; status: 'draft' | 'sending' | 'sent' | 'demo_sent' | 'cancelled' | 'unknown'; providerId?: string }
export type OutgoingMessage = { id: string; providerId: string; to: string; text: string; sentAt: string; kind: 'halo' | 'care' }
export type MessagingData = { contacts: MessageContact[]; messages: IncomingMessage[]; replies: MessageReply[]; outgoing: OutgoingMessage[]; activity: { at: string; text: string; sourceId: string }[] }
export type PatientMessage = { id: string; name: string; relation: string; text: string; demo: boolean }
export type MessageState = { message: PatientMessage | null; reply: Pick<MessageReply, 'id' | 'messageId' | 'text' | 'expiresAt'> | null }
