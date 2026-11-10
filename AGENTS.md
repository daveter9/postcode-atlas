# Werkafspraken voor agents

## Na elke wijziging: committen, pushen en deployen
- Commit en push elke afgeronde wijziging meteen naar `main` (`git push origin main`) en deploy daarna
  naar postcoderadar.nl met `npm run deploy`, zonder dat eerst te vragen. Volgorde: commit → push → deploy.
- Commitberichten in het Nederlands, kort en beschrijvend (zie `git log`).
- Elke commit verhoogt de versie met 0.1. Dat doet de pre-commit-hook (`.githooks/pre-commit` →
  `scripts/bump-version.mjs`, schrijft `VERSION` en `src/app/version.ts`). Niet met de hand ophogen.
  Controleer in een verse clone dat de hook aanstaat: `git config core.hooksPath` moet `.githooks` zijn
  (anders `npm install` of `git config core.hooksPath .githooks`).
- `npm run deploy` leegt `dist`, bouwt opnieuw en deployt met wrangler. Altijd ná de commit draaien,
  anders heeft de bundel de vorige versie. Werkt alleen als wrangler is ingelogd (`npx wrangler@4 login`);
  zo niet, meld dat aan de gebruiker.

## Controleren voor je commit
- `npx ng build` moet slagen.
- `node tests/e2e.mjs` moet "alles ok" geven (desktop en mobiel).
