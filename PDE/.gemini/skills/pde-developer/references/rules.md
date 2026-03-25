# Core Technical Rules & Standards

## Technology Stack
- **Three.js**: Version r183+ is mandatory.
- **TypeScript**: Strict type definitions and interface usage are required. No `any` unless absolutely necessary.
- **WebGPU**: The project is built on WebGPU.

## Essential Implementation Details
- **TransformControls**: When using `TransformControls`, you MUST call `scene.add(controls.getHelper())` to ensure the helper is added to the scene.
- **Separation of Concerns (SoC)**: Strictly adhere to the project structure. Do not mix logic between `renderer/`, `controls/`, and `ui/`.

## Coding Style
- **Variables/Functions**: `camelCase`
- **File Names**: `kebab-case`
- **Response Format**: Prioritize working code over explanations. Show only changed parts clearly.
