# SpaceX Launch Board Design System

## Palette

### Primary Colors
- **Background Primary:** `#0a0e27` — Deep space black, the main page background
- **Background Secondary:** `#1a1f3a` — Card background, creates depth
- **Background Tertiary:** `#2a3050` — Hover states and featured sections
- **Accent Color:** `#00d4ff` — Vibrant cyan, used for active elements and countdowns
- **Accent Dim:** `#0099cc` — Darker accent for interactions

### Text Colors
- **Primary Text:** `#e8eaed` — High-contrast white for main content
- **Secondary Text:** `#a0aec0` — Medium contrast for supporting text
- **Tertiary Text:** `#718096` — Low contrast for labels and metadata

### Borders & Dividers
- **Border Color:** `#3a4566` — Subtle separation between elements

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

### Font Families
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

## Motion & Transitions

### Easing Curves
- **Standard:** `cubic-bezier(0.4, 0, 0.2, 1)` — Material Design standard
- **Duration (Fast):** 150ms — Hover states, button feedback
- **Duration (Base):** 250ms — Card transitions, modal slides

### Effects
- **Entrance:** Fade-in with 30px upward slide (`fadeInUp` keyframe) at 0.8s with staggered delays
- **Hover:** `-2px` translateY elevation with enhanced border and shadow
- **Countdowns:** Numeric updates at 1-second intervals (no animation, direct update)

### Reduced Motion Respect
- All transitions disabled when `prefers-reduced-motion: reduce` is set
- Timings reset to 0ms to honor accessibility preferences

## Responsive Breakpoints

- **Mobile:** ≤375px (small devices)
- **Mobile Extended:** 376–639px
- **Tablet:** 640px–767px
- **Tablet Large:** 768px–1279px
- **Desktop:** 1280px+

## Component Specifications

### Hero Section
- Full viewport height on desktop (`min-height: 100vh`)
- Gradient background for depth
- Gradient direction: 135deg (bottom-left to top-right)
- Featured countdown with cyan accent border and subtle shadow on hover

### Launch Cards
- Rounded corners: 8px
- Border: 1px solid `--color-border`
- Hover effect: Border shifts to accent color, background lightens, subtle shadow
- Opacity reduced to 0.6 for launched missions
- Card countdown in tabular numerals for alignment and readability

### Countdown Timers
- Font: Monospace with `font-variant-numeric: tabular-nums`
- Featured countdown (hero): 3rem font size
- Card countdowns: 1.5rem font size
- Format: Two-digit padding for hours, minutes, seconds
- Days: Variable width (can be 1–3+ digits)

### Status Badges
- Inline-block display
- Rounded corners: 4px
- Color-coded by status (green/go, purple/scheduled, gray/unknown)
- Uppercase text with 0.08em letter spacing

### Data Source Indicator
- Pill-shaped badge: 20px border-radius
- Displays "Live Data" or "Sample Data"
- Cyan border and text for consistency with accent color

## Accessibility

- **Semantic HTML:** `<main>`, `<section>`, `<footer>` landmarks used throughout
- **Color Contrast:** All text meets WCAG AA minimum 4.5:1 ratio
- **Motion:** `prefers-reduced-motion` media query disables all animations for users with motion sensitivity
- **Responsive:** Fully functional at 375px width and below
- **Tabular Numerals:** Countdown digits use fixed-width monospace for alignment
