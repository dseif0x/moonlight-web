"""Run decoder-lab.html in a headless Chrome of its own: no window, no
profile shared with any other Chrome, no MoonlightWeb instance.

    python decoder_lab.py [--clips text-1080p,game-1080p] [--mbps 170] [--timing 200]
                          [--chrome-arg=--use-adapter-luid=<luid>] [--show]

Serves the repository and the corpus (/corpus/ -> %USERPROFILE%\\.mw-bench\\
ultra-corpus) on 127.0.0.1, opens the page per clip over the DevTools
protocol, and prints and writes the results (<corpus>/decoder-lab.json).
Needs `pip install websocket-client`.
"""
import argparse
import functools
import http.server
import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request

import websocket

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
CORPUS = os.path.join(os.path.expanduser("~"), ".mw-bench", "ultra-corpus")
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"


class Handler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        path = path.split("?", 1)[0]
        if path.startswith("/corpus/"):
            return os.path.join(CORPUS, os.path.basename(path))
        return super().translate_path(path)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clips", default="text-1080p,game-1080p,gradient-1080p,checker-1080p,noise-1080p")
    ap.add_argument("--mbps", default="170")
    ap.add_argument("--ref", default="0x10de")
    ap.add_argument("--frames", type=int, default=60)
    ap.add_argument("--timing", type=int, default=200)
    ap.add_argument("--warm", type=int, default=0, help="untimed decodes before each timed one")
    ap.add_argument("--stages", default="", help="time one stage alone: dequant, idwt or pack")
    ap.add_argument("--chrome-arg", action="append", default=[])
    ap.add_argument("--show", action="store_true", help="print each frame's line")
    ap.add_argument("--present", action="store_true", help="check the product's presentation path once")
    ap.add_argument("--power", default="high-performance", help="the adapter asked for: high-performance or low-power")
    # Another machine's Chrome, reached through SSH tunnels: its DevTools port
    # forwarded here (-L), and this server forwarded there (-R) on the same
    # port, so both ends stay on the loopback.
    ap.add_argument("--remote-cdp", type=int, default=0, help="DevTools port of an already running Chrome")
    ap.add_argument("--http-port", type=int, default=0, help="fixed port for the server (remote runs)")
    a = ap.parse_args()

    http_port = a.http_port or free_port()
    server = http.server.ThreadingHTTPServer(
        ("127.0.0.1", http_port), functools.partial(Handler, directory=REPO))
    threading.Thread(target=server.serve_forever, daemon=True).start()

    cdp_port = a.remote_cdp or free_port()
    profile = tempfile.mkdtemp(prefix="mw-pyrowave-lab-")
    chrome = None if a.remote_cdp else subprocess.Popen([
        CHROME, "--headless=new", "--remote-debugging-port=%d" % cdp_port,
        "--user-data-dir=" + profile, "--no-first-run", "--no-default-browser-check",
        "--enable-unsafe-webgpu", "--enable-webgpu-developer-features", "about:blank",
    ] + a.chrome_arg, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    results = []
    try:
        for _ in range(50):
            try:
                targets = json.load(urllib.request.urlopen("http://127.0.0.1:%d/json" % cdp_port))
                page = next(t for t in targets if t["type"] == "page")
                break
            except Exception:
                time.sleep(0.2)
        ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=600, suppress_origin=True)
        ids = iter(range(1, 1 << 30))

        def call(method, **params):
            mid = next(ids)
            ws.send(json.dumps({"id": mid, "method": method, "params": params}))
            while True:
                msg = json.loads(ws.recv())
                if msg.get("id") == mid:
                    return msg.get("result", msg)

        for clip in a.clips.split(","):
            for mbps in a.mbps.split(","):
                url = ("http://127.0.0.1:%d/scripts/bench/ultra/decoder-lab.html?clip=%s&mbps=%s&ref=%s"
                       "&frames=%d&timing=%d&stages=%s&warm=%d&power=%s&present=%d" % (http_port, clip, mbps, a.ref, a.frames, a.timing,
                                                                    a.stages, a.warm, a.power,
                                                                    1 if a.present else 0))
                call("Page.navigate", url=url)
                time.sleep(1)
                r = call("Runtime.evaluate", expression="window.__labResult", awaitPromise=True,
                         returnByValue=True)
                res = r.get("result", {}).get("value") or {"error": json.dumps(r)[:2000]}
                results.append(res)
                if "error" in res:
                    print(clip, mbps, "ERROR", res["error"])
                    continue
                if a.show:
                    for f in res["perFrame"]:
                        print("  ", f)
                g = res.get("gpuMs") or {}
                print("%-15s %4s Mbit/s %-7s %s  max diff Y %d C %d vs oracle (min PSNR %.1f dB), PSNR-Y vs "
                      "source %.2f dB, ready %s, GPU decode p50 %s ms p99 %s ms%s"
                      % (clip, mbps, res.get("stages", ""), res["adapter"], res["maxDiff"], res["maxDiffC"], res["minPsnrVsOracle"],
                         res["meanPsnrVsSource"], res["allReady"],
                         "%.3f" % g["p50"] if g else "-", "%.3f" % g["p99"] if g else "-",
                         " ERRORS %s" % res["errors"] if res["errors"] else ""))
                if res.get("presentMaxDiff") is not None:
                    print("    present path: max RGB diff %d against the oracle's frame" % res["presentMaxDiff"])
    finally:
        if chrome:
            chrome.terminate()
            try:
                chrome.wait(10)
            except subprocess.TimeoutExpired:
                chrome.kill()
        server.shutdown()
        shutil.rmtree(profile, ignore_errors=True)
    with open(os.path.join(CORPUS, "decoder-lab.json"), "w", encoding="utf-8") as f:
        json.dump(results, f, indent=1)


if __name__ == "__main__":
    main()
