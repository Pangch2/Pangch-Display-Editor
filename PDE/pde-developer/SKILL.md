---
name: pde-developer
description: Specialized development assistant for the Three.js (WebGPU) PDE tool. Use for tasks involving renderer logic, 3D controls, UI implementation, or project structure.
---

# PDE Developer Skill

## Operational Mandate: The "Three-Device" System

You are equipped with virtual "safety devices" that MUST operate for every task.

### Device 1: Pre-Start Notification (Context Analysis)
**Before** starting any work, perform this analysis.

**Protocol:**
1.  **Analyze Request**:
    -   **Keywords**: "Renderer", "Gizmo", "Select", "Group", "Vertex", "Shader"
    -   **Intent**: "Create feature", "Refactor", "Complex Fix" vs "Simple Fix", "Typo"
2.  **Load Manuals**:
    -   *3D Logic/Controls* -> `references/controls.md` + `references/rules.md`
    -   *Structure/Loading* -> `references/structure.md`
3.  **Notification**: State: "Device 1 Active: Context [Context]. Loading [Manuals]."

### Device 1.5: Major Task Protocol (The "Three-Doc Rule")
**Trigger**: If the Intent involves **New Features**, **Refactoring**, or **Changes spanning >2 files**.

**Mandatory Action**:
BEFORE writing any code, you MUST create (or update) a specification markdown file in `docs/specs/YYYY-MM-DD-[TaskName].md`. It MUST contain these three sections:

1.  **# 1. 계획서 (The Blueprint)**
    -   Detailed plan.
2.  **# 2. 맥락노트 (Context Note)**
    -   Rationale & References.
3.  **# 3. 체크리스트 (Progress Tracker)**
    -   `- [ ] Task`

### Device 2: Post-Code Verification (Safety Check)
**After** generating code, verify safety.

**Protocol:**
1.  **Verify Safety**:
    -   **Type Safety**: No `any` types? Interfaces defined?
    -   **Resource Safety**: Geometries/Materials disposed?
    -   **Logic Safety**: `scene.add(controls.getHelper())` called?

### Device 2.5: Documentation Log (History Tracking)
**Trigger**: After modifying any file.

**Mandatory Action**:
Append a brief log entry to `docs/dev-log.md`.
- **Format**: `-[YYYY-MM-DD HH:mm] Modified [File1], [File2]: [Brief Description]`

### Device 3: Final Validation (Auto Type-Check)
**Trigger**: Before declaring the task complete.

**Mandatory Action**:
1.  **Execute**: Run `npm run type-check` (or `npx tsc --noEmit` if script missing).
2.  **Analyze**: If errors exist, **DO NOT ask the user**.
3.  **Auto-Fix**: Immediately analyze the error log, fix the code, and **re-run Device 3**.
4.  **Success**: Only report completion when `type-check` passes cleanly.

---

# Reference Manuals (The "Index")

## 1. Core Rules & Standards
**File**: [`references/rules.md`](references/rules.md)
**Contents**: Three.js r183+, TypeScript strictness, WebGPU, Coding Style.

## 2. Project Structure
**File**: [`references/structure.md`](references/structure.md)
**Contents**: `renderer/` (Main), `renderer/controls/` (Logic), `ui/` (Interface).

## 3. Controls & Logic Detail
**File**: [`references/controls.md`](references/controls.md)
**Contents**: Gizmo, Grouping, Selection, Vertex Operations.
