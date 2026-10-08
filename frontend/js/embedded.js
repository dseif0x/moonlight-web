/**
 * games-operator embedded mode.
 *
 * games-operator (https://github.com/dseif0x/games-operator) mounts this
 * frontend below `/play` behind its hub, which authenticates the browser and
 * marks every forwarded request with a secret the backend trusts (see
 * HttpServer::embeddedTrusted). There is no PIN, no host list and no admin
 * page in this mode: the hub's "Play in browser" button opens
 * `/play/#app=<id>` and this module does the rest —
 *
 *   1. asks the hub for the app, the Moonlight host and a backend token
 *      (POST /api/v1/apps/<id>/play, which also starts the app's pod),
 *   2. makes sure that host exists here, carries a Wolf backend with that
 *      token, and is paired (the Wolf backend answers the PIN by itself),
 *   3. waits until the hub reports the app running, showing its progress
 *      (node waking up, image pulling, Wolf starting),
 *   4. launches the app through the ordinary launch path, so codecs,
 *      resolution, fallbacks and the stream view are exactly upstream's.
 *
 * When the stream ends the page offers to play again or to go back to the
 * hub, which lives at the root of the same host.
 */
import { BackendClient } from './api/BackendClient.js';

const STORAGE_KEY = 'go_app';
const HUB_API = '/api/v1';

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function escapeHtml(s) {
    return String(s).replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
}

export const GamesOperator = {
    /** The MoonlightApp singleton, set by start(). */
    app: null,
    /** games-operator app id from the URL, null outside embedded mode. */
    appId: null,
    /** Last answer of the hub's play endpoint. */
    play: null,
    /** True once a stream was started at least once in this page. */
    streamed: false,
    _csrf: '',
    _overlay: null,
    _watch: null,

    /** Read `#app=<id>` (kept in sessionStorage so a reload still knows). */
    detect() {
        const hash = new URLSearchParams(window.location.hash.slice(1));
        const id = hash.get('app');
        if (id) {
            try {
                sessionStorage.setItem(STORAGE_KEY, id);
            } catch {
                /* private mode */
            }
        }
        let stored = null;
        try {
            stored = sessionStorage.getItem(STORAGE_KEY);
        } catch {
            /* ignore */
        }
        this.appId = id || stored;
        return !!this.appId;
    },

    isActive() {
        return !!this.appId;
    },

    // ── Hub API (same origin, hub session cookie, CSRF header on writes) ──
    async hub(method, path, body) {
        const headers = {};
        if (method !== 'GET') {
            if (!this._csrf) {
                const me = await this.hub('GET', '/auth/me');
                this._csrf = me.csrf || '';
            }
            headers['Content-Type'] = 'application/json';
            headers['X-CSRF-Token'] = this._csrf;
        }
        const resp = await fetch(HUB_API + path, {
            method,
            headers,
            credentials: 'same-origin',
            cache: 'no-store',
            body: body ? JSON.stringify(body) : undefined,
        });
        if (resp.status === 401) {
            // Not logged in to the hub: its login page brings the user back.
            window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname + window.location.hash);
            return new Promise(() => {});
        }
        let data = null;
        try {
            data = await resp.json();
        } catch {
            data = null;
        }
        if (!resp.ok) throw new Error((data && data.error) || `hub: ${resp.status}`);
        return data;
    },

    // ── UI ─────────────────────────────────────────────────────────────
    _ensureOverlay() {
        if (this._overlay) return this._overlay;
        document.body.classList.add('go-embedded');
        const el = document.createElement('div');
        el.id = 'go-overlay';
        el.innerHTML = `
            <div class="go-card">
                <div class="go-spinner"></div>
                <h2 class="go-title"></h2>
                <p class="go-status"></p>
                <p class="go-detail"></p>
                <div class="go-actions"></div>
            </div>`;
        document.body.appendChild(el);
        this._overlay = el;
        return el;
    },

    _show({ title, status, detail = '', spinner = true, actions = [] }) {
        const el = this._ensureOverlay();
        el.querySelector('.go-title').textContent = title || '';
        el.querySelector('.go-status').textContent = status || '';
        el.querySelector('.go-detail').textContent = detail || '';
        el.querySelector('.go-spinner').style.display = spinner ? '' : 'none';
        const box = el.querySelector('.go-actions');
        box.innerHTML = '';
        for (const a of actions) {
            const b = document.createElement('button');
            b.className = 'btn ' + (a.primary ? 'btn-primary' : 'btn-secondary');
            b.textContent = a.label;
            b.addEventListener('click', a.onClick);
            box.appendChild(b);
        }
        el.hidden = false;
    },

    _hide() {
        if (this._overlay) this._overlay.hidden = true;
    },

    _status(status, detail) {
        if (!this._overlay || this._overlay.hidden) return;
        this._overlay.querySelector('.go-status').textContent = status || '';
        this._overlay.querySelector('.go-detail').textContent = detail || '';
    },

    _backToHub() {
        window.location.href = '/';
    },

    _fail(err) {
        console.error('[GO] play failed:', err);
        this._show({
            title: this.play?.app?.name || 'games-operator',
            status: 'Could not start the stream',
            detail: err && err.message ? err.message : String(err),
            spinner: false,
            actions: [
                { label: 'Try again', primary: true, onClick: () => this.start(this.app) },
                { label: 'Back to hub', onClick: () => this._backToHub() },
            ],
        });
    },

    /** The hosts view in embedded mode: what the user sees after a stream. */
    renderEnd(main) {
        if (main) main.innerHTML = '';
        if (!this.streamed) return; // before the first launch the loader is up
        this._show({
            title: this.play?.app?.name || 'games-operator',
            status: 'Stream ended',
            detail: 'The app keeps running for a while; playing again reconnects to it.',
            spinner: false,
            actions: [
                { label: 'Play again', primary: true, onClick: () => this.start(this.app) },
                { label: 'Back to hub', onClick: () => this._backToHub() },
            ],
        });
    },

    // ── The flow ───────────────────────────────────────────────────────
    async start(app) {
        this.app = app;
        this._show({ title: 'games-operator', status: 'Asking the hub…' });
        try {
            const play = await this.hub('POST', `/apps/${encodeURIComponent(this.appId)}/play`, {});
            this.play = play;
            this._show({ title: play.app.name, status: 'Connecting to the Moonlight host…' });

            let host = await this._ensureHost(play);
            await this._ensureBackend(host, play);
            // Setting a Wolf backend pairs the host by itself (ensurePaired);
            // read the host again before deciding whether anything is left.
            host = this._matchHost(await this._hosts(), play) || host;
            await this._ensurePaired(host);
            await this._waitForApp(play);
            const mwApp = await this._findApp(host, play);

            this._status('Starting the stream…');
            this.streamed = true;
            this._watchStream();
            await this.app.launchApp(host, mwApp);
        } catch (err) {
            this._fail(err);
        }
    },

    async _hosts() {
        const data = await BackendClient.getHosts();
        return Array.isArray(data) ? data : data.hosts || [];
    },

    _matchHost(hosts, play) {
        return (
            hosts.find((h) => h.backendApiUrl && h.backendApiUrl === play.backend.api_url) ||
            hosts.find((h) => h.name === play.moonlight_hostname)
        );
    },

    async _ensureHost(play) {
        let host = this._matchHost(await this._hosts(), play);
        if (!host) {
            this._status('Adding the Moonlight host…', play.moonlight_host);
            await BackendClient.addManualHost(play.moonlight_host);
        }
        // The host needs to answer /serverinfo before anything else works.
        for (let i = 0; i < 30; i++) {
            host = this._matchHost(await this._hosts(), play);
            if (host && host.state === 'online') return host;
            this._status('Waiting for the Moonlight host…', host ? host.state : play.moonlight_host);
            await sleep(1000);
        }
        throw new Error('the Moonlight host did not come online');
    },

    async _ensureBackend(host, play) {
        // Set every time: the hub hands out a fresh token per play, and the
        // token is what binds the pairing to the right hub user.
        this._status('Configuring the Wolf backend…');
        await BackendClient.setHostBackend(host.uuid, {
            type: 'wolf',
            apiUrl: play.backend.api_url,
            apiToken: play.backend.api_token,
        });
    },

    async _ensurePaired(host) {
        if (host.pairState === 'paired') return;
        this._status('Pairing with the host…');
        const started = await BackendClient.startPairing(host.uuid);
        if (started.status === 'error') {
            if (/already paired/i.test(started.message || '')) return;
            throw new Error(started.message || 'pairing failed');
        }
        for (let i = 0; i < 60; i++) {
            const r = await BackendClient.confirmPairing(host.uuid);
            if (r.status === 'paired') return;
            if (r.status === 'error') throw new Error(r.message || 'pairing failed');
            await sleep(1000);
        }
        throw new Error('pairing timed out');
    },

    async _waitForApp(play) {
        const id = encodeURIComponent(play.app.id);
        for (;;) {
            const a = await this.hub('GET', `/apps/${id}`);
            const reason = a.state_reason || '';
            switch (a.state) {
                case 'running':
                    return a;
                case 'failed':
                    throw new Error(reason || 'the app failed to start');
                case 'stopping':
                case 'stopped':
                    // Stopped meanwhile (idle stop, another device): start again.
                    await this.hub('POST', `/apps/${id}/start`, {});
                    break;
            }
            this._status('Starting the app…', reason);
            await sleep(2000);
        }
    },

    async _findApp(host, play) {
        for (let i = 0; i < 10; i++) {
            const data = await BackendClient.getAppList(host.uuid);
            const list = Array.isArray(data) ? data : data.apps || [];
            const found = list.find((a) => Number(a.id) === Number(play.app.moonlight_id));
            if (found) return found;
            this._status('Looking for the app on the host…');
            await sleep(1500);
        }
        throw new Error('the app is not in the host\'s list; is the pairing bound to your user?');
    },

    /** Hide the loader once the stream is up; the hosts hook shows the end screen later. */
    _watchStream() {
        if (this._watch) clearInterval(this._watch);
        this._watch = setInterval(() => {
            if (!this.app) return;
            if (this.app.state === 'streaming') {
                this._hide();
                clearInterval(this._watch);
                this._watch = null;
            }
        }, 250);
    },
};
