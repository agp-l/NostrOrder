// Node tests use the same pinned library versions as the browser's CDN imports.
export async function resolve(specifier, context, nextResolve) {
    const modules = {
        'https://cdn.jsdelivr.net/npm/nostr-tools@2.7.2/+esm': 'nostr-tools',
        'https://cdn.jsdelivr.net/npm/@noble/hashes@1.3.0/utils/+esm': '@noble/hashes/utils'
    };
    return nextResolve(modules[specifier] || specifier, context);
}
