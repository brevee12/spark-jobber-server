# Jobber quote style (Veenstra Painting)

Derived from 24 sent/converted quotes (Jun–Oct 2026). Use with `quote_meeting`
after summarizing a client-meeting voice note or recording. Drafts only —
Brennan reviews and sends from Jobber.

## Flow

1. Summarize the recording: client, job site, scope by area, exclusions,
   assumptions, colors/products, access (lift?), timing/weather, deposit.
2. Build line items from the **Jobber Products & Services** names below (the
   tool fills catalog price/taxable and refuses unknown names).
3. `quote_meeting` with `apply:false` → check client/quote match and
   `catalog.warnings` → `apply:true`.
4. Hours, gallons, and lump sums come from Brennan's numbers in the recording.
   If he didn't say, leave the quantity at a clearly-flagged estimate and say
   so in chat — never invent pricing silently.

## Title

Short scope, no client name or address: `Exterior Repaint`, `Interior Painting`,
`Deck Staining`, `Basement Drywall and Paint`, `Paint Soffits & Fascia`,
`Ext. Soffits and windows`, `Garage Drywall Repair`.

## Line items (catalog names)

| Line | Use | Typical qty / price | Description style |
| --- | --- | --- | --- |
| `1 Labor` | Main scope, hourly | hours @ $60 (exteriors ~70–160 h) | Scope lines (below) |
| `1 Labor` | Lump-sum scope / extra area | qty 1 @ $X | Scope lines; often "Includes paint and labor" |
| `Emerald Exterior - Satin` | Exterior paint | gallons @ catalog (~1 gal per 7–10 labor h) | `Exterior Paint` |
| `Exterior Oil-Based Primer` | Bare wood / cedar | gallons @ catalog | `Oil primer for siding.` |
| `Cashmere - Low Lustre` | Interior walls | gallons @ catalog | `Wall Paint` |
| `PVA Drywall Primer` | New drywall | gallons @ catalog | `Drywall Primer` |
| `SuperDeck` | Deck stain | gallons @ catalog | `Solid or semi-solid` |
| `Misc. Supplies` | Masking etc. | qty 1 @ $85–250 (or $0) | `Masking plastic, paper, tape, cardboard, etc.` |
| `TZ 50 Lift` | Lift days | days @ $125 | `Lift Charge` |
| `Drywall Repair` | Drywall labor | hours @ $60 or lump | Scope lines |
| `Drywall Materials` | Mud/tape | qty 1 @ $X | `plastic, mud, tape, etc` |
| `Drywall Footage Number` | New construction drywall | board ft @ rate | Board feet + rate breakdown, textures |
| `Painting Square Foot Price - Interior` | New construction paint | sq ft @ $4.75 | Floor-by-floor sq ft, what's included |
| `Painting Square Foot Price - Garage` | Garage | sq ft @ $2.50 | `1 Prime coat and 1 coat ceiling paint as finish` |
| `Built-in Allowance` | Misc built-ins | qty 1 @ $X | List the built-ins |
| `Trash Disposal` | Scrap removal | qty 1 @ $250 | Optional; "No charge if you provide a dumpster" |

Order: main labor → paint/primer → misc supplies → lift → add-on scopes
(each add-on is its own `1 Labor` line, with its own material line if needed).
Use `optional: true` for add-ons the client can check/uncheck (decks, etc.).

## Labor description

One item per line, starting with "To …"; inclusions, exclusions, assumptions
after:

```
To powerwash full exterior
To paint all siding and trim
Scrape and prime as needed. Bare spots and new wood primed with oil based primer
Match existing colors

Includes foundation
Includes front deck

*Does not include doors, windows, or gutters/downspouts.
Assumes 2 colors, 1 siding and 1 trim.
```

Estimates billed on time: add `*This is an estimate. Actual time needed will be billed…`
or "Final bill is based on time and material using the rates above."

## Message (client-facing)

Usually **empty**. When used: short, first person, plain — e.g.

- `20% deposit required to schedule the job.`
- `Weather permitting we may be able to get this done yet this year.`
- `Note the optional line items for the decks.`
- `All numbers include labor, materials, and supplies as needed.`
- Bundle discount explanation when offering one.

Never put internal meeting notes in the message.

## Deposit

20% of total on larger exterior jobs when Brennan mentions a deposit
(`depositAmount` = 0.2 × total, rounded to cents). Otherwise none.
