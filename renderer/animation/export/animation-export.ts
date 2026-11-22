import type { Group } from 'three/webgpu';
import { getPlayerHeadTexture } from '../../load-project/display/player-head-atlas';
import { bakeAnimation, type BakeQuality } from './animation-bake';
import { animationDatapackFiles, animationNamespace, zipAnimationDatapack } from './animation-datapack';

/** lastPath: the previous export, whose directory the save dialog opens in. expandRoot: summon root expansion. */
export type AnimationExportOptions = { name: string; folder: boolean; quality: BakeQuality; expandRoot?: boolean; lastPath?: string };

/** Saves every animation clip as a data pack (zip or folder); resolves to the saved path, or undefined when the dialog is canceled. */
export async function exportAnimationDatapack(root: Group, options: AnimationExportOptions, signal?: AbortSignal): Promise<string | undefined> {
    // Commit painted atlas pixels through the head export path, as the summon dialog does.
    for (const [uuid, objectName] of (root.userData.objectNames as Map<string, string> | undefined) ?? []) {
        if (objectName.split('[')[0].replace(/^minecraft:/, '') === 'player_head') getPlayerHeadTexture(uuid, root.userData);
    }
    const baked = await bakeAnimation(root, signal, options.quality, options.expandRoot);
    // Passenger indices are counted on one root.
    if (baked.summon.length !== 1) throw new Error('소환 명령이 여러 개로 나뉘는 프로젝트는 애니메이션을 내보낼 수 없습니다.');
    const zip = zipAnimationDatapack(animationDatapackFiles(baked, baked.summon[0], animationNamespace(options.name), options.expandRoot));
    const result = await window.ipcApi.saveDatapack(options.name, zip, options.folder, options.lastPath);
    if (!result.success && !result.canceled) throw new Error(result.error ?? '데이터팩을 저장할 수 없습니다.');
    return result.path;
}
