# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

`site/` holds a **static front-end prototype** — plain HTML, CSS and JS with **no build step, no package manager, no dependencies**. There is no back-end: auth, persistence, e-mail and the `.zip`/`.xlsx` export are simulated in the browser. Do not introduce a framework or bundler without asking.

Run it (the pages fetch data via JS, so `file://` breaks them — always serve over HTTP):

```bash
python3 -m http.server 8080 --directory site
```

`ABRIR SITE.command` is the double-clickable macOS wrapper around that same command. `.claude/launch.json` defines the `site-phygital` preview target.

There is **no test suite**. Verify changes by loading pages in the browser and checking the console. `LEIA-ME.md` is the client-facing documentation, in Portuguese — keep it in sync when the file layout changes.

The two source-of-truth documents are PDFs (extract text with `python3 -c "import fitz; ..."` — PyMuPDF is available; `pdftotext` is not installed):

- `NOVO SITE PHYGITAL BRASIL.pdf` — the full functional spec (17 pages) for the public site, the Competitor Panel, and the Admin Panel.
- `ID/Branding_Book_Phygital_Brasil.pdf` — brand manual (11 pages): logo rules, palette, typography.

Content and UI copy are **Brazilian Portuguese**. The spec is written in pt-BR; keep user-facing strings in pt-BR.

## What is being built

A tournament platform for Phygital Brasil (phygital sports: football, basketball, dance, shooter/esports), in three parts:

1. **Public site** — Home, Quem Somos, Modalidades (dropdown: Futebol, Basquete, Dance, Shooter, Outros), Inscrições, Eventos, Parceiros, Contato, Blog. Home layout follows `https://tornados.ancorathemes.com/`: hero, open registrations (section hidden entirely when none are open), news, national ranking table. Main nav carries an "Acessar Painel" login button.
2. **Painel do Competidor** — self-registration with email-code verification, then team management, registrations, ranking, support tickets ("chamados"), account.
3. **Painel de Administrador** — dashboard, banner management, championship CRUD + lifecycle, ticket handling, blog CMS, bulk email, user/role management.

Both panels share one login screen; the account's role decides the destination.

## Domain rules that drive the data model

These are the constraints most likely to be gotten wrong; they come straight from the spec.

**Team rosters vary by modality** — each modality has a *different* registration form and roster bounds:

| Modality | Players (min–max) | Reserves | Staff | Extra fields |
|---|---|---|---|---|
| Futebol | 6–8 | up to 3 | coach + 2 | team age category (Sub 16/17/18, Amador, Profissional); player shirt nº, função |
| Basquete | 3–4 | up to 2 | coach + 1 | player shirt nº |
| Shooter | 5 (all required) | up to 3 | coach only | Steam64 ID, Faceit profile URL |
| Dança | 1 athlete | — | optional, 1 | shirt nº |

Common player fields: nome, apelido, email, telefone, data de nascimento, foto, @Instagram. Staff fields: nome, email, telefone, data de nascimento, foto, @Instagram.

**Registration lifecycle** — a signup lands in *Lista de Inscritos*; an admin moves it to *Lista Oficial* or *Lista de Espera*. Each transition emails the user. The first confirmation email carries a protocol number and must state explicitly that it confirms the registration, **not** a guaranteed spot.

**Edit lock** — competitors may freely edit their registration until the championship's registration close date. After that, every change must go through a *chamado* (support ticket) reviewed by an admin. This lock is a cross-cutting rule, not a per-screen check.

**Championship lifecycle** — Criar → Publicar → (inscrições abertas) → Iniciar Campeonato → Encerrar → Apurar (admin manually orders final placements) → Encerrado. The manual placement ordering is what feeds the global ranking; nothing else writes it.

**Ranking** — per-modality global ranking (team/athlete name, wins, losses, championships entered, titles won, GOTF participation), with past championships of that modality listed below, each drilling into its own final standings.

**Export** (admin, per-championship *and* per-team) — a `.zip` containing one folder per team, team logo named after the team, each player photo named after that player's `nome` field, plus an `.xlsx` with one sheet per team. Dance championships are the exception: flat photos + a single-sheet `.xlsx`, no per-athlete folders. The photo↔name concatenation is called out in the spec as critical — organizers rely on filenames to identify people.

**Email** — every notification (registration confirmation, status change, ticket protocol/update/closure, championship news, password reset/change, admin broadcasts) goes through a single SMTP configuration set in Admin → Disparo de Email → Configurações. Do not add a second mail path. The broadcast composer targets all open championships or one specific championship, and delivers only to the team's responsible user (or the athlete, for dance). It needs a live preview and attachment support, and uses a fixed template: logo, subject, body, Phygital Brasil footer.

**Account changes** require email-code confirmation. Changing the email address sends the code to the *old* address first.

**Admin roles** — at minimum Master (full access) and Gestor de Campeonato (read championships, export, send email; no writes). New admin users get a temporary password and are forced through set-new-password → email-code confirmation on first login.

The spec prints a default admin email and password in plain text. Treat those as a first-run seed to be set via environment/config and rotated — never commit the credential into source.

## Brand

Palette (from the branding book; suggested proportion 60% neutral / 30% green / 10% yellow+blue):

```
Verde Phygital  #009B4A     Verde Mata     #004A1B
Amarelo Ouro    #FCE001     Âmbar          #DF9911
Azul Atlântico  #0A66B1     (light blue)   #3D93D6
Neutros:        #0E1113  ·  #6E7377  ·  #F5F6F4
Ribbon gradients: #009B4A→#004A1B, #FCE001→#DF9911, #3D93D6→#0A66B1
```

Type: **Saira** for headings, numbers and scoreboards (Bold, tracking −2%; all-caps only for short labels); **Barlow** for body and UI (line-height 1.6). System fallbacks: Arial Narrow / Helvetica.

The client wants the site "clean, black and white with some parts using color" — the palette is accent, not the base.

Logo rules that affect implementation: the colored logo has white lettering and is **dark-background only**; use the black version on light backgrounds. Clear space on all sides = half the symbol height. Minimum sizes: full lockup 160px, symbol alone 32px — below that, use the symbol only. Over photography, use the white version with the image darkened 30%. Never recolor, rotate, distort, or recompose the lockup; the symbol is indivisible.

**The ribbon is the signature device.** The three ribbons that build the logo's "P" recur as `.fita` (a green→yellow→blue tricolor bar): the `.eyebrow` marker, the top edge of `.card--fita` on hover, the active nav indicator, the kinetic diagonals in `.hero` and `.pagina-topo`. It is what keeps the design from reading as a generic template — extend it rather than inventing a second motif.

## Code layout

Three CSS files, loaded in this order — `phygital.css` is always first:

| File | Scope |
|---|---|
| `assets/css/phygital.css` | Design tokens (`:root`), reset, typography, buttons, cards, tags, forms, tables, modal, utilities |
| `assets/css/site.css` | Public site only: header, hero, page-top, championship/modality cards, gallery, blog, footer |
| `assets/css/painel.css` | Both panels: splash, auth, sidebar shell, stat cards, blocks, tickets, toasts |

Every color, font, space and radius is a `:root` custom property in `phygital.css`. Change the token, not the call site — hardcoded hex in a component is a bug.

`assets/js/dados.js` (load first) is the data layer: seed data plus `PB.dados.*` query functions, persisted to `localStorage` under `phygital.dados.v1`. Its `MODALIDADES` map is the **single source of truth for roster rules** — every form and validation reads from it, so a rule change happens in one place. `PB.dados.validarElenco(mod, titulares, reservas)` is the shared validator. `PB.dados.resetar()` restores the seed. The function signatures are designed as a stable contract: when the back-end arrives, swap the bodies for HTTP calls and the pages keep working.

`assets/js/phygital.js` wires behavior by data attribute, and every initializer no-ops when its markup is absent — so pages opt in by markup alone, never by importing anything:

`data-hero` (slider) · `data-abas` + ARIA tabs · `data-filtros` · `data-abrir-modal`/`data-fechar-modal` · `data-validar` + `data-demo` + `data-ir-para` (forms) · `data-confirmar` (destructive actions) · `data-contar` (animated counters) · `data-contagem` (countdown) · `data-upload` · `data-splash` · `data-painel-toggle` · `data-submenu` · `data-mascara="telefone"` · `.otp` · `.revelar`. Helpers: `PB.fmt.*`, `PB.toast()`, `PB.confirmar()`, `PB.abrirModal()`.

Public pages live at `site/` root and use `assets/…`; panel pages live in `site/painel/` and `site/admin/` and use `../assets/…`.

Pages are standalone HTML — header and footer are duplicated, not included. `index.html` is the canonical copy: when the nav or footer changes, propagate from there, and only the `nav__item--ativo`/`aria-current` differ per page.

Mock imagery in `assets/img/mock/` is generated brand-styled SVG, not photography. Replace with real photos when available; keep the filenames so no markup changes.

## Asset locations

- `ID/Logo/Editados/` — web-ready PNG + WebP (colorido, preto, branco, cinza) and the app/avatar icon. Copied into `site/assets/img/logo/`.
- `ID/Logo/LOGO_COLORIDO|LOGO_NEGATIVO|LOGO_TONS_CINZA/` — official masters in AI, EPS, PDF, JPG, PNG per variant. Source of truth; do not re-derive the mark from anything else.

Pages 13–17 of the site PDF are reference screenshots only — the spec explicitly says not to copy them as the design. The WordPress theme in `~/Documents/Phygital/Novo Site/tornados-2.9.0.zip` was the layout reference (section order and hierarchy); nothing from it is used in code.
