# SpaceX Launch Board — Neon Crystal Design System

A futuristic neon crystal aesthetic applied to the SpaceX launch board, combining glassmorphism, prismatic geometry, and electric color accents for a dramatic visual upgrade.

## Palette

The neon prism palette consists of three core hues rendered against a deep-space near-black canvas:

### Neon Prism Colors
- **Neon Cyan** (`#00d9ff`): Primary accent color, used for hero headings, featured countdown digits, card borders, and data glow halos. Electric and vibrant against the dark background.
- **Neon Magenta** (`#ff006e`): Hot accent secondary, used for hover state intensification, status badges, and gradient accents in animated transitions. Complements cyan with warmth.
- **Neon Purple** (`#8000ff`): Ultraviolet tertiary, used for data source badges, footer borders, and background nebula accents. Creates depth and cosmic atmosphere.

### Background & Supporting Colors
- **Deep Space Near-Black** (`#0a0e1a`): Primary background, part of a fixed gradient to create depth.
- **Nebula Accent** (`#0f1428`, `#1a0f2e`): Secondary background gradients for the fixed body layer creating nebula effect.
- **Background Secondary** (`#1a1f3a`): Card background secondary blend.
- **Background Tertiary** (`#2a3050`): Hover states and featured sections.

### Text Colors
- **Primary Text:** `#e8eaed` — High-contrast white for main content
- **Secondary Text:** `#a0aec0` — Medium contrast for supporting text
- **Tertiary Text:** `#718096` — Low contrast for labels and metadata

### Status Indicators
- **Live/Go Status:** `#10b981` — Green for active launches
- **Scheduled Status:** `#8b5cf6` — Purple for scheduled events
- **Unknown Status:** `#6b7280` — Gray for TBD information

## Type Scale

A strict modular type scale based on 1rem (16px) base with geometric progression:

- **XS:** 0.75rem (12px) — Captions, badges, small labels
- **SM:** 0.875rem (14px) — Small body text, UI labels
- **Base:** 1rem (16px) — Body text, standard reading size
- **LG:** 1.125rem (18px) — Subheadings, descriptions
- **XL:** 1.25rem (20px) — Card titles, emphasis
- **2XL:** 1.5rem (24px) — Section headings
- **3XL:** 1.875rem (30px) — Large section titles
- **4XL:** 2.25rem (36px) — Page headers
- **5XL:** 3rem (48px) — Hero titles

### Typography Treatment
- **Display Headings** (`h1`, `h2`, `h3`): `text-transform: uppercase` + `letter-spacing: 0.15em` for an ultra-wide condensed aesthetic.
- **Countdown Digits**: `font-variant-numeric: tabular-nums` for aligned digital-terminal style numbers.
- **Font Families**:
  - **Display & Body:** System font stack (`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`) for optimal performance and native feel
  - **Monospace:** `'Courier New', Courier, monospace` — Used for countdown timers and numeric data with `font-variant-numeric: tabular-nums` for fixed-width digits

## Spacing Scale

A geometric spacing scale based on 1rem (16px) unit:

- **XS:** 0.25rem (4px) — Micro spacing within components
- **SM:** 0.5rem (8px) — Compact padding
- **MD:** 1rem (16px) — Default component padding, margins
- **LG:** 1.5rem (24px) — Medium separation, card padding
- **XL:** 2rem (32px) — Section padding, gaps
- **2XL:** 3rem (48px) — Large section padding
- **3XL:** 4rem (64px) — Hero section padding
- **4XL:** 6rem (96px) — Page-level vertical spacing

All gaps and padding derive from these units, maintaining rhythm and visual hierarchy.

## Layout Grid

### Desktop (1280px+)
- **Grid Columns:** 12 columns (CSS Grid)
- **Launch Cards:** 3-column grid layout
- **Hero Layout:** 2-column layout (text + featured countdown)
- **Max Width:** 1280px container with centered alignment

### Tablet (768px–1279px)
- **Launch Cards:** 2-column grid layout
- **Hero Layout:** 2-column layout maintained
- **Padding:** Increased horizontal padding (`--spacing-xl`)

### Mobile (640px–767px)
- **Padding:** Medium padding (`--spacing-lg`)
- **Countdown Display:** 2x2 grid (4 units: days, hours, minutes, seconds)

### Small Mobile (≤375px)
- **Grid Collapse:** Single-column layout with adjusted type scale
- **Countdown Display:** 2x2 grid maintained for readability
- **Type Scale:** Reduced to prevent overflow
- **Padding:** Compact spacing maintained

### Grid Gap
- **Default:** 1rem (16px) gap between grid items
- **Maintained at all breakpoints** for visual consistency

## Glassmorphism & Crystal Facets

### Glass Treatment (backdrop-filter)
All interactive cards and the featured countdown use **glassmorphism** via `backdrop-filter: blur(8-10px)`, layering translucent backgrounds over the animated nebula gradient. This creates a frosted-glass effect that lets the background shimmer through.

```css
backdrop-filter: blur(8px);
background: rgba(26, 31, 58, 0.3–0.5);
```

### Faceted Shards (clip-path polygons)
Launch cards are rendered as **faceted crystal shards** using angled `clip-path: polygon(...)` paths, angling the corners at ~5–8° to suggest broken glass prisms. The facet geometry shifts slightly on smaller screens to maintain visual balance. Each card is a prismatic shard with beveled edges, simulating light refracting through crystal.

## Neon Glow Shadows

### Box & Text Shadows
Neon glows are created using layered `text-shadow` and `box-shadow` declarations with semi-transparent neon hues, simulating light diffusion through a prism:

- **Hero countdown digits**: Multi-layer cyan + purple glow with 2s pulse animation.
- **Launch card borders**: Cyan primary, magenta on hover, with inner inset shadows for depth.
- **Status badges**: Per-status color glow (green for "Go", cyan for "TBD", magenta for "Scheduled").

Example:
```css
text-shadow:
  0 0 10px var(--color-neon-cyan),
  0 0 20px rgba(0, 217, 255, 0.5),
  0 0 40px rgba(128, 0, 255, 0.3);
```

## Gradient Accents

### Linear & Radial Gradients
1. **Body Background**: Fixed radial gradients (cyan at 20% left, purple at 80% right) create a subtle nebula atmosphere behind all content.
2. **Hero Shimmer Line**: Animated horizontal gradient (cyan → magenta → purple) at the hero top edge, 4s shimmer cycle.
3. **Neon Borders**: Launch cards use gradient borders transitioning cyan → magenta → purple along the clip-path edge.
4. **Featured Countdown**: Backdrop gradient with inset glow for holographic accent.

## Motion & Transitions

### Keyframe Animations
- `nebulaPulse` (8s): Background opacity pulse (1 → 0.8 → 1), creates breathing nebula effect.
- `shimmerWave` (4s): Hero edge line opacity pulse (0.5 → 1 → 0.5), horizontal shimmer effect.
- `neonPulse` (2s): Countdown digit glow intensity pulse, multi-layer shadow growth.
- `fadeInUp` (0.8s, staggered): Initial load entrance animations on hero content.

### Easing & Durations
- **Standard Easing:** `cubic-bezier(0.4, 0, 0.2, 1)` — Material Design standard
- **Duration (Fast):** 150ms — Hover states, button feedback
- **Duration (Base):** 250ms — Card transitions, modal slides

### Reduced Motion Respect
All motion gates behind `@media (prefers-reduced-motion: reduce)` — motion pauses, glows hold steady, animations become static. This ensures accessibility for users who prefer static layouts.

## Component Specifications

### Hero Section
- Full viewport height on desktop (`min-height: 100vh`)
- Fixed gradient background with nebula effect
- Animated shimmer line at top border
- Featured countdown with glassmorphism, gradient border, and neon glow
- Heading text glow with cyan + purple shadows

### Launch Cards — Faceted Crystal Glass Shards
- **Shape**: Angled clip-path polygon (faceted shard geometry)
- **Glass Effect**: `backdrop-filter: blur(8px)` with semi-transparent background
- **Border**: 2px neon cyan, shifts to magenta on hover
- **Glow**: Layered box-shadow with cyan primary and inset purple blend
- **Hover**: Border shifts to magenta, background opacity increases, transform lifts card by 4px
- **Launched State**: Opacity reduced to 0.6, border becomes gray

### Countdown Timers
- **Font**: Monospace with `font-variant-numeric: tabular-nums`
- **Featured countdown (hero)**: 5xl font size (3rem) with neon cyan glow and pulse animation
- **Card countdowns**: 2xl font size (1.5rem) with neon cyan text-shadow glow
- **Format**: Two-digit padding for hours, minutes, seconds
- **Days**: Variable width (can be 1–3+ digits)

### Status Badges
- **Styling**: Color-coded by status with per-color neon glows
- **Unknown**: Purple border + glow
- **Go**: Green border + glow
- **TBD/Determined**: Cyan border + glow
- **Scheduled/Hold**: Magenta border + glow
- **Display**: Inline-block, rounded corners, uppercase text with letter-spacing

### Data Source Indicator
- **Style**: Glassmorphic pill-shaped badge with purple neon border and glow
- **Display**: "Live Data" (API fetch) or "Sample Data" (fallback/offline)
- **Glow**: Purple neon box-shadow with inset blur effect

### Footer
- Purple neon top border (2px) with inset glow
- Semantic footer landmark with relative z-index for layering

## Responsive Breakpoints

- **Mobile:** ≤375px (small devices, facet angles adjusted)
- **Mobile Extended:** 376–639px
- **Tablet:** 640px–767px (facet angles adjusted)
- **Tablet Large:** 768px–1279px (facet angles adjusted)
- **Desktop:** 1280px+ (full facet geometry)

## Accessibility

- **Semantic HTML:** `<main>`, `<section>`, `<footer>` landmarks used throughout
- **Color Contrast:** Neon accents on near-black meet WCAG AA standards (high contrast for body text; decorative glows are supplementary)
- **Motion:** `prefers-reduced-motion` media query disables all animations for users with motion sensitivity
- **Responsive:** Fully functional at 375px width and below with dynamic type scaling and layout reflow
- **Tabular Numerals:** Countdown digits use fixed-width monospace for alignment
- **Data Attributes:** Machine-verifiable hooks (`[data-launch-time]`, `[data-field="..."]`, etc.) for accessibility tooling

## Self-Contained & Performance

- **Inline Styles**: All CSS is embedded in a single `<style>` block; no external stylesheets or CDN fonts.
- **Inline Script**: All JavaScript logic (fetch, countdown updates, rendering) is embedded in a single `<script>` block; no external frameworks.
- **Offline**: Full functionality with bundled fallback dataset when the network is unavailable or disabled.
- **Fixed Background**: The nebula gradient background is fixed, reducing layout thrashing on scroll.
- **Graceful Degradation**: Backdrop filters may not render on older browsers; solid backgrounds provide fallback.
