import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from 'three/webgpu';

export type ItemModelPart = { model: any; transform: Matrix4 };

function localTransform(value: any): Matrix4 {
    if (Array.isArray(value)) return new Matrix4().fromArray(value).transpose();
    const rotation = (angles: number[] = [0, 0, 0, 1]) => angles.length === 4
        ? new Quaternion().fromArray(angles)
        : new Quaternion().setFromEuler(new Euler(...angles.map(MathUtils.degToRad) as [number, number, number], 'XYZ'));
    return new Matrix4().compose(
        new Vector3().fromArray(value?.translation ?? [0, 0, 0]),
        rotation(value?.left_rotation),
        new Vector3().fromArray(value?.scale ?? [1, 1, 1])
    ).multiply(new Matrix4().makeRotationFromQuaternion(rotation(value?.right_rotation)));
}

// Display entities are idle: using_item and other held-item conditions are false.
export function resolveItemModelParts(value: any, displayType = 'none', properties: Record<string, string> = {}, now = new Date()): ItemModelPart[] {
    const visit = (node: any, parent: Matrix4, depth: number): ItemModelPart[] => {
        if (!node || depth > 64) return [];
        if (typeof node === 'string') node = { type: 'minecraft:model', model: node };
        const transform = parent.clone().multiply(localTransform(node.transformation));
        const type = String(node.type ?? '').split(':').pop();
        if (type === 'empty') return [];
        if (type === 'composite') return (node.models ?? []).flatMap((child: any) => visit(child, transform, depth + 1));
        if (type === 'condition') return visit(node.on_false, transform, depth + 1);
        if (type === 'select' || node.block_state_property) {
            let selectedValue: string | undefined;
            if (node.property === 'minecraft:display_context') selectedValue = displayType || 'none';
            else if (node.block_state_property) selectedValue = properties[String(node.block_state_property).split(':').pop()!];
            else if (node.property === 'minecraft:local_time') {
                const fields = { yyyy: String(now.getFullYear()), MM: String(now.getMonth() + 1).padStart(2, '0'),
                    dd: String(now.getDate()).padStart(2, '0'), HH: String(now.getHours()).padStart(2, '0'),
                    mm: String(now.getMinutes()).padStart(2, '0'), ss: String(now.getSeconds()).padStart(2, '0') };
                selectedValue = String(node.pattern ?? '').replace(/yyyy|MM|dd|HH|mm|ss/g, key => fields[key]);
            }
            const selected = (node.cases ?? []).find((entry: any) =>
                (Array.isArray(entry.when) ? entry.when : [entry.when]).some((when: any) => String(when) === selectedValue));
            return visit(selected?.model ?? node.fallback, transform, depth + 1);
        }
        if (type === 'range_dispatch') {
            // ponytail: idle numeric properties use zero; world-time/component previews need runtime context.
            const selected = (node.entries ?? []).filter((entry: any) => Number(entry.threshold) <= 0)
                .sort((a: any, b: any) => Number(b.threshold) - Number(a.threshold))[0];
            return visit(selected?.model ?? node.fallback, transform, depth + 1);
        }
        return typeof node.model === 'string' || typeof node.base === 'string' ? [{ model: node, transform }] : [];
    };
    return visit(value, new Matrix4(), 0);
}
