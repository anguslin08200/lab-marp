# AGENTS.md — Lab Slides for AI agents

Instructions for AI coding agents (Claude Code, Codex CLI, etc.) that create or edit slide decks with this tool, or change the tool itself. Human-oriented guides: `docs/使用說明.md` (usage), `docs/部署說明.md` (deployment).

Reply to the user in the language they use. Slide content language is the user's choice; lab paper presentations have so far been all-English (body, tables, speaker notes).

## What this tool is

- A local Marp workbench: `server.cjs` serves http://127.0.0.1:8766/ (Markdown editor + live preview + PDF/PPTX/HTML export + in-app Codex chat).
- A deck is **one Markdown file**. Its front matter `style:` holds the full theme CSS, so copying the file copies the layout.
- Default lab layout is **CATLab**: `templates/catlab.css` + starter `templates/catlab.md`.

## Workflow A — build or edit a deck from outside the workbench

1. **Before editing**, ask the user to press 儲存 in the workbench if the file is open there. The workbench overwrites the whole file on save; after you finish, tell the user to press 重新載入.
2. Place the deck in its own folder with an `assets/` subfolder:
   ```
   <report-folder>/
   ├─ <Deck>.md
   ├─ <paper>.pdf          (optional: source paper next to the deck)
   └─ assets/              images referenced as assets/<name>.png
   ```
3. Start from an existing deck with the same layout and copy its front matter (`---` … `---`, including `style:`). If none exists, ask the user to create one in the workbench (新建 → CATLab → 儲存), which writes the CATLab CSS into the front matter. `templates/catlab.md` alone has no front matter; its CSS is applied only by the workbench. Do not hand-write theme CSS.
4. Write slides (conventions below), then **render and inspect every changed slide** (next section). Fix overflow, clipping, overlap, unreadable text, and large empty areas before reporting done.

## Rendering check (required after every change)

```powershell
node "<lab-marp>\node_modules\@marp-team\marp-cli\marp-cli.js" "<Deck>.md" --images png --allow-local-files --html -o "<scratch-dir>\s.png"
```

- Run it from the deck's folder so relative `assets/` paths resolve. Output: `s.001.png`, `s.002.png`, …
- Rendering ~25 slides takes under a minute; if it hangs for minutes, kill it and rerun into a fresh empty output folder.
- Look at the PNGs (a contact sheet of downscaled pages is efficient), then zoom into suspicious pages.

## CATLab slide conventions

- `---` separates slides. First `#` heading = the dark-blue title band. Cover slide: `<!-- _class: lead -->`.
- Structure for paper talks: Title → Outline → Introduction → Preliminary → Method/Architecture → Experimental Results → Discussion → Conclusion → Q&A. Put an Outline navigation slide before each section: current section in bold, others as `<span style="color: #a0a7b2">…</span>`. Continuation slides may use `(Cont'd)`.
- Bullets: main item = blue square, sub-item = blue arrow, **max two levels**; main ≈ 28 px, sub ≈ 24 px. No blue question-style subheadings.
- No rounded boxes or colored "cards". Side-by-side content uses a CSS grid of plain bullet columns or ordinary tables.
- Per-slide tweaks go in `<style scoped>`; add a short comment saying why when you change CSS.
- About 8–10 text lines per slide. If it does not fit, split the slide or move detail to speaker notes; do not shrink text below readability.
- Speaker notes: `<!-- Speaker notes | <minutes> minutes. … -->` with sources and the estimated time. Default talk length is about 30 minutes, Q&A extra.
- Paper figures: crop from the PDF (no captions, no translated text), save to `assets/`, and add a source label in a corner, e.g.
  ```html
  <style scoped>section .src { position: absolute; right: 96px; bottom: 16px; margin: 0; font-size: 16px; color: #555; font-weight: 400; }</style>
  <p class="src">Author et al., Figure 4</p>
  ```
  Keep labels at the bottom corner; a top-right label overlaps content under the title band.
- Proposals for the lab (e.g., ZCU102 deployment ideas) must be labeled as proposals, never as measured results.
- Never invent numbers, citations, or results. Every number on a slide should trace to a table/figure/section of the source.

## Cropping figures from a PDF (example)

With PyMuPDF available:

```python
import fitz
d = fitz.open("paper.pdf")
page = d[4]                                  # 0-based page index
rect = fitz.Rect(317, 82, 560, 334)          # PDF points (1/72 in); find by rendering the page first
page.get_pixmap(dpi=300, clip=rect).save("assets/fig4.png")
```

Render whole pages at ~110 dpi first to locate figures (pixel ÷ 1.528 = points), then crop at 300 dpi and check the crop for cut-off labels or leftover caption text.

## Workflow B — the in-app Codex chat

The workbench's own Codex conversation (`codex-bridge.cjs`) runs in a read-only sandbox under `.codex-work/` and must return a **complete revised Markdown** via the response schema; it never runs commands or writes files. Its persistent preferences live in `.codex-work/AGENTS.md` (seeded from `templates/codex-memory.default.md`, max 32 KB, not versioned). Edit that file to change the in-app assistant's defaults; the user must start a 新對話 for changes to apply.

## Changing the tool itself

- Main files: `server.cjs` (HTTP API, render/export), `codex-bridge.cjs`, `attachments.cjs`, `ui/`, `templates/catlab.css`, `themes/*.css`.
- Comment every code change with its purpose.
- New format: add `themes/<id>.css`, then register it in `formats` and `themeFiles` in `server.cjs`.
- Do not edit `templates/catlab.md` or `slides/starter.md` as a side effect of building a deck; they are shared starting points.
- Restart the server after backend changes (it runs hidden on port 8766; stop the process listening on 8766, then run `Start-Lab-Slides.cmd`).
- Checks: `npm run check:images` (CLI render), `npm run check:workbench`, `npm run check:attachments`, `npm run check:selection`; see README for the full list. `scripts/check-codex.cjs` and `scripts/check-model-upload.cjs` consume real Codex usage. Run UX tests against a separate port (`LAB_SLIDES_PORT=8771`) instead of the user's 8766 instance.
- Never commit `node_modules/`, `output/`, logs, or `.codex-work/` (personal memory, uploads, MinerU cache).

## Done checklist

- [ ] Every changed slide rendered and inspected; no overflow, clipping, overlap.
- [ ] Figures cropped cleanly, sources labeled, files in `assets/`.
- [ ] Numbers match the source; proposals labeled as such.
- [ ] User reminded: save in the workbench before external edits, 重新載入 after.
