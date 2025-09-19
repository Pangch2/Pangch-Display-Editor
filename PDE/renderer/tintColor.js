// Utility to compute tint colors similar to Minecraft defaults

const blocksUsingDefaultGrassColors = [
  'grass_block',
  'short_grass',
  'tall_grass',
  'fern',
  'large_fern_top',
  'large_fern_bottom',
  'potted_fern',
];

const blocksUsingDefaultFoliageColors = [
  'oak_leaves',
  'jungle_leaves',
  'acacia_leaves',
  'dark_oak_leaves',
  'vine',
  'mangrove_leaves',
];

// Returns a hex color (0xRRGGBB)
export function getTextureColor(modelResourceLocation, textureLayer, tintindex) {
  try {
    const isBlockModel = modelResourceLocation.startsWith('block/');
    const modelName = modelResourceLocation.split('/').slice(1).join('/');

    if (textureLayer == null && tintindex == null) {
      return 0xffffff;
    }

    // Grass tint: for item models tint applies even without tintindex
    if (
      blocksUsingDefaultGrassColors.includes(modelName) &&
      (!isBlockModel || tintindex === 0)
    ) {
      return 0x7cbd6b;
    }

    // Foliage tint
    if (
      blocksUsingDefaultFoliageColors.includes(modelName) &&
      (!isBlockModel || tintindex === 0)
    ) {
      // net.minecraft.world.biome.FoliageColors.getDefaultColor()
      return 0x48b518;
    }

    if (modelName === 'birch_leaves' && (!isBlockModel || tintindex === 0)) {
      // net.minecraft.world.biome.FoliageColors.getBirchColor()
      return 0x80a755;
    }
    if (modelName === 'spruce_leaves' && (!isBlockModel || tintindex === 0)) {
      // net.minecraft.world.biome.FoliageColors.getSpruceColor()
      return 0x619961;
    }

    // lily_pad
    if (modelName === 'lily_pad') {
      // For block display it uses a different color than wiki item code mentions
      return 0x71c35c;
    }

    // Melon/Pumpkin stems by age
    if (/^block\/(melon|pumpkin)_stem_stage[0-7]$/.test(modelResourceLocation)) {
      const age = modelResourceLocation.slice(-1);
      switch (age) {
        case '0': return 0x00ff00;
        case '1': return 0x20f704;
        case '2': return 0x40ef08;
        case '3': return 0x60e70c;
        case '4': return 0x80df10;
        case '5': return 0xa0d714;
        case '6': return 0xc0cf18;
        case '7': return 0xe0c71c;
      }
    }

    // Attached stem
    if (
      ['block/attached_melon_stem', 'block/attached_pumpkin_stem'].includes(modelResourceLocation)
    ) {
      return 0xe0c71c;
    }

    // Redstone wire (dust) item/block default tint when face tintindex 0
    if (modelResourceLocation.startsWith('block/redstone_dust_') && tintindex === 0) {
      return 0x4b0000;
    }

    return 0xffffff;
  } catch {
    return 0xffffff;
  }
}
