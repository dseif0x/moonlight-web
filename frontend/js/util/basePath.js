/**
 * Where this frontend is mounted — games-operator serves it below a path
 * prefix (`/play`) behind its own reverse proxy, upstream serves it at the
 * root. Derived from this module's own URL, so no build step and no server
 * substitution is involved: `/play/js/util/basePath.js` → `/play`, and
 * `/js/util/basePath.js` → ``.
 *
 * Every root-absolute URL the application builds goes through url(), and the
 * rest of index.html is relative to the document, which is only ever loaded
 * at the mount point itself.
 */
export const BASE = (() => {
    try {
        const p = new URL('../..', import.meta.url).pathname;
        return p.replace(/\/$/, '');
    } catch {
        return '';
    }
})();

/** Mount-aware URL for a root-absolute path such as `/api/hosts`. */
export function url(path) {
    if (!BASE) return path;
    return path.startsWith('/') ? BASE + path : path;
}

/** True when this frontend is served by games-operator (a mount below the root). */
export function isEmbedded() {
    return BASE !== '';
}
