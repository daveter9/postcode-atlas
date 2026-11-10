---
name: ticket
description: Bouw een ticket van het GitHub Projects-board van postcode-atlas in een eigen worktree en lever het op als PR met screenshots (desktop en mobiel) en Lighthouse; zet het ticket daarna op Review met een link naar de PR. Gebruik bij "/ticket 12", "doe ticket #12", "pak issue 12 op", "bouw ticket 12".
---

# Ticket bouwen en opleveren als PR

Argument: het issuenummer (`$ARGUMENTS`). Board: https://github.com/users/daveter9/projects/1
(Backlog → Todo → In Progress → Review → Done). Board-acties via `node scripts/board.mjs …` (zie de kop
van dat script); `gh` staat in `C:\Program Files\GitHub CLI` als het niet op PATH staat.

Dit wijkt af van de gewone regel in `AGENTS.md`: een ticket gaat **niet** direct naar `main` en wordt
**niet** gedeployd. Je levert een PR op; de gebruiker reviewt, merget en deployt.

1. **Lees het ticket**: `gh issue view <n> --repo daveter9/postcode-atlas --comments`. Onduidelijk of te
   groot voor één PR? Stel je vragen in de sessie (of stel `/refine <n>` voor) voordat je bouwt.
2. **Worktree** (vanaf de nieuwste `main`, zoals in `AGENTS.md`; `<slug>` = korte titel in kebab-case):
   ```bash
   git -C /c/proj/postcode-atlas fetch origin
   git -C /c/proj/postcode-atlas worktree add ../postcode-atlas-wt/ticket-<n> -b ticket/<n>-<slug> origin/main
   cd /c/proj/postcode-atlas-wt/ticket-<n> && npm ci
   ```
   Hierna is `dir` = `C:\proj\postcode-atlas-wt\ticket-<n>`. Werk **alleen** daar en draai alle scripts
   (`scripts/board.mjs`, `scripts/pr-evidence.mjs`) vanuit `dir`, niet vanuit de gedeelde hoofdmap.
3. **Status**: `node scripts/board.mjs move <n> "In Progress"`.
4. **Bouwen**: implementeer volgens `AGENTS.md` en de bestaande code. Breid `tests/e2e.mjs` uit als de
   functionaliteit te testen is.
5. **Controleren** in `dir`: `npx ng build` slaagt; `npm run build:pages` en daarna `node tests/e2e.mjs`
   geeft "alles ok".
6. **Committen** in `dir`: eerst `git fetch origin && git rebase origin/main` (bij een conflict in
   `VERSION`/`src/app/version.ts`: zie `AGENTS.md`), dan `npm run build:pages` opnieuw, dan committen met
   een kort Nederlands bericht (de hook verhoogt de versie). Stage alleen je eigen bestanden.
7. **Bewijs**: schrijf in de scratchpad (niet in de repo) een steps-module die de **gevraagde
   functionaliteit** stap voor stap laat zien (format: kop van `scripts/pr-evidence.mjs`) en draai vanuit
   `dir`: `node scripts/pr-evidence.mjs <n> --root . --steps <steps.mjs>`.
   Dat maakt screenshots op desktop en mobiel van de echte build, meet Lighthouse van deze build naast een
   build van `origin/main` (en de live site als referentie), pusht de afbeeldingen naar de branch
   `pr-assets` en geeft markdown terug. Duurt een paar minuten (draai op de achtergrond).
   **Bekijk de screenshots zelf** (Read op de paden in de uitvoer) en controleer dat ze echt tonen wat het
   ticket vraagt; zo niet, pas de steps aan en draai opnieuw.
8. **PR**: `git -C <dir> push -u origin <branch>`, dan
   `gh pr create --repo daveter9/postcode-atlas --base main --head <branch> --title "<titel>" --body-file <bestand>`.
   Body: korte samenvatting, `Closes #<n>`, wat er veranderd is, hoe het getest is, de bewijs-markdown,
   en als laatste regel `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
9. **Review**: pas nu `node scripts/board.mjs move <n> Review` en
   `node scripts/board.mjs comment <n> "PR: <url> — <één zin wat er gebouwd is>"`.
10. **Opruimen**: `git -C /c/proj/postcode-atlas worktree remove ../postcode-atlas-wt/ticket-<n>` en
    `git -C /c/proj/postcode-atlas branch -D <branch>` (de branch op origin blijft voor de PR).
    Meld de PR-link aan de gebruiker.

Gaat er onderweg iets mis: laat het ticket op In Progress staan, zet een comment op het ticket met wat er
misging en meld het in de sessie. Merge geen PR's, deploy niet en zet tickets niet op Done.
