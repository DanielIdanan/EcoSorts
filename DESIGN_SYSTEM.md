# EcoSort Design System v2 — "Forest & Lichen"

Source of truth: `static/css/style.css` (tokens at the top). Light and dark share every brand and signal token; only surfaces and ink flip.

## Audit of v1 (what was found)

**Components reviewed:** 38 · **Issues found:** 9 · **Score:** 54/100

| Category | v1 | v2 |
|---|---|---|
| Stylesheet size | 2,664 lines | 781 lines |
| Font-size values | 78 literals, 0 tokens | 63 token uses, 12 literals |
| Border radius | 39 literals, 0 tokens | 35 token uses, 15 literals |
| Typefaces | 4 loaded (Plus Jakarta, Inter, IBM Plex Mono, Fraunces); Fraunces never used | 3, all used: Fraunces, Geist, Geist Mono |
| Dark mode | Shop cards in the map list hard-coded cream, unreadable in dark | Every surface themed through tokens |

Priority findings fixed:
1. Decoration competed with function: blobs, film grain, floating chips, hazard-tape loader. Replaced by one ambient light and a hairline progress bar.
2. The mark was the generic recycling triangle, not ownable, and spun forever. Replaced by the quartered-leaf mark; it animates only on entry.
3. Signal colours were reused as decoration. Rule now: **signal colours carry meaning only** (a category, a hazard, a result). Neutral UI uses `--brand-tint` / `--accent-ink`.
4. White text on pale signal fills failed contrast. Each category now has a **fill** (AA with white text), a **bright** (strokes on video), an **ink** (text on surfaces) and a **tint**.
5. Hard-coded hex and emoji (♻️ 📞 🕐 ⭐) in the map script. Replaced by classes and the brand mark.

## Tokens

| Group | Tokens |
|---|---|
| Brand | `--forest-950…600`, `--lichen-300…800`, `--bone-50…300` |
| Surfaces | `--bg` `--surface` `--surface-2` `--surface-sunk` `--glass` |
| Ink | `--ink` `--ink-2` `--ink-3` `--line` `--line-strong` |
| Action | `--cta-bg` `--cta-bg-hover` `--cta-ink` (forest in light, lichen in dark) |
| Accent | `--accent-ink` (text), `--brand-tint` (neutral wash) |
| Signal ×4 | `--cat-{bio,recycle,hazard,general}-{fill,bright,ink,tint}` |
| Space | `--space-1…12` (4px base) |
| Radius | `--r-xs 6` `sm 10` `md 14` `lg 20` `xl 28` `pill` |
| Type | `--text-2xs…xl`, `--text-display` (fluid) |
| Motion | `--ease`, `--ease-in-out`, `--dur-1/2/3` (120/220/420ms) |

Legacy aliases (`--ink-soft`, `--sig-*`, `--paper`) still resolve, so old inline styles and JS strings keep working.

**Type roles:** Fraunces = display and wordmark (the italic *Sort* is the brand's one flourish). Geist = UI. Geist Mono = labels, numbers, eyebrows (uppercase, wide tracking).

## Components

| Component | Variants | States covered | Notes |
|---|---|---|---|
| `.primary-btn` | default, loading | hover, active, focus ring, disabled, loading | One per view. |
| `.ghost-icon-btn` | icon, icon+label | hover, active, disabled | Secondary actions. |
| `.capture-btn` | — | hover, active, disabled | Shutter ring. |
| `.rail-btn` / `.quick-actions-rail` | dock (mobile), sidebar (≥900px) | hover, active | Mobile dock floats, glass. |
| `.camera-box` | idle, loading, error, scanning, flash | all | Overlay states via `.is-loading` / `.is-error`. |
| `.live-scan-box` | 4 categories + low-confidence | hazard pulses | Colour from `--cat-*-bright`. |
| Result (`#resultPage[data-category]`) | 4 categories + hazard | — | `data-category` themes the page; `--conf` drives the meter. |
| Modal / sheet | about, map, history | — | Centered card on desktop, bottom sheet on mobile. |
| `.shop-card`, `.history-item` | — | hover on actions | Replaces inline-styled markup. |

**Accessibility:** visible focus ring (`--accent-ink` outline, `--ring` on buttons); `prefers-reduced-motion` disables all animation; icon-only buttons carry `aria-label`; category is never conveyed by colour alone (always a text label); text on fills meets 4.5:1.

## Do / Don't

| Do | Don't |
|---|---|
| Use a signal colour only for a category or hazard | Use green/blue/red as decoration |
| One `.primary-btn` per view | Stack two filled CTAs |
| Use tokens for radius, type, space | Add literal px values |
| Show the mark via `<use href="#ecosort-mark">` (inherits `currentColor`) | Add per-theme PNG logo files |

## Extending

New component checklist: pick a radius and shadow token → define hover/active/focus/disabled → both themes via tokens → add `aria-*` → note it here.
