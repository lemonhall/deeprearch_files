from __future__ import annotations

import argparse
import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import requests
import re


def load_dotenv(dotenv_path: Path, *, override: bool) -> None:
    if not dotenv_path.exists():
        return

    for raw_line in dotenv_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip().strip("'").strip('"')
        if not k:
            continue
        if override or k not in os.environ:
            os.environ[k] = v


def resolve_dotenv_path(cli_value: str | None) -> Path | None:
    if cli_value:
        return Path(cli_value)

    candidates: list[Path] = []

    # 1) Project-local (CWD)
    candidates.append(Path.cwd() / ".env")

    # 2) Skill-local (repo checkout): <skill_root>/.env
    try:
        skill_root = Path(__file__).resolve().parents[1]
        candidates.append(skill_root / ".env")
    except Exception:
        pass

    # 3) Global skills directory: %USERPROFILE%\.agents\skills\md-to-modern-pptx\.env
    userprofile = os.environ.get("USERPROFILE")
    if userprofile:
        global_root = Path(userprofile) / ".agents" / "skills" / "md-to-modern-pptx"
        # Some installs end up nested (e.g. ...\md-to-modern-pptx\md-to-modern-pptx\.env).
        candidates.append(global_root / "md-to-modern-pptx" / ".env")
        candidates.append(global_root / ".env")

    existing = [c for c in candidates if c.exists()]
    if not existing:
        return None

    # Prefer a dotenv that contains CHERRY_* (new gateway config), if present.
    for c in existing:
        try:
            txt = c.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        if "CHERRY_BASE_URL" in txt or "CHERRY_API_KEY" in txt:
            return c

    return existing[0]

    return None


def strip_md(text: str) -> str:
    return text.replace("**", "").replace("`", "").strip()


def section_between(md: str, start_heading: str, end_heading_or_none: str | None) -> str:
    start = md.find(start_heading)
    if start < 0:
        return ""
    after = md[start + len(start_heading) :]
    if not end_heading_or_none:
        return after.strip()
    end = after.find(end_heading_or_none)
    if end < 0:
        return after.strip()
    return after[:end].strip()


def normalize_paragraphs(raw: str) -> str:
    lines = []
    for l in raw.splitlines():
        s = l.strip()
        if not s:
            continue
        if s.startswith("生成日期："):
            continue
        lines.append(s)
    return "\n".join(lines)


def parse_detailed_analysis(md: str) -> list[dict[str, str]]:
    raw = section_between(md, "## Detailed Analysis", "## Areas of Consensus")
    if not raw:
        return []
    blocks = [b.strip() for b in re.split(r"(?:^|\r?\n)###\s+", raw) if b.strip()]
    out: list[dict[str, str]] = []
    for b in blocks:
        lines = b.splitlines()
        title = strip_md(lines[0].strip())
        body = strip_md(normalize_paragraphs("\n".join(lines[1:])))
        out.append({"title": title, "body": body})
    return out


def theme_style_hint(theme_slug: str) -> str:
    slug = theme_slug.lower().strip()
    hints: dict[str, str] = {
        "golden-hour": "warm mustard yellow + terracotta + soft beige palette, cozy but premium",
        "tech-innovation": "high-contrast dark gray with electric blue and neon cyan accents, sleek modern",
        "ocean-depths": "deep navy + teal + seafoam palette, clean and trustworthy",
        "modern-minimalist": "neutral grayscale, minimal, lots of whitespace",
        "midnight-galaxy": "dark cosmic palette, subtle glow accents",
    }
    return hints.get(slug, "consistent palette matching the deck theme")


def prompt_template(
    *,
    deck_title: str,
    section_title: str,
    section_body: str,
    theme_slug: str,
) -> str:
    style = theme_style_hint(theme_slug)
    body_hint = section_body[:260].replace("\n", " ")
    return (
        "Create a modern editorial illustration for a presentation slide.\n"
        f"Topic: {deck_title}\n"
        f"Slide focus: {section_title}\n"
        f"Context: {body_hint}\n"
        f"Style: {style}; flat vector / editorial, subtle grain, clean shapes.\n"
        "Composition: subject centered, plenty of negative space around edges, 16:9 friendly.\n"
        "Constraints: no text, no captions, no logos, no watermarks, no brand marks.\n"
        "Quality: crisp, high detail, professional, not cartoonish.\n"
    )


@dataclass(frozen=True)
class PlanItem:
    name: str
    slide_number: int
    prompt: str
    size: str = "16:9"
    resolution: str = "1K"


def make_plan(md_path: Path, theme_slug: str, start_slide: int) -> dict[str, Any]:
    md = md_path.read_text(encoding="utf-8")
    deck_title = (next((l[2:].strip() for l in md.splitlines() if l.startswith("# ")), None) or "Deck").strip()
    analyses = parse_detailed_analysis(md)
    images: list[dict[str, Any]] = []

    for i, a in enumerate(analyses[:5]):
        slide_number = start_slide + i
        images.append(
            {
                "name": f"slide-{slide_number:02d}",
                "slide_number": slide_number,
                "size": "16:9",
                "resolution": "1K",
                "prompt": prompt_template(
                    deck_title=deck_title,
                    section_title=a["title"],
                    section_body=a["body"],
                    theme_slug=theme_slug,
                ),
            }
        )

    return {
        "version": 1,
        "theme": theme_slug,
        "model_hint": "gemini-3-pro-image-preview",
        "images": images,
    }


def _gemini_auth_headers(api_key: str, mode: str) -> dict[str, str]:
    """
    Gateways differ. Support 3 modes:
    - goog:   x-goog-api-key only
    - bearer: Authorization: Bearer only
    - both:   send both + x-api-key
    """
    m = (mode or "").strip().lower()
    headers: dict[str, str] = {
        "accept": "application/json",
        "content-type": "application/json",
    }
    if m == "bearer":
        headers["authorization"] = f"Bearer {api_key}"
        return headers
    if m == "both":
        headers["authorization"] = f"Bearer {api_key}"
        headers["x-goog-api-key"] = api_key
        headers["x-api-key"] = api_key
        return headers

    # default: goog
    headers["x-goog-api-key"] = api_key
    return headers


def _openai_auth_headers(api_key: str) -> dict[str, str]:
    return {
        "accept": "application/json",
        "content-type": "application/json",
        "authorization": f"Bearer {api_key}",
    }

def _pick_env(*names: str) -> str:
    for n in names:
        v = (os.getenv(n) or "").strip()
        if v:
            return v
    return ""


def _is_gemini_model(model: str) -> bool:
    m = (model or "").strip().lower()
    return m.startswith("gemini-") or "gemini" in m


def _download_to(url: str, out_path: Path, api_key: str | None = None) -> None:
    headers = {}
    if api_key:
        headers.update(_openai_auth_headers(api_key))
    with requests.get(url, headers=headers, stream=True, timeout=120) as r:
        r.raise_for_status()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with out_path.open("wb") as f:
            for chunk in r.iter_content(chunk_size=1024 * 256):
                if chunk:
                    f.write(chunk)


def _normalize_base_url(base_url: str) -> str:
    return base_url.rstrip("/")


def _gemini_native_payload(prompt: str, aspect_ratio: str | None, image_size: str | None) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "contents": [{"parts": [{"text": prompt}]}],
    }
    # Match common Gemini image generation shape:
    # generationConfig.responseModalities = ["IMAGE"]
    # generationConfig.imageConfig.{aspectRatio,imageSize}
    payload["generationConfig"] = {
        "responseModalities": ["IMAGE"],
        "imageConfig": {},
    }
    if aspect_ratio:
        payload["generationConfig"]["imageConfig"]["aspectRatio"] = aspect_ratio
    if image_size:
        payload["generationConfig"]["imageConfig"]["imageSize"] = image_size
    return payload


def _extract_inline_image_bytes(resp_json: dict[str, Any]) -> tuple[bytes, str]:
    """
    Parse Gemini generateContent response and return (bytes, mime_type).
    Expected: candidates[0].content.parts[*].inlineData.data (base64)
    """
    candidates = resp_json.get("candidates") or []
    if not isinstance(candidates, list) or not candidates:
        raise RuntimeError("No candidates in response")

    content = (candidates[0] or {}).get("content") or {}
    parts = content.get("parts") or []
    if not isinstance(parts, list) or not parts:
        raise RuntimeError("No content.parts in response")

    for part in parts:
        if not isinstance(part, dict):
            continue
        inline = part.get("inlineData") or part.get("inline_data")
        if not inline or not isinstance(inline, dict):
            continue
        b64 = inline.get("data")
        mime = inline.get("mimeType") or inline.get("mime_type") or "image/png"
        if not b64:
            continue
        import base64

        return (base64.b64decode(b64), str(mime))

    # If the model only returned text, include a short hint.
    text_parts = []
    for part in parts:
        if isinstance(part, dict) and isinstance(part.get("text"), str):
            text_parts.append(part["text"])
    if text_parts:
        preview = " ".join(t.strip() for t in text_parts if t.strip())[:500]
        raise RuntimeError(f"No inlineData image found (text preview: {preview})")

    raise RuntimeError("No inlineData image found in response parts")


def _mime_to_ext(mime: str) -> str:
    m = (mime or "").lower()
    if "jpeg" in m or "jpg" in m:
        return ".jpg"
    if "webp" in m:
        return ".webp"
    return ".png"


def _normalize_gemini_model_path(model: str) -> str:
    """
    Gateways vary. Some expect:
      /v1beta/models/google/<model>:generateContent
    while others accept:
      /v1beta/models/<model>:generateContent

    Accept:
      - gemini-3-pro-image-preview
      - google/gemini-3-pro-image-preview
      - models/google/gemini-3-pro-image-preview
      - models/gemini-3-pro-image-preview
    """
    m = (model or "").strip().lstrip("/")
    if not m:
        return "gemini-3-pro-image-preview"
    if m.startswith("models/"):
        m = m[len("models/") :]
    return m


def _try_to_png(raw: bytes, mime: str, width: int, height: int, *, resize: bool) -> bytes | None:
    """
    Convert image bytes to PNG. Returns None if Pillow is unavailable.
    """
    try:
        from PIL import Image  # type: ignore
    except Exception:
        return None

    import io

    with Image.open(io.BytesIO(raw)) as im:
        im.load()
        if resize and width > 0 and height > 0 and (im.size[0] != width or im.size[1] != height):
            im = im.resize((width, height), Image.LANCZOS)
        out = io.BytesIO()
        im.save(out, format="PNG")
        b = out.getvalue()
        if not b or len(b) < 8 or b[:8] != b"\x89PNG\r\n\x1a\n":
            raise RuntimeError(f"PNG encode failed (source_mime={mime})")
        return b


def generate_one(
    *,
    base_url: str,
    api_key: str,
    model: str,
    prompt: str,
    size: str,
    resolution: str,
    out_path: Path,
    poll_interval_s: float,
    timeout_s: float,
    out_width: int,
    out_height: int,
    no_resize: bool,
) -> None:
    base = _normalize_base_url(base_url)
    auth_mode = (
        _pick_env("GEMINI_AUTH_MODE", "CHERRY_AUTH_MODE")
        or ("both" if _pick_env("CHERRY_API_KEY") else "goog")
    ).strip().lower()

    # Prefer Gemini-native generateContent for Gemini models (works on proxies that mirror Google paths).
    if _is_gemini_model(model):
        model_path = _normalize_gemini_model_path(model)
        model_paths_to_try = [model_path]
        if model_path.startswith("google/"):
            model_paths_to_try.append(model_path[len("google/") :])
        else:
            model_paths_to_try.append(f"google/{model_path}")
        # Deduplicate while preserving order
        seen: set[str] = set()
        model_paths_to_try = [p for p in model_paths_to_try if not (p in seen or seen.add(p))]
        aspect_ratio = None
        if isinstance(size, str) and re.fullmatch(r"\d+\s*:\s*\d+", size.strip()):
            aspect_ratio = size.strip().replace(" ", "")
        image_size = None
        if isinstance(resolution, str) and resolution.strip().upper() in ("1K", "2K", "4K"):
            image_size = resolution.strip().upper()

        native_payload = _gemini_native_payload(prompt, aspect_ratio, image_size)

        last_err: Exception | None = None
        for mp in model_paths_to_try:
            native_url = f"{base}/v1beta/models/{mp}:generateContent"
            for attempt in range(3):
                headers = _gemini_auth_headers(api_key, auth_mode)
                r = requests.post(native_url, headers=headers, json=native_payload, timeout=120)
                if r.status_code in (401, 403) and auth_mode != "both":
                    # Some gateways require Bearer auth; retry once with both.
                    headers2 = _gemini_auth_headers(api_key, "both")
                    r = requests.post(native_url, headers=headers2, json=native_payload, timeout=120)

                if r.status_code < 400:
                    img_bytes, mime = _extract_inline_image_bytes(r.json())

                    png = _try_to_png(
                        img_bytes,
                        mime=mime,
                        width=out_width,
                        height=out_height,
                        resize=(not no_resize),
                    )
                    out_path.parent.mkdir(parents=True, exist_ok=True)
                    if png is not None:
                        out_path.with_suffix(".png").write_bytes(png)
                    else:
                        out_path.with_suffix(_mime_to_ext(mime)).write_bytes(img_bytes)
                    return

                # Retry on transient server / rate errors.
                if r.status_code in (429, 500, 502, 503, 504):
                    last_err = RuntimeError(
                        f"HTTP {r.status_code} POST {native_url}: {(r.text or '')[:800]}"
                    )
                    time.sleep(0.4 * (2**attempt))
                    continue

                if r.status_code == 400 and len(model_paths_to_try) > 1:
                    # Often means "wrong model path variant" on some gateways.
                    last_err = RuntimeError(
                        f"HTTP {r.status_code} POST {native_url}: {(r.text or '')[:800]}"
                    )
                    break

                snippet = (r.text or "")[:2000]
                raise RuntimeError(f"HTTP {r.status_code} POST {native_url}: {snippet}")

        raise last_err or RuntimeError("Gemini request failed after retries")

    # Fallback: OpenAI-like images endpoint for non-Gemini models.
    url = f"{base}/v1/images/generations"
    payload: dict[str, Any] = {"model": model, "prompt": prompt, "n": 1, "response_format": "b64_json"}
    r = requests.post(url, headers=_openai_auth_headers(api_key), json=payload, timeout=120)
    if r.status_code >= 400:
        snippet = (r.text or "")[:2000]
        raise RuntimeError(f"HTTP {r.status_code} POST {url}: {snippet}")
    data = r.json()

    # Common patterns:
    # 1) Task-based gateway: { data: { task_id, status } }
    # 2) OpenAI-like: { data: [ { url } ] } or { data: [ { b64_json } ] }
    # 3) Provider-specific variations.
    def poll_task(task_id: str) -> None:
        task_url = f"{base}/v1/tasks/{task_id}"
        started = time.time()
        while True:
            if time.time() - started > timeout_s:
                raise TimeoutError(f"Task {task_id} timed out after {timeout_s}s")

            tr = requests.get(
                f"{task_url}?language=en",
                headers=_openai_auth_headers(api_key),
                timeout=120,
            )
            tr.raise_for_status()
            td = tr.json()
            status = (td.get("data") or {}).get("status")

            if status in ("success", "succeeded", "completed"):
                result = (td.get("data") or {}).get("result") or {}
                images = result.get("images") or []
                if not images:
                    raise RuntimeError(f"Task {task_id} success but result.images missing")

                first = images[0]
                urls = first.get("url") or first.get("urls") or []
                if not urls:
                    raise RuntimeError(f"Task {task_id} success but url missing")

                _download_to(str(urls[0]), out_path, api_key=None)
                return

            if status in ("failed", "error", "canceled", "cancelled"):
                raise RuntimeError(f"Task {task_id} failed: {td}")

            time.sleep(poll_interval_s)

    if isinstance(data, dict) and isinstance(data.get("data"), dict) and (data["data"].get("task_id") or data["data"].get("id")):
        poll_task(str(data["data"].get("task_id") or data["data"].get("id")))
        return

    if isinstance(data, dict) and isinstance(data.get("data"), list) and data["data"]:
        item = data["data"][0]
        if isinstance(item, dict) and (item.get("task_id") or item.get("id")):
            poll_task(str(item.get("task_id") or item.get("id")))
            return
        if isinstance(item, dict) and item.get("url"):
            _download_to(str(item["url"]), out_path, api_key=None)
            return
        if isinstance(item, dict) and item.get("b64_json"):
            import base64

            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_bytes(base64.b64decode(item["b64_json"]))
            return

    raise RuntimeError(f"Unrecognized response shape: {data}")


def main() -> None:
    p = argparse.ArgumentParser(description="Generate slide images via a Gemini gateway (base_url + key).")
    p.add_argument("--dotenv", default=None, help="Path to .env (optional; auto-detect if omitted)")

    sub = p.add_subparsers(dest="cmd", required=True)

    p_models = sub.add_parser("list-models", help="List available models from the gateway (for debugging)")
    p_models.add_argument("--base-url", default=None, help="Override CHERRY_BASE_URL/GEMINI_BASE_URL")
    p_models.add_argument("--key", default=None, help="Override CHERRY_API_KEY/GEMINI_API_KEY")
    p_models.add_argument("--contains", default=None, help="Only print model ids containing this substring")

    p_plan = sub.add_parser("make-plan", help="Create an images plan JSON from a Deep Research markdown")
    p_plan.add_argument("--in", dest="md_in", required=True, help="Input markdown file")
    p_plan.add_argument("--theme", default="golden-hour", help="Theme slug (theme-factory)")
    p_plan.add_argument("--analysis-start-slide", type=int, default=5, help="First analysis slide number (default: 5)")
    p_plan.add_argument("--out", required=True, help="Output plan JSON path")

    p_gen = sub.add_parser("generate", help="Generate images from a plan JSON")
    p_gen.add_argument("--plan", required=True, help="Plan JSON path")
    p_gen.add_argument("--out-dir", default="images", help="Output directory (default: images/)")
    p_gen.add_argument("--base-url", default=None, help="Override CHERRY_BASE_URL/GEMINI_BASE_URL")
    p_gen.add_argument("--key", default=None, help="Override CHERRY_API_KEY/GEMINI_API_KEY")
    p_gen.add_argument("--model", default=None, help="Override CHERRY_MODEL/GEMINI_MODEL")
    p_gen.add_argument("--poll-interval", type=float, default=1.5)
    p_gen.add_argument("--timeout", type=float, default=180.0)
    p_gen.add_argument("--width", type=int, default=640, help="Output image width (default: 640)")
    p_gen.add_argument("--height", type=int, default=360, help="Output image height (default: 360)")
    p_gen.add_argument("--no-resize", action="store_true", help="Do not resize; keep model output size")
    p_gen.add_argument("--overwrite", action="store_true")

    args = p.parse_args()

    dotenv_path = resolve_dotenv_path(args.dotenv)
    if dotenv_path is not None:
        # Always override so switching gateways only requires editing .env, not restarting the shell.
        load_dotenv(dotenv_path, override=True)

    if args.cmd == "make-plan":
        plan = make_plan(Path(args.md_in), args.theme, args.analysis_start_slide)
        out_path = Path(args.out)
        out_path.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"Wrote plan: {out_path}")
        return

    if args.cmd == "list-models":
        base_url = args.base_url or _pick_env("CHERRY_BASE_URL", "GEMINI_BASE_URL")
        api_key = args.key or _pick_env("CHERRY_API_KEY", "GEMINI_API_KEY")
        if not base_url:
            raise SystemExit("Missing CHERRY_BASE_URL/GEMINI_BASE_URL (set in .env or pass --base-url)")
        if not api_key:
            raise SystemExit("Missing CHERRY_API_KEY/GEMINI_API_KEY (set in .env or pass --key)")

        base = _normalize_base_url(base_url)
        auth_mode = (
            _pick_env("GEMINI_AUTH_MODE", "CHERRY_AUTH_MODE")
            or ("both" if _pick_env("CHERRY_API_KEY") else "goog")
        ).strip().lower()
        r = requests.get(f"{base}/v1/models", headers=_gemini_auth_headers(api_key, auth_mode), timeout=120)
        if r.status_code >= 400:
            snippet = (r.text or "")[:2000]
            raise SystemExit(f"HTTP {r.status_code} GET {base}/v1/models: {snippet}")
        data = r.json()

        ids: list[str] = []
        if isinstance(data, dict) and isinstance(data.get("data"), list):
            for item in data["data"]:
                if isinstance(item, dict) and item.get("id"):
                    ids.append(str(item["id"]))
        elif isinstance(data, dict) and isinstance(data.get("models"), list):
            for item in data["models"]:
                if isinstance(item, dict) and item.get("name"):
                    ids.append(str(item["name"]))

        if args.contains:
            needle = args.contains.lower()
            ids = [i for i in ids if needle in i.lower()]

        for mid in ids:
            print(mid)
        if not ids:
            print("(no models parsed; inspect raw JSON)")
            print(json.dumps(data, ensure_ascii=False, indent=2)[:2000])
        return

    if args.cmd == "generate":
        plan_path = Path(args.plan)
        plan = json.loads(plan_path.read_text(encoding="utf-8"))
        base_url = args.base_url or _pick_env("CHERRY_BASE_URL", "GEMINI_BASE_URL")
        api_key = args.key or _pick_env("CHERRY_API_KEY", "GEMINI_API_KEY")
        model = args.model or _pick_env("CHERRY_MODEL", "GEMINI_MODEL") or "gemini-3-pro-image-preview"

        if not base_url:
            raise SystemExit("Missing CHERRY_BASE_URL/GEMINI_BASE_URL (set in .env or pass --base-url)")
        if not api_key:
            raise SystemExit("Missing CHERRY_API_KEY/GEMINI_API_KEY (set in .env or pass --key)")

        out_dir = Path(args.out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)

        images = plan.get("images") or []
        if not isinstance(images, list) or not images:
            raise SystemExit("Plan has no images[]")

        for i, img in enumerate(images, start=1):
            item = PlanItem(
                name=str(img.get("name") or f"image-{i:02d}"),
                slide_number=int(img.get("slide_number") or 0),
                prompt=str(img.get("prompt") or ""),
                size=str(img.get("size") or "16:9"),
                resolution=str(img.get("resolution") or "1K"),
            )
            if not item.prompt.strip():
                raise SystemExit(f"Plan item {item.name} missing prompt")

            out_path = out_dir / f"{item.name}.png"
            if out_path.exists() and not args.overwrite:
                print(f"[skip] {out_path} exists")
                continue

            print(f"[{i}/{len(images)}] {item.name} (slide {item.slide_number})")
            generate_one(
                base_url=base_url,
                api_key=api_key,
                model=model,
                prompt=item.prompt,
                size=item.size,
                resolution=item.resolution,
                out_path=out_path,
                poll_interval_s=args.poll_interval,
                timeout_s=args.timeout,
                out_width=int(args.width),
                out_height=int(args.height),
                no_resize=bool(args.no_resize),
            )
            print(f"  -> {out_path}")

        print("Done.")
        return


if __name__ == "__main__":
    main()
