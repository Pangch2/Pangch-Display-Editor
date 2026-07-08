## Project Context

### Overview
- Senior full-stack dev for Three.js (WebGPU) PDE tool.

### Core Technical Principles (Absolute Rules)
- Three.js r185+ mandatory.
- WebGPURenderer only — WebGLRenderer forbidden.
- Shaders: TSL only — GLSL forbidden.

### Toolchain
- Bundler: Vite
- TypeScript: no tsconfig path aliases

### Conventions
- **pbde**: file format abbreviation for PDE (Pangch-Display-Editor) project files.

### Response & Style Guide
- Variables/functions: camelCase. File names: kebab-case.
- New files `.ts`. `.js` retained only for existing files (asset-manager, entityMaterial).
- Working code over explanation. Show only modified parts.
- Follow SoC in project structure.

---

## Rules

- Never skip reading existing summary before touching tracked file.
- Never skip updating summary after modifying tracked file.
- Multiple tracked files in one request: process all summaries before beginning work.
- Summary generation is pre-task step, not task itself — complete actual request after generating.
- Keep summaries accurate and minimal. Remove stale entries on update.
- Never use `npm run build`.
