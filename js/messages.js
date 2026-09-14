// Relay echoes carry no delivery state. Keep local retry data when merging them.
export function mergeMessageRecords(previous, incoming) {
    const merged = { ...previous, ...incoming,
        wrapIds: [...new Set([...(previous?.wrapIds || []), ...(incoming.wrapIds || [])])] };
    if (previous?.status === 'sent') merged.status = 'sent';
    if (previous?.selfSynced) merged.selfSynced = true;
    return merged;
}

export function orderedMessages(messages) {
    const unique = new Map();
    messages.forEach(message => unique.set(message.id, mergeMessageRecords(unique.get(message.id), message)));
    return [...unique.values()].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
}
