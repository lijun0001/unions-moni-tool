## ADDED Requirements

### Requirement: Topology and list view toggle

The JX pile simulator toolbar SHALL provide a segmented control (or equivalent) to switch between **topology** and **list** board views. Exactly one view MUST be visible at a time.

#### Scenario: Switch to list view

- **WHEN** user selects「列表」in the view toggle
- **THEN** the topology canvas MUST hide and the list layout MUST show

#### Scenario: Switch back to topology

- **WHEN** user selects「拓扑」in the view toggle
- **THEN** the list layout MUST hide and the topology canvas MUST show with state preserved

### Requirement: View mode persistence

The selected board view mode SHALL persist across plugin sessions via localStorage (key e.g. `jx-board-view-mode`). Default MUST be `topology` when no saved preference exists.

#### Scenario: Reopen plugin

- **WHEN** user previously selected list view and reopens the JX pile simulator plugin
- **THEN** list view MUST be restored automatically

### Requirement: List view left pile rail

In list view, the left panel (~240–280px) SHALL display a scrollable list of pile cards for all `visiblePiles` (same filter rules as topology: protocol, keyword, device type, max 10 visible with fold hint).

Each card MUST show: pile ID, online state indicator, gun count badge, and optional summary (e.g. charging gun count). Selected pile MUST be visually highlighted.

#### Scenario: Select pile from list

- **WHEN** user clicks a pile card in list view
- **THEN** `activePileId` MUST update to that pile and the right detail panel MUST show that pile's guns

#### Scenario: Empty pile list

- **WHEN** no piles match filters
- **THEN** the left rail MUST show an empty state with guidance to add a pile

### Requirement: List view right gun detail panel

The right panel SHALL display the selected pile's gun positions in a non-overlapping layout (2×2 grid for 3–4 guns). It MUST include gun labels, status pills, vehicles (virtual/linked), VIN popover, start-control entry, and charging HUD—reusing the same handlers as topology view.

#### Scenario: Four guns in list detail

- **WHEN** the selected pile has 4 guns in list view
- **THEN** all four gun/vehicle slots MUST be visible without overlap in the right panel

#### Scenario: Car interaction in list view

- **WHEN** user clicks a virtual car in list view right panel
- **THEN** VIN entry popover MUST appear and confirm behavior MUST match topology view

### Requirement: Drawer integration in list view

Selecting a pile in list view MUST open the existing side drawer (`jx-panel`) with the same four tabs (基本信息 / 桩控制 / 订单 / 日志). In list view, drawer horizontal position MUST be fixed to the right edge (not computed from pile column index).

#### Scenario: Drawer does not obscure list detail

- **WHEN** drawer is open in list view
- **THEN** the right gun detail panel MUST remain usable or the layout MUST reserve space so primary gun actions are not fully obscured

### Requirement: Shared selection across view modes

`activePileId` MUST be shared between topology and list views. Switching views MUST NOT clear the active pile unless that pile is no longer in `visiblePiles`.

#### Scenario: Preserve selection on toggle

- **WHEN** user has pile B selected in topology view and switches to list view
- **THEN** pile B MUST remain selected in the left rail and right detail panel

### Requirement: Add pile from list view

The add-pile action MUST be available in list view (bottom of left rail or equivalent) and MUST behave identically to topology view's add button.

#### Scenario: Add pile in list mode

- **WHEN** user adds a new pile while in list view
- **THEN** the new pile MUST appear in the left rail and be selectable

### Requirement: List view pile quick actions

Pile cards or the right panel header MUST expose: offline link-login trigger (or equivalent to topology link icon), tariff popover (¥), and double-click login on offline piles—matching topology semantics.

#### Scenario: Login from list card

- **WHEN** user double-clicks an offline pile card
- **THEN** login-auth flow MUST initiate as in topology double-click on pile
