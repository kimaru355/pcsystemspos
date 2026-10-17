---
name: PC Systems POS
description: Point of sale and stock for hardware shops, set as a thread of one-line confirmations.
colors:
  background: "oklch(0.972 0.003 150)"
  surface: "oklch(1 0 0)"
  foreground: "oklch(0.19 0.006 250)"
  muted: "oklch(0.945 0.004 150)"
  muted-foreground: "oklch(0.47 0.012 250)"
  rule: "oklch(0.885 0.006 150)"
  input: "oklch(0.8 0.008 150)"
  primary: "oklch(0.47 0.19 262)"
  primary-foreground: "oklch(0.99 0 0)"
  rail: "oklch(0.245 0.03 250)"
  rail-raised: "oklch(0.31 0.035 250)"
  rail-ink: "oklch(0.975 0.005 250)"
  rail-muted: "oklch(0.76 0.025 250)"
  rail-ring: "oklch(0.72 0.12 262)"
  paid: "oklch(0.53 0.13 152)"
  owed-ink: "oklch(0.5 0.12 58)"
  credit: "oklch(0.53 0.19 28)"
  destructive: "oklch(0.53 0.19 28)"
typography:
  headline:
    fontFamily: "Roboto, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: "2rem"
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Roboto, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: "1.75rem"
  title-sm:
    fontFamily: "Roboto, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: "1.25rem"
  body:
    fontFamily: "Roboto, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: "1.25rem"
  body-touch:
    fontFamily: "Roboto, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: "1.5rem"
  label:
    fontFamily: "Roboto, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: "1rem"
  nav-group:
    fontFamily: "Roboto, system-ui, sans-serif"
    fontSize: "0.7rem"
    fontWeight: 500
    letterSpacing: "0.025em"
  code:
    fontFamily: "Martian Mono, ui-monospace, monospace"
    fontSize: "0.8rem"
    fontWeight: 500
    letterSpacing: "-0.01em"
    fontVariation: "\"wdth\" 75"
rounded:
  sm: "3.6px"
  md: "4.8px"
  lg: "6px"
  xl: "8.4px"
spacing:
  tile-gap: "8px"
  line-y: "10px"
  gutter-phone: "16px"
  gutter-desktop: "32px"
  region-gap: "40px"
  column-gap: "48px"
  rail-width: "240px"
  order-pane: "22rem"
  order-pane-wide: "26rem"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "color-mix(in oklch, oklch(0.47 0.19 262) 80%, transparent)"
  button-primary-till:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.body-touch}"
    rounded: "{rounded.lg}"
    padding: "0 24px"
    height: "48px"
  button-outline:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "32px"
  button-ghost-hover:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.foreground}"
  input-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    typography: "{typography.body-touch}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "44px"
  rail-nav-item:
    textColor: "{colors.rail-muted}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "36px"
  rail-nav-item-active:
    backgroundColor: "{colors.rail-raised}"
    textColor: "{colors.rail-ink}"
  item-tile:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "10px"
    height: "108px"
  code-chip:
    backgroundColor: "{colors.rail-raised}"
    textColor: "{colors.rail-ink}"
    typography: "{typography.code}"
    rounded: "{rounded.sm}"
    padding: "2px 6px"
  status-strip:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.rail-ink}"
    height: "48px"
    padding: "0 16px"
---

# Design System: PC Systems POS

## Overview

**Creative North Star: "The Confirmation Thread"**

Every sale, payment, collection and setup change lands as one line, code first and the new balance last, in the grammar of the transaction SMS that Kenyan shop staff read every day. The system is a daylit counter tool: a near-white ground, ink-black text, and one dark night-blue rail that frames the work the way a message app frames a conversation. Nothing is boxed for decoration. Regions are separated by one-pixel rules and headings, and the screen is owned by one region at a time: the item grid and open order on the till, the activity thread on the admin overview.

Density is deliberate. The admin area is dense and scannable (14px body, 36px rows, tabular figures at full contrast); the till is thumb-sized (40-48px targets, a 44px scan field, a 48px Pay button under the thumb on phones). Colour has jobs and nothing else: the rail frames, the one blue marks what can be pressed, and green, amber and red speak only about money and goods. Every other state (online, offline, active, suspended, sample data, done, to do) is told in neutral ink and words.

The face is Roboto, the face Android phones already set their SMS confirmations in. Codes (order numbers, outlet and device codes, item codes) are set in Martian Mono at its narrowest width so a code like `KTL-03-000124` reads as one token. Light theme only; there is no dark mode and none is planned.

**Key Characteristics:**
- Near-white cool-green ground with white working surfaces; a single night-blue rail (admin sidebar, till status strip, auth panel).
- One action colour, a deep blue, used only on pressable things.
- Three state colours (paid green, owed amber, credit red) used only for money and goods.
- Code-first one-line confirmations with the new balance last.
- One-pixel rules instead of cards; tabular figures everywhere money or quantity appears.
- Roboto for everything; Martian Mono at width 75 for codes only.

## Colors

A near-neutral daylight palette with one dark frame, one action blue and three money states; the hues are spent on meaning, never on decoration.

### Primary
- **Counter Blue** (primary): the only colour for pressable things. Filled primary buttons (Pay, Log in), the active till tab (text plus a 2px underline on desktop), text links such as "Show 2 earlier events" and "Go to Admin", the caret, and the focus ring (`ring` uses the same value). A disabled primary button keeps the hue at 50% opacity.

### Secondary
- **Night Rail** (rail): the one dark region. Admin and platform sidebar, the till status strip, the sign-in panel, and (at 50%) the backdrop behind sheets. The browser theme colour (#1b2530) matches it.
- **Rail Raised** (rail-raised): active rail item, rail hover (at 60%), and the code chips that sit on the rail (outlet code in the status strip, the POS tag in the wordmark).
- **Rail Ink** (rail-ink) and **Rail Muted** (rail-muted): the two inks on the rail. Active item and names in rail ink; idle nav, context lines, cashier and connection status in rail muted.
- **Rail Ring** (rail-ring): the lighter blue focus ring used on the rail, where the counter blue would not show.

### Tertiary (state colours: money and goods only)
- **Paid Green** (paid): money received. The paid fill of the settlement bar's Money track, the "Paid" figure, and "Paid." status words in confirmation lines.
- **Owed Amber Ink** (owed-ink): money or goods still owed, and low stock ("18 sheets left"). Used as text only; it is the darkened amber that holds contrast on white.
- **Credit Red** (credit): goods handed over beyond what was paid, and nothing free to sell ("None free"). The overrun segment of the Goods track and the "On credit" figure.

### Neutral
- **Daylight Ground** (background): the page ground behind everything, a near-white with a faint cool-green cast (not cream).
- **Counter White** (surface): working surfaces that hold input: item tiles, the order pane, inputs, the phone order bar and sheet, the platform table.
- **Receipt Ink** (foreground): all primary text and figures, the Goods track fill, the quantity badge on a tile, the "Suspended" badge, and the 80% rule above each admin region.
- **Graphite** (muted-foreground): secondary text, timestamps, labels, "By Jane." attributions, idle tab labels.
- **Pale Wash** (muted): the empty track of the settlement bar, hover wash on light ground, the "Active" badge, notice bands.
- **Hairline** (rule): every one-pixel divider and border on light ground.
- **Field Edge** (input): input and select borders, unchecked step circles, the scrollbar thumb.
- **Error Red** (destructive): the reserved error line under sign-in, password and admin forms. Same value as Credit Red.

### Named Rules
**The Pressable Blue Rule.** Counter Blue appears only on something that can be pressed, tabbed to or followed. Never on a heading, a figure, an icon at rest, a badge or a chart.

**The Three States Rule.** Paid, owed and credit are the only state colours, and they describe money and goods. Every other state (online, offline, active, suspended, done, sample data) is told in neutral ink and words, or in an inverted ink badge.

**The One Dark Region Rule.** The rail is the only dark region on any screen. Work never sits on it; it frames, scopes and signs out.

**The Three Inks Rule.** A region uses at most three ink values: foreground, muted foreground, and one state or action colour.

## Typography

**Body Font:** Roboto (via next/font, with system-ui fallback)
**Label/Mono Font:** Martian Mono (via next/font, `wdth` axis set to 75, with ui-monospace fallback)

**Character:** Roboto is the familiar voice of the phone's own messages, plain and unhurried. Martian Mono, squeezed to its narrowest width and slightly tightened, gives codes a mechanical, receipt-printer cut that sets them apart from prose without taking space.

### Hierarchy
- **Headline** (600, 1.5rem/2rem, tracking -0.025em): page titles in the page header and the sign-in form; also the till's order total (in tabular figures).
- **Title** (600, 1.125rem/1.75rem): large admin region headings ("Activity", "Money and goods today").
- **Title Small** (600, 0.875rem): small region headings, order and sheet titles.
- **Body** (400, 0.875rem/1.25rem): the default for admin text, nav items, confirmation lines and tables. Descriptions cap at 65ch.
- **Body Touch** (400, 1rem): inputs on phones and the till scan field, so Android does not zoom; drops to 0.875rem from md on sign-in.
- **Label** (500, 0.75rem/1rem): meta lines, timestamps, settlement track labels and amounts, day separators, phone tab labels.
- **Nav Group** (500, 0.7rem, tracking 0.025em, uppercase): the group labels inside the rail nav only. This is navigation structure, not a heading device.
- **Code** (Martian Mono 500, 0.8rem in lines, 0.7rem on tiles, `wdth` 75, -0.01em): order numbers, outlet codes, item codes, the POS tag, keyboard hints.

### Named Rules
**The Code-First Rule.** Anything a person reads aloud to find a record (order number, outlet code, item code, device code) is set in the code face and leads its line. Prose, names and money never use the mono.

**The Column Figures Rule.** Money and quantities always use tabular numerals (`.figures`, and every table) at full contrast in semibold where they are the point of the line.

## Layout

Two shells share one grammar.

**Admin and platform:** a fixed 240px night rail on the left from md up; a sticky 56px top bar on the light ground (95% opacity with a light backdrop blur) carrying the outlet filter and quick actions; one work area capped at 72rem with 16px gutters on phones and 32px from md, 24px/32px vertical padding. Below md the rail folds into a sheet (288px, max 85vw) that slides in from the left behind a 50% rail backdrop. The overview splits 2:1 from lg (48px column gap, 40px between stacked regions).

**Till:** full viewport height, no page scroll. A 48px rail-coloured status strip on top (outlet code chip, outlet, cashier, connection, Admin, Log out). Desktop: a tab row (44px) under the strip, then the item grid on the left and the order pane on the right (22rem from md, 26rem from lg) with a hairline between them. Phone: the tab bar moves to the bottom (56px targets, safe-area padded), the grid goes full width, and an order bar sits above the tabs with the item count, total and a 48px Pay button; tapping it opens the order as a bottom sheet (max 88dvh).

**Item grid:** auto-fill columns of at least 9.5rem on desktop (2 columns on phones, 3 from sm), 8px gap, tiles at least 108px tall.

**Rhythm:** list rows run 6px to 12px vertical (confirmation lines 10px); the settlement bar's tracks sit 10px apart; page header bottom padding 24px.

### Named Rules
**The One Region Rule.** Each screen is owned by one region: the grid and open order on the till, the activity thread on the overview. Supporting regions sit beside it and never compete in size or colour.

## Elevation & Depth

Flat. Depth comes from the one dark rail, white surfaces on the near-white ground, and one-pixel rules. Shadows exist only on things that slide over the page.

### Shadow Vocabulary
- **Sheet edge** (`box-shadow: 8px 0 32px -8px rgb(0 0 0 / 0.35)`): the mobile nav sheet sliding from the left.
- **Bottom sheet lift** (`box-shadow: 0 -12px 40px -12px rgb(0 0 0 / 0.35)`): the phone order sheet rising from the bottom.
- **Selected tile underline** (`box-shadow: 0 1px 0 0 var(--foreground)`): an item tile already in the order gets a darker border plus a one-pixel ink underline. This is a rule, not a lift.

### Named Rules
**The Flat Counter Rule.** Nothing at rest casts a shadow. Only sheets and overlays that move over the page get one.

## Shapes

Small, quiet corners from a 6px base radius: 3.6px on chips and badges, 4.8px on inputs, nav items, tiles and icon buttons, 6px on buttons and the platform table container, 8.4px on the top corners of the phone bottom sheet. Lines are one pixel: hairline dividers between list rows, a hairline under the top bar and between panes, and a stronger foreground rule (80%) above each admin region that stands in for a card. The settlement tracks are 10px bars with a 3.6px radius.

## Components

### Buttons
Plain and compact; the colour does the talking.
- **Shape:** gently rounded (6px).
- **Primary:** Counter Blue fill with near-white text, 14px medium, 32px tall by default and 36px at `lg`. On the till and sign-in it is enlarged to 44-48px with 16px text.
- **Hover / Focus / Active:** hover fades the fill to 80%; focus shows the ring colour border plus a 3px ring at 50%; press nudges down 1px. Disabled at 50% opacity.
- **Outline:** background-coloured with a hairline border, muted wash on hover. Used for secondary actions such as Collect.
- **Ghost:** no fill until hover, then the muted wash.
- **Quiet rail buttons:** 36px, rail-muted text and icon, rail-raised wash and rail-ink text on hover, rail ring on focus (Log out, Admin).
- **Stepper buttons:** 40px squares with a hairline border, foreground icon (minus, plus) on each order line.

### Inputs / Fields
- **Style:** white surface, Field Edge border, 4.8px radius, 44px on phones (16px text) and 40px from md on sign-in; the till scan field is 44px with a leading scanner icon and a `/` key hint.
- **Focus:** border turns to the ring colour plus a 3px ring at 30%.
- **Error:** a reserved one-line message slot below the fields in Error Red, so the layout never jumps.
- **Outlet filter:** a 36px native select on white with a leading store icon, medium weight, max 16rem; disabled at 60% while it applies.

### Navigation
- **Rail nav:** grouped under small uppercase rail-muted labels; 36px items with a 16px icon, 14px text. Idle in rail muted; hover washes with rail-raised at 60%; active is a rail-raised fill with rail-ink medium text. Unbuilt sections stay visible at 70% rail muted with a "Soon" tag and are not links.
- **Till tabs:** bottom bar on phones (icon over 12px label, 56px tall); a top row on desktop (icon beside 14px label, 44px) with a 2px Counter Blue underline on the active tab. Active text is Counter Blue.
- **Mobile:** a 40px menu button in the top bar opens the rail as a left sheet.

### Confirmation Line (signature)
The unit of the whole system. A three-column row: the code in mono (foreground, medium), then the sentence, then the time in small muted tabular figures. The sentence opens with a past-tense status word in semibold followed by a full stop ("Collected.", "Outlet created.") coloured by tone (paid, owed ink, credit, or foreground), then the detail, then "By Jane." in muted ink, then the new balance in medium weight, always last. Lines stack in a thread separated by hairlines, grouped by day under a small muted day label with its own hairline. In the till's order pane a compact variant uses two rows: status and who, then the balance (never cut) with the detail truncating after it.

### Settlement Bar (signature)
Money and goods on one measure. Two 10px tracks, labelled "Money" and "Goods" in small muted text: the Money track fills Paid Green to the paid share of the total; the Goods track fills Receipt Ink to the collected share and runs on in Credit Red for any goods handed over beyond what was paid. Under each track, small tabular figures: "Paid" and "Owed" (owed in Owed Amber Ink when above zero), "Collected" and "To collect" or "On credit". It renders nothing for an empty order; the empty state is said in words beside it.

### Item Tile
A white tile with a hairline border and 4.8px corners, at least 108px tall: item code in small muted mono, the name in 14px medium (two lines max), then the price in semibold tabular figures and availability on the right (muted normally, Owed Amber Ink when low, Credit Red when none is free). Hover darkens the border; once in the order the border darkens to 50% ink with a one-pixel ink underline and an inverted ink badge shows the quantity (×10).

### Regions and Lists
Admin content is not carded. Each region opens with an 80% foreground rule, a heading, and an optional small muted aside on the right; lists below are divided by hairlines. Outlet lists put the code in a fixed-width mono column. The platform table sits in a single white container with a hairline border and 6px corners, muted 12px column headers, and right-aligned numeric columns.

### Badges and Chips
- **Code chip:** mono text on rail-raised (on the rail) or inverted ink on light ground, 3.6px corners.
- **Status badge:** neutral only. "Active" is foreground on Pale Wash; "Suspended" is inverted (background on foreground).
- **Notice band:** a full-width Pale Wash band with a hairline beneath and centred 12px medium foreground text (sample-data notice on the till).

### Wordmark
"PC Systems" in semibold, tight tracking, followed by a "POS" tag in the code face at 70% size on a small chip, set like an SMS sender ID.

### Not yet designed
The till PIN unlock screen (staff picker and keypad) and the shell states for syncing, connection reminder levels, sales blocked, device revoked, business suspended and M-Pesa unavailable are deferred to later phases. They have no recorded look; design them when their phase is built, within the rules above.

## Do's and Don'ts

### Do:
- **Do** lead every money, goods or setup event with its code in the mono face and end it with the new balance.
- **Do** reserve Counter Blue for things that can be pressed: buttons, active tabs, links, focus.
- **Do** use paid green, owed amber ink and credit red only for money and goods, and say every other state in neutral ink and words.
- **Do** separate regions with one-pixel rules and headings rather than cards.
- **Do** set every amount and quantity in tabular figures at full contrast.
- **Do** keep till touch targets at 40px or more and put the total and Pay within thumb reach on phones.
- **Do** treat offline as a normal state: an icon and the word "Offline" in the strip's muted ink, never a red alarm.

### Don't:
- **Don't** add a second dark region or put work on the rail.
- **Don't** use Counter Blue for headings, figures, icons at rest or decoration.
- **Don't** colour non-money states (online, active, suspended, done) green, amber or red.
- **Don't** wrap admin regions in cards or stack KPI cards over tables.
- **Don't** use Safaricom's green, logo or wording anywhere.
- **Don't** set prose, names or money in the code face, or codes in Roboto.
- **Don't** add a dark theme; tills sit at daylit counters.
- **Don't** give resting surfaces a shadow.
