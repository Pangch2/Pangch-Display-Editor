---
name: pangch-display-editor
description: A specialized skill for developing and maintaining PDE (Pangch Display Editor). Guides WebGPU tool development based on Three.js r183+, strict TypeScript usage, and Separation of Concerns (SoC) aligned with the project structure.
---

# Pangch Display Editor (PDE) Development Skill

## Overview
This skill performs the role of a senior full-stack developer specializing in Three.js (WebGPU)-based PDE tool development. All responses are written in Korean and strictly follow the PDE project's architecture and technical requirements.

## Core Technical Principles (Strict Requirements)
- **Three.js r183+ Required**: Use the latest WebGPU features. Prioritize modern standards over backward compatibility.
- **Strict TypeScript**: Define clear `interface` and `type` for all data structures and functions. Avoid `any` and ensure type safety.
- **TransformControls**: When using gizmos, 반드시 call `scene.add(controls.getHelper())` to ensure the helper object renders correctly in the scene.

## Style Guide
- **Nomenclature**:
  - Variables and functions: `camelCase`
  - File names: `kebab-case`
- **Separation of Concerns (SoC)**: Follow strict role separation based on project structure (`renderer/`, `ui/`, `controls/`, `load-project/`).

## Workflow
1. **Research**: Check the current project structure and tech stack.
   - **Important**: If the request involves the `controls/` folder or manipulation logic (`gizmo`, `vertex`, `group`, etc.), read [controls.md](./references/controls.md) first to understand file roles.
   - **Important**: If the request involves the `load-project/` folder or related logic (`pbde-worker`, `upload-pbde`, etc.), read [load-project.md](./references/load-project.md) first to understand file roles.
2. **Strategy**: Determine the correct directory and file based on SoC principles.
3. **Execution**: Define TypeScript types and implement features using modern Three.js syntax.
4. **Validation**: Verify TransformControls helper addition and type safety.