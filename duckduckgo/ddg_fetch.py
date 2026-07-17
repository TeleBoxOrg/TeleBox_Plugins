#!/usr/bin/env python3
"""Fetch DuckDuckGo HTML SERP with Chrome TLS impersonation (curl_cffi).

Stdout: JSON { "ok": bool, "status": int, "blocked": bool, "results": [...] }
Used by duckduckgo.ts — no API key required.
"""
from __future__ import annotations

import json
import re
import sys
from urllib.parse import parse_qs, unquote, urlparse


def strip_html(s: str) -> str:
    s = re.sub(r"<[^>]+>", "", s or "")
    s = (
        s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&nbsp;", " ")
    )
    return re.sub(r"\s+", " ", s).strip()


def decode_uddg(href: str) -> str:
    try:
        if href.startswith("//"):
            href = "https:" + href
        q = parse_qs(urlparse(href).query)
        if "uddg" in q and q["uddg"]:
            return unquote(q["uddg"][0])
        return href
    except Exception:
        return href


def parse_results(html: str, limit: int) -> list[dict]:
    if re.search(r"anomaly-modal|Unfortunately, bots use DuckDuckGo", html, re.I):
        return []
    blocks = re.split(r'class="result results_links', html)
    out: list[dict] = []
    for block in blocks[1:]:
        if len(out) >= limit:
            break
        if "result--ad" in block or "y.js?ad_" in block:
            continue
        m = re.search(
            r'class="result__a"\s+href="([^"]+)"[^>]*>([\s\S]*?)</a>',
            block,
            re.I,
        )
        if not m:
            m = re.search(
                r'href="([^"]+)"[^>]*class="result__a"[^>]*>([\s\S]*?)</a>',
                block,
                re.I,
            )
        if not m:
            continue
        sn = re.search(
            r'class="result__snippet"[^>]*>([\s\S]*?)</(?:a|td|div)',
            block,
            re.I,
        )
        um = re.search(r'class="result__url"[^>]*>([\s\S]*?)</', block, re.I)
        title = strip_html(m.group(2))
        url = decode_uddg(m.group(1))
        if not title or not url:
            continue
        if re.match(r"^https?://duckduckgo\.com/c/", url, re.I):
            continue
        display = strip_html(um.group(1)) if um else ""
        if not display:
            try:
                display = urlparse(url).hostname or ""
                if display.startswith("www."):
                    display = display[4:]
            except Exception:
                display = ""
        out.append(
            {
                "title": title,
                "url": url,
                "snippet": strip_html(sn.group(1)) if sn else "",
                "display": display,
                "source": "ddg-html",
            }
        )
    return out


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "usage: ddg_fetch.py <query> [limit]"}))
        return 2
    query = sys.argv[1]
    limit = 8
    if len(sys.argv) >= 3:
        try:
            limit = max(1, min(15, int(sys.argv[2])))
        except ValueError:
            limit = 8

    try:
        from curl_cffi import requests
    except ImportError:
        import subprocess

        try:
            subprocess.check_call(
                [
                    sys.executable,
                    "-m",
                    "pip",
                    "install",
                    "--user",
                    "-q",
                    "curl_cffi",
                    "--break-system-packages",
                ],
                timeout=180,
            )
            from curl_cffi import requests  # type: ignore
        except Exception as inst_err:
            print(
                json.dumps(
                    {
                        "ok": False,
                        "error": f"curl_cffi install failed: {inst_err}",
                        "results": [],
                    }
                )
            )
            return 1

    try:
        r = requests.get(
            "https://html.duckduckgo.com/html/",
            params={"q": query},
            impersonate="chrome120",
            timeout=25,
            headers={
                "Accept": "text/html,application/xhtml+xml",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            },
        )
        text = r.text or ""
        blocked = r.status_code == 202 or bool(
            re.search(
                r"anomaly-modal|Unfortunately, bots use DuckDuckGo", text, re.I
            )
        )
        results = [] if blocked else parse_results(text, limit)
        print(
            json.dumps(
                {
                    "ok": True,
                    "status": r.status_code,
                    "blocked": blocked,
                    "results": results,
                },
                ensure_ascii=False,
            )
        )
        return 0
    except Exception as e:
        print(
            json.dumps(
                {"ok": False, "error": str(e), "results": [], "blocked": True},
                ensure_ascii=False,
            )
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
