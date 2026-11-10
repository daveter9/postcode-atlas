# Werkafspraken voor agents

## Werk altijd in een eigen worktree
Er werken meerdere sessies tegelijk aan dit project. Werk daarom **nooit** direct in de hoofdmap
`C:\proj\postcode-atlas` (daar staan wijzigingen van anderen, en een build of deploy daar neemt die mee).

- Begin elke taak met een eigen worktree vanaf de nieuwste `main`:
  ```bash
  git -C /c/proj/postcode-atlas fetch origin
  git -C /c/proj/postcode-atlas worktree add ../postcode-atlas-wt/<korte-naam> -b <korte-naam> origin/main
  cd /c/proj/postcode-atlas-wt/<korte-naam> && npm ci
  ```
  Alle data staat in git, dus na `npm ci` kun je daar bouwen, testen en deployen.
- Stage alleen je eigen bestanden (`git add <pad>`, geen `git add -A`).
- Ruim de worktree op als je klaar bent: `git worktree remove <map>` en `git branch -D <korte-naam>`.

## Na elke wijziging: committen, pushen en deployen
- Commit en push elke afgeronde wijziging meteen naar `main` en deploy daarna naar postcoderadar.nl,
  zonder dat eerst te vragen. Uitzondering: tickets van het GitHub Projects-board gaan via een PR
  (zie `.claude/board-loop.md` in de hoofdmap); die merge en deploy je niet zelf.
- Volgorde, vanuit je worktree:
  1. `git fetch origin && git rebase origin/main` (anderen kunnen intussen gepusht hebben)
  2. bouwen en testen (zie hieronder)
  3. `git commit` (de hook verhoogt de versie)
  4. `git push origin HEAD:main`; geweigerd? Terug naar stap 1.
  5. `npm run deploy`, alleen als `git rev-parse HEAD` gelijk is aan `git rev-parse origin/main`
     (anders deploy je een oudere of afwijkende versie over die van een ander heen).
- Conflict in `VERSION` of `src/app/version.ts` bij het rebasen: neem de versie van `main` en hoog op:
  `git checkout origin/main -- VERSION src/app/version.ts && node scripts/bump-version.mjs && git add VERSION src/app/version.ts && git rebase --continue`
- Commitberichten in het Nederlands, kort en beschrijvend (zie `git log`).
- Elke commit verhoogt de versie met 0.1. Dat doet de pre-commit-hook (`.githooks/pre-commit` →
  `scripts/bump-version.mjs`, schrijft `VERSION` en `src/app/version.ts`). Niet met de hand ophogen.
  De hook geldt voor alle worktrees; controleer met `git config core.hooksPath` (moet `.githooks` zijn).
- `npm run deploy` leegt `dist`, bouwt opnieuw en deployt met wrangler. Altijd ná de commit draaien,
  anders heeft de bundel de vorige versie. Werkt alleen als wrangler is ingelogd (`npx wrangler@4 login`);
  zo niet, meld dat aan de gebruiker.

## Controleren voor je commit
- `npx ng build` moet slagen.
- `node tests/e2e.mjs` moet "alles ok" geven (desktop en mobiel); bouw eerst met `npm run build:pages`.
