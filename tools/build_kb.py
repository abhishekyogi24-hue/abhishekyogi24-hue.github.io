#!/usr/bin/env python3
"""
Abhi AI knowledge-base build pipeline.

Extracts text from every source (site HTML, resume PDF, hand-curated
core.md, and any manually-provided kb/sources/*.md files like
experience-in-detail.md or linkedin-profile.md), chunks it on heading/
paragraph boundaries, and writes static JSON artifacts the Cloudflare
Worker (and a client-side fallback) retrieve from at request time.

Run: python3 tools/build_kb.py
Output: kb/kb-index.json, kb/kb-lite.json, kb/kb-meta.json, tools/out/kb-report.md
"""
import datetime
import hashlib
import json
import re
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KB_DIR = ROOT / "kb"
SOURCES_DIR = KB_DIR / "sources"
OUT_DIR = ROOT / "tools" / "out"

# Approx tokens via chars/4 (no real tokenizer dependency needed at this scale).
def approx_tokens(text):
    return max(1, len(text) // 4)


CHUNK_MIN_TOKENS = 15
CHUNK_TARGET_TOKENS = 550
CHUNK_MAX_TOKENS = 900

# Tag names whose text content should never be indexed.
SKIP_TAGS = {"script", "style", "nav", "footer", "svg"}
# HTML pages to extract as the "site" source. v2/index.html is deliberately
# excluded — it's a restyle of the same content and would double-count.
SITE_PAGES = {
    "index.html": "/",
    "experience.html": "/experience.html",
    "resume.html": "/resume.html",
    "project.html": "/project.html",
    "skills.html": "/skills.html",
    "contact.html": "/contact.html",
}
BASE_URL = "https://abhishekyogi.in"


class SiteHTMLExtractor(HTMLParser):
    """Walks a page's <main> content, tracking heading hierarchy and
    emitting (heading_path, text_block) pairs split at h2/h3/h4 boundaries
    and at <details class="case-details"> / <article> boundaries."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.skip_depth = 0
        self.in_main = False
        self.main_depth = 0
        self.heading_stack = []  # list of (level, text)
        self.current_level = None
        self.buffer = []
        self.blocks = []  # list of (heading_path, text)
        self.capturing_heading = False
        self.current_id = None
        self.id_stack = []

    def handle_starttag(self, tag, attrs):
        attrs_d = dict(attrs)
        if tag == "main":
            self.in_main = True
            self.main_depth = 1
            return
        if self.in_main:
            self.main_depth += 1
        if tag in SKIP_TAGS:
            self.skip_depth += 1
            return
        if self.skip_depth:
            return
        if tag in ("h2", "h3", "h4"):
            self._flush_buffer()
            self.capturing_heading = True
            self.current_level = int(tag[1])
        if tag == "details" and "case-details" in attrs_d.get("class", ""):
            self._flush_buffer()

    def handle_endtag(self, tag):
        if tag == "main":
            self.in_main = False
            self._flush_buffer()
            return
        if self.in_main:
            self.main_depth -= 1
        if tag in SKIP_TAGS:
            if self.skip_depth:
                self.skip_depth -= 1
            return
        if self.skip_depth:
            return
        if tag in ("h2", "h3", "h4"):
            self.capturing_heading = False
        if tag in ("p", "li", "div", "summary") :
            self.buffer.append(" ")

    def handle_data(self, data):
        if not self.in_main or self.skip_depth:
            return
        text = data.strip()
        if not text:
            return
        if self.capturing_heading:
            level = self.current_level
            # pop any heading of same or deeper level
            while self.heading_stack and self.heading_stack[-1][0] >= level:
                self.heading_stack.pop()
            self.heading_stack.append((level, text))
        else:
            self.buffer.append(text)

    def _flush_buffer(self):
        text = re.sub(r"\s+", " ", " ".join(self.buffer)).strip()
        self.buffer = []
        if text:
            path = " › ".join(h[1] for h in self.heading_stack)
            self.blocks.append((path, text))


def extract_site_page(html_path, url_path):
    html = html_path.read_text(encoding="utf-8")
    parser = SiteHTMLExtractor()
    parser.feed(html)
    return parser.blocks, url_path


def extract_pdf(pdf_path):
    try:
        from pypdf import PdfReader
    except ImportError:
        return None
    reader = PdfReader(str(pdf_path))
    text = "\n".join(page.extract_text() or "" for page in reader.pages)
    return text


def split_markdown_sections(md_text):
    """Split a markdown file into (heading_path, text) blocks on # / ## / ### headings."""
    lines = md_text.splitlines()
    stack = []  # (level, title)
    blocks = []
    buf = []

    def flush():
        text = "\n".join(buf).strip()
        buf.clear()
        if text:
            path = " › ".join(t for _, t in stack)
            blocks.append((path, text))

    for line in lines:
        m = re.match(r"^(#{1,4})\s+(.*)", line)
        if m:
            flush()
            level = len(m.group(1))
            title = m.group(2).strip()
            while stack and stack[-1][0] >= level:
                stack.pop()
            stack.append((level, title))
        else:
            buf.append(line)
    flush()
    return blocks


def chunk_text(text, max_tokens=CHUNK_MAX_TOKENS, target_tokens=CHUNK_TARGET_TOKENS):
    """Split on sentence boundaries, packing into ~target_tokens chunks,
    never splitting a sentence, never exceeding max_tokens unless a single
    sentence alone is longer (then it stays whole)."""
    sentences = re.split(r"(?<=[.!?])\s+(?=[A-Z0-9])", text)
    chunks = []
    cur = []
    cur_tokens = 0
    for s in sentences:
        st = approx_tokens(s)
        if cur and cur_tokens + st > max_tokens:
            chunks.append(" ".join(cur))
            cur = [s]
            cur_tokens = st
        else:
            cur.append(s)
            cur_tokens += st
            if cur_tokens >= target_tokens:
                chunks.append(" ".join(cur))
                cur = []
                cur_tokens = 0
    if cur:
        chunks.append(" ".join(cur))
    return chunks


def make_chunk(text, heading_path, source, source_url, tier, weight):
    text = text.strip()
    if not text:
        return None
    cid = hashlib.sha1(f"{source}|{heading_path}|{text[:80]}".encode("utf-8")).hexdigest()[:12]
    return {
        "id": cid,
        "text": text,
        "headingPath": heading_path,
        "source": source,
        "sourceUrl": source_url,
        "tier": tier,
        "weight": weight,
        "tokens": approx_tokens(text),
    }


NUMERIC_RE = re.compile(
    r"(\$[\d,.]+[KMk]?\+?|\₹[\d,.]+\s*(?:Cr|cr|lakh)?|\d{1,3}%(?:→\d{1,3}%)?|\d+\+?\s*(?:SDEs|QAs|designers|analysts))"
)


def collect_numeric_claims(chunks):
    claims = {}
    for c in chunks:
        for m in NUMERIC_RE.finditer(c["text"]):
            val = m.group(0)
            # crude context window around the number for grouping
            start = max(0, m.start() - 40)
            context = c["text"][start:m.start()].strip()[-40:]
            key = context.lower()
            claims.setdefault(key, []).append((val, c["source"], c["id"]))
    conflicts = {k: v for k, v in claims.items() if len({x[0] for x in v}) > 1}
    return conflicts


def main():
    all_chunks = []

    # 1. core.md — canonical, tier "canonical", weight 1.25
    core_path = SOURCES_DIR / "core.md"
    if core_path.exists():
        for heading_path, text in split_markdown_sections(core_path.read_text(encoding="utf-8")):
            for piece in chunk_text(text):
                c = make_chunk(piece, heading_path, "core", None, "canonical", 1.25)
                if c:
                    all_chunks.append(c)

    # 2. Site HTML pages — tier "authoritative", weight 1.0
    for filename, url_path in SITE_PAGES.items():
        p = ROOT / filename
        if not p.exists():
            continue
        blocks, _ = extract_site_page(p, url_path)
        for heading_path, text in blocks:
            for piece in chunk_text(text):
                url = BASE_URL + url_path
                c = make_chunk(piece, heading_path, "site", url, "authoritative", 1.0)
                if c:
                    all_chunks.append(c)

    # 3. Resume PDF — tier "authoritative", weight 1.0
    pdf_path = ROOT / "Abhishek_Yogi_Resume.pdf"
    if pdf_path.exists():
        text = extract_pdf(pdf_path)
        if text:
            for piece in chunk_text(re.sub(r"\s+", " ", text)):
                c = make_chunk(piece, "Resume", "resume", None, "authoritative", 1.0)
                if c:
                    all_chunks.append(c)

    # 4. Optional manually-provided sources — tier depends on source
    optional_sources = [
        ("experience-in-detail.md", "gdoc", "authoritative", 1.0),
        ("linkedin-profile.md", "linkedin", "supporting", 0.8),
        ("pm-interview-prep.md", "pm-prep", "supporting", 0.8),
        ("github.md", "github", "supporting", 0.8),
    ]
    missing_optional = []
    for filename, source, tier, weight in optional_sources:
        p = SOURCES_DIR / filename
        if not p.exists():
            missing_optional.append(filename)
            continue
        for heading_path, text in split_markdown_sections(p.read_text(encoding="utf-8")):
            for piece in chunk_text(text):
                c = make_chunk(piece, heading_path, source, None, tier, weight)
                if c:
                    all_chunks.append(c)

    # Drop chunks that are too small to be useful on their own (merge into
    # nothing here — at this scale, just drop noise fragments under the floor).
    all_chunks = [c for c in all_chunks if c["tokens"] >= CHUNK_MIN_TOKENS or c["tier"] == "canonical"]

    # kb-lite.json: top ~35 chunks by weight then length, for the client-side
    # no-Worker fallback. Deterministic, not random.
    lite_chunks = sorted(all_chunks, key=lambda c: (-c["weight"], -c["tokens"]))[:35]

    kb_index_path = KB_DIR / "kb-index.json"
    kb_lite_path = KB_DIR / "kb-lite.json"
    kb_meta_path = KB_DIR / "kb-meta.json"

    by_source = {}
    for c in all_chunks:
        by_source[c["source"]] = by_source.get(c["source"], 0) + 1

    version = hashlib.sha1(json.dumps(all_chunks, sort_keys=True).encode("utf-8")).hexdigest()[:10]
    built_at = datetime.datetime.now(datetime.timezone.utc).isoformat()

    meta = {
        "version": version,
        "builtAt": built_at,
        "chunkCount": len(all_chunks),
        "liteChunkCount": len(lite_chunks),
        "sources": by_source,
    }
    kb_meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    # version/builtAt duplicated into kb-index.json itself so the Worker's
    # single fetch of kb-index.json carries freshness info too.
    kb_index_path.write_text(
        json.dumps({"version": version, "builtAt": built_at, "chunks": all_chunks}, ensure_ascii=False),
        encoding="utf-8",
    )
    kb_lite_path.write_text(
        json.dumps({"version": version, "builtAt": built_at, "chunks": lite_chunks}, ensure_ascii=False),
        encoding="utf-8",
    )

    # Review report
    conflicts = collect_numeric_claims(all_chunks)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    report_path = OUT_DIR / "kb-report.md"
    lines = [
        "# Abhi AI knowledge-base build report",
        "",
        f"Built at: {meta['builtAt']}",
        f"Total chunks: {meta['chunkCount']} (lite fallback: {meta['liteChunkCount']})",
        "",
        "## Chunks by source",
    ]
    for src, count in sorted(by_source.items()):
        lines.append(f"- {src}: {count} chunks")

    lines.append("")
    lines.append("## Missing optional sources (not yet provided, skipped cleanly)")
    if missing_optional:
        for f in missing_optional:
            lines.append(f"- kb/sources/{f}")
    else:
        lines.append("- (none — all optional sources present)")

    lines.append("")
    lines.append("## Numeric-claim conflicts (same context, different values across sources)")
    if conflicts:
        for ctx, entries in conflicts.items():
            lines.append(f"- \"...{ctx}\": " + ", ".join(f"{v} ({s}/{cid})" for v, s, cid in entries))
    else:
        lines.append("- none detected")

    lines.append("")
    lines.append("## Every chunk (for manual review before first commit)")
    for c in all_chunks:
        lines.append(f"\n### [{c['source']}/{c['tier']}] {c['headingPath'] or '(no heading)'}  \n`{c['id']}` · {c['tokens']} tok\n\n{c['text']}")

    report_path.write_text("\n".join(lines), encoding="utf-8")

    print(f"Wrote {kb_index_path} ({len(all_chunks)} chunks)")
    print(f"Wrote {kb_lite_path} ({len(lite_chunks)} chunks)")
    print(f"Wrote {kb_meta_path}")
    print(f"Wrote {report_path}")
    if missing_optional:
        print("\nMissing optional sources (skipped): " + ", ".join(missing_optional))
    if conflicts:
        print(f"\n⚠ {len(conflicts)} numeric conflict(s) found — see report.")


if __name__ == "__main__":
    main()
