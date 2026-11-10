# Werkafspraken voor agents

## Na elke wijziging: committen en pushen
- Commit en push elke afgeronde wijziging meteen naar `main` (`git push origin main`), zonder dat eerst te vragen.
- Commitberichten in het Nederlands, kort en beschrijvend (zie `git log`).
- Elke commit verhoogt de versie met 0.1. Dat doet de pre-commit-hook (`.githooks/pre-commit` →
  `scripts/bump-version.mjs`, schrijft `VERSION` en `src/app/version.ts`). Niet met de hand ophogen.
  Controleer in een verse clone dat de hook aanstaat: `git config core.hooksPath` moet `.githooks` zijn
  (anders `npm install` of `git config core.hooksPath .githooks`).
- Bouw ná het committen als je daarna deployt (`npm run deploy`), anders heeft de bundel de vorige versie.

## Controleren voor je commit
- `npx ng build` moet slagen.
- `node tests/e2e.mjs` moet "alles ok" geven (desktop en mobiel).
