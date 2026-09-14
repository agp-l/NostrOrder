// NIP-17 direct-chat validation, after decrypting the signed kind-13 seal.
// Group messages must not be presented as a one-to-one conversation.
export function directChatPartner(rumor, sealPubkey, myPubkey) {
    if (!rumor || rumor.kind !== 14 || rumor.pubkey !== sealPubkey ||
        typeof rumor.content !== 'string' || !Number.isSafeInteger(rumor.created_at) ||
        rumor.created_at < 0 || !Array.isArray(rumor.tags)) return null;
    if (!rumor.tags.every(tag => Array.isArray(tag) && tag.every(value => typeof value === 'string'))) return null;
    const recipients = [...new Set(rumor.tags.filter(tag => tag[0] === 'p').map(tag => tag[1]))];
    if (!recipients.length || recipients.some(key => !/^[a-f0-9]{64}$/.test(key))) return null;
    const participants = new Set([rumor.pubkey, ...recipients]);
    if (!participants.has(myPubkey) || participants.size > 2) return null;
    return rumor.pubkey === myPubkey ? (recipients.find(key => key !== myPubkey) || myPubkey) : rumor.pubkey;
}
