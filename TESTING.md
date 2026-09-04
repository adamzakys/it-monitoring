# BMS IT Monitoring - Testing Scenarios

## Prerequisites
- Backend running: `npm run dev` or `./start.sh`
- WebSocket connected (green pulse dot in header)
- At least 1 device showing in the device matrix

---

## Scenario 1: Device Status Synchronization

### Test: Status Change Triggers Full UI Update

**Steps:**
1. Open Dashboard view
2. Locate a device card showing **ONLINE** (green dot + text)
3. Trigger a status change on that device (via backend/ping failure)
4. Observe all synchronized UI elements update

**Expected Results - When device goes ONLINE:**
- [ ] Status dot turns **green**
- [ ] Status text says **ONLINE**
- [ ] KPI "Online Nodes" counter **increments**
- [ ] Donut chart green segment **increments**

**Expected Results - When device goes WARNING:**
- [ ] Status dot turns **amber**
- [ ] Status text says **WARNING**
- [ ] Card border remains neutral (not red)
- [ ] KPI "Degraded / Warning" counter **increments**
- [ ] Donut chart amber segment **increases**

**Expected Results - When device goes OFFLINE:**
- [ ] Status dot turns **red**
- [ ] Status text says **OFFLINE**
- [ ] Card is still **clickable** (cursor: pointer, no pointer-events:none)
- [ ] KPI "Offline / Timeout" counter **increments**
- [ ] Donut chart red segment **increases**
- [ ] Detail modal can still be opened via "View details" link

**Expected Results - All status changes:**
- [ ] All related UI elements update **simultaneously** (no lag)
- [ ] No duplicate status logic - single source of truth
- [ ] No console errors

---

## Scenario 2: Tab Panel Independence

### Test: Each Tab Fills Full Panel Height

**Steps:**
1. Click **Incidents** tab
2. Observe: incidents list fills full sidebar height, scrollable
3. Click **Analytics** tab
4. Observe: throughput chart + donut fills full sidebar height
5. Click **Quick Stats** tab
6. Observe: quick stats list fills full sidebar height, scrollable

**Expected Results:**
- [ ] Tab switch is instant (no delay)
- [ ] Active tab fills **entire** sidebar-right area
- [ ] Tab content does not "share" height with other tabs
- [ ] Inactive tabs are hidden (`display: none`)
- [ ] No double-scrollbar issue

---

## Scenario 3: Device Card Interactions

### Test: Click, Hover, Select States

**Steps:**
1. Hover over any device card
2. Click a device card (not on "View details")
3. Click "View details" link on a card
4. Close the detail modal
5. Use severity filter buttons on device grid

**Expected Results:**
- [ ] Hover: border brightens, background elevates
- [ ] Click: card becomes "selected" (brand-colored border)
- [ ] Click: main throughput chart updates to selected device
- [ ] "View details" opens device detail modal
- [ ] Detail modal shows correct device info, status, charts
- [ ] Offline cards are **not disabled** - still clickable
- [ ] Severity filter (All/Online/Warning/Offline) works

---

## Scenario 4: Alerts Page

### Test: Incident Audit Table

**Steps:**
1. Navigate to **Alerts** via sidebar
2. Observe table with columns: Severity, Incident/Target, Node, First Seen, Duration, Status, Actions
3. Type in **Search** box
4. Click **severity filter** buttons (All/Critical/Warning/Info)
5. Click **ACK** button on an alert row

**Expected Results:**
- [ ] Table renders with proper styling (no unstyled HTML)
- [ ] Search filters results in real-time
- [ ] Severity filter works
- [ ] ACK button changes state to "ACKd" and becomes disabled
- [ ] Severity badges colored correctly (red=critical, amber=warning, green=info)
- [ ] Empty state shows "No incidents match your filter"

---

## Scenario 5: KPI Counters & Live Updates

### Test: Real-time Counter Accuracy

**Steps:**
1. Note initial KPI values: Total Devices, Online, Warning, Offline
2. Wait for WebSocket updates (or trigger status changes)
3. Compare KPI values against actual device grid count

**Expected Results:**
- [ ] KPI "Total Devices" matches device grid count
- [ ] KPI "Online Nodes" + "Warning" + "Offline" = Total Devices
- [ ] KPI values update automatically when device status changes
- [ ] No mismatch between KPI display and actual device states

---

## Scenario 6: Brand Header & Sidebar

### Test: Logo Visibility & Sidebar Balance

**Steps:**
1. Observe left sidebar brand header
2. Compare logo size with KPI section height
3. Observe navigation menu item spacing

**Expected Results:**
- [ ] BMS logo is **clearly visible and prominent**
- [ ] Logo is **not cropped or cut off**
- [ ] Sidebar width provides comfortable navigation spacing
- [ ] Navigation items have adequate padding
- [ ] No overflow or clipping

---

## Scenario 7: Panel Collapse

### Test: Right Sidebar Toggle

**Steps:**
1. Click the **collapse toggle** (arrow/chevron) on right panel header
2. Observe: sidebar collapses off-screen
3. Click **floating expand button** (appears in main viewport)
4. Observe: sidebar expands back

**Expected Results:**
- [ ] Collapse toggle works
- [ ] Main viewport gains the freed space
- [ ] Floating expand button appears when collapsed
- [ ] Expand restores panel to original width

---

## Quick Smoke Test - 2 Minutes

1. [ ] Dashboard loads with KPI cards visible
2. [ ] Device grid shows at least one device card
3. [ ] Right panel shows Incidents tab by default
4. [ ] Switching tabs (Incidents/Analytics/Quick Stats) works
5. [ ] Alerts page accessible via sidebar
6. [ ] No console errors (Error level)
7. [ ] WebSocket status shows "Connected" (green pulse)

---

## Browser Console Commands for Debugging

Run in browser DevTools Console:

```javascript
// Check current device states
console.table(state.devices.map(d => ({ id: d.id, name: d.name, status: d.status })))

// Check KPI values
console.log({
  total: document.getElementById('kpi-total')?.textContent,
  online: document.getElementById('kpi-online')?.textContent,
  warning: document.getElementById('kpi-warning')?.textContent,
  offline: document.getElementById('kpi-offline')?.textContent
})

// Force refresh KPI counters
refreshKpiCounters()

// Check alerts count
console.log('Active alerts:', state.alerts.filter(a => a.status === 'active').length)

// Test tab switching
document.querySelector('.panel-tab[data-panel-tab="analytics"]')?.click()
document.querySelector('.panel-tab[data-panel-tab="incidents"]')?.click()

// Check if tab panels are properly hidden/shown
console.log({
  incidents: document.getElementById('panel-incidents')?.classList.contains('active'),
  analytics: document.getElementById('panel-analytics')?.classList.contains('active'),
  quickstats: document.getElementById('panel-quickstats')?.classList.contains('active')
})
```

---

## Expected File Changes (Verification)

After testing, verify these files contain expected fixes:

| File | Check |
|------|-------|
| `public/css/style.css` | Contains `.panel-tab-content`, `.card-detail-top`, `.alerts-page-*` |
| `public/js/app.js` | Contains `statusTextEl` update in `updateCardTelemetry` |
| `public/index.html` | Tab structure with `panel-tab-content` divs |

Run verification:
```bash
grep -l "panel-tab-content" public/css/style.css
grep -l "card-detail-top" public/css/style.css
grep -l "statusTextEl" public/js/app.js
grep -l "alerts-page-toolbar" public/css/style.css
```
