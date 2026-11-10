---
name: refine
description: Refine een ticket van het GitHub Projects-board van postcode-atlas met de grilling-skill (Matt Pococks grill-me) en schrijf de uitkomst als spec in het ticket. Gebruik bij "/refine 12", "grill ticket 12", "laten we ticket 12 refinen".
---

# Ticket refinen

Argument: het issuenummer (`$ARGUMENTS`).

1. Lees het ticket: `gh issue view <n> --repo daveter9/postcode-atlas --comments`
   (`gh` staat in `C:\Program Files\GitHub CLI` als het niet op PATH staat).
2. Roep de skill **grilling** aan met het ticket (titel, beschrijving, comments) als het plan dat
   gegrild wordt, en voer het gesprek hier in de sessie. Feiten zoek je zelf op in de code (lees in een
   worktree of via `git show origin/main:<pad>`, niet in de gedeelde hoofdmap); beslissingen leg je voor.
3. Als de frontier leeg is en de gebruiker bevestigt dat jullie het eens zijn: schrijf de beschrijving
   opnieuw als spec (doel, gedrag, acceptatiecriteria, buiten scope) met de oorspronkelijke tekst onderaan
   in `<details><summary>Oorspronkelijke tekst</summary>…</details>`, naar een tijdelijk bestand, en zet hem
   in het ticket met `node scripts/board.mjs edit <n> --body-file <bestand>`.
4. Laat de status staan, tenzij de gebruiker iets anders vraagt (bijvoorbeeld meteen `/ticket <n>`).
