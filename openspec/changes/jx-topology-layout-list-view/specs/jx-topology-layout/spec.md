## ADDED Requirements

### Requirement: Dynamic pile column width by gun count

The topology board SHALL compute each pile column width from that pile's gun count instead of equal `1fr` distribution. Column width MUST prevent gun cluster content from exceeding the pile column bounding box for 1–4 guns per pile.

#### Scenario: Four guns on one pile

- **WHEN** a pile has 4 guns and topology view is active
- **THEN** the pile column width MUST accommodate a 2×2 gun grid without horizontal overflow into adjacent pile columns

#### Scenario: Mixed gun counts across piles

- **WHEN** multiple piles are visible with different gun counts (e.g. 2, 2, 4, 4)
- **THEN** each pile column MUST use its own computed width and gun clusters MUST NOT overlap neighboring columns

### Requirement: Multi-row gun grid for three or more guns

When a pile has 3 or 4 guns in topology view, the gun list SHALL render as a 2-column grid (2×2 maximum). Piles with 1–2 guns MAY remain a single horizontal row.

#### Scenario: Three guns layout

- **WHEN** a pile has 3 guns in topology view
- **THEN** guns SHALL display in a 2-column grid with the third gun on the second row

#### Scenario: Four guns layout

- **WHEN** a pile has 4 guns in topology view
- **THEN** guns SHALL display in a 2×2 grid

### Requirement: Horizontal scroll for wide topology

When total topology content width exceeds the board viewport, the board SHALL enable horizontal scrolling. The protocol root label MAY remain visually centered while pile columns scroll.

#### Scenario: Many piles cause overflow

- **WHEN** the sum of pile column widths exceeds `jx-board` client width
- **THEN** the user MUST be able to scroll horizontally to reach all piles and guns

### Requirement: Compact gun node sizing for dense piles

When a pile has 3 or 4 guns in topology view, gun node width SHALL reduce from the default (e.g. 100px to 80px) to improve fit within the column.

#### Scenario: Dense pile uses compact nodes

- **WHEN** a pile has ≥3 guns
- **THEN** gun row/cell width MUST use the compact sizing token

### Requirement: Pile side info positioned within column

Pile ID, tariff icon, and link indicator SHALL be positioned relative to the pile column (not overlapping adjacent columns' gun areas).

#### Scenario: Four-gun pile with side metadata

- **WHEN** a pile has 4 guns and displays left-side pile metadata
- **THEN** metadata MUST NOT overlap gun or vehicle elements of an adjacent pile

### Requirement: Multi-row branch wiring

For piles with more than 2 guns in topology view, connector lines SHALL use a branch pattern: vertical drop from pile → horizontal bus spanning gun columns → vertical drop to each gun.

#### Scenario: Four-gun wiring

- **WHEN** a pile has 4 guns in topology view
- **THEN** each gun MUST have an individual vertical connector from a shared horizontal branch line

### Requirement: Topology interaction parity

All existing topology interactions MUST remain functional after layout changes: pile click/double-click, tariff popover, link login, add/remove pile, car click (VIN / start control), charging HUD, and QR launch icon.

#### Scenario: Start control from topology car

- **WHEN** user clicks a linked car icon in topology view after layout fix
- **THEN** the start control or charging info dialog MUST open as before the layout change
