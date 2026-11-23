import { strToU8, zipSync } from 'fflate';
import { stringifySnbt, type SnbtValue } from '../../export/snbt';
import type { Compound } from '../../export/summon-command';
import type { BakedAnimation, BakedEntry } from './animation-bake';

// Minecraft 26.3: version.json pack_version.data_major, CommandFunction.checkCommandLineLength.
const dataFormat = 121;
const lineLimit = 2_000_000;

const identifier = (name: string) => name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
export function animationNamespace(name: string): string { return identifier(name) || 'pde'; }
/** The play/<name> function of each clip; names that are empty or taken fall back to the clip's position. */
export function clipFunctionNames(clips: string[]): string[] {
    const used = new Set<string>();
    return clips.map((clip, index) => {
        const name = identifier(clip), unique = name && !used.has(name) ? name : `clip${index}`;
        used.add(unique);
        return unique;
    });
}

/**
 * The data pack's files by path. Functions under zz/ are internal; the rest run as the summoned root entity.
 * Playing roots hold slots in pages of 8 UUIDs in storage, spread over lanes; each tick a page is one macro call reaching its roots
 * with `execute as <uuid>`, so no tick scans entities or rebuilds a list. MacroFunction keeps 8 instantiations per function, so up to
 * 8 pages per lane (1,024 roots) play without parsing. A root counts its clip tick (t) in a score and plays c<clip>/<tick>/b at the ticks with frames.
 *
 * c<clip>/<tick>/b runs as the root and holds the frame's data as literals, which the game parses once at load, and hands out
 * the entries. An animated passenger's index (i) is its rank in baked.parts.
 * Parts that never change type keep their summon order, so a run of consecutive ranks is a storage list that zz/take_t or zz/take_m
 * hands out in passenger order; any other entry is one line finding its passenger by rank, running the command or c<clip>/e/<tick>_<part>.
 * expandRoot: the summon puts the displays on sub-parents riding the root (summon root expansion), so passengers are two levels down.
 */
export function animationDatapackFiles(baked: BakedAnimation, summon: string, ns: string, expandRoot = false): Map<string, string> {
    const rt = `${ns}:rt`, anim = `${ns}:anim`;
    // Sub-parents come in summon order and carry their displays in summon order, so ranks and runs stay as without expansion.
    const riders = expandRoot ? 'on passengers on passengers' : 'on passengers';
    const files = new Map<string, string>();
    const fn = (name: string, lines: string[]) => files.set(`data/${ns}/function/${name}.mcfunction`, lines.join('\n') + '\n');
    const path = (key: string) => /^[A-Za-z0-9_]+$/.test(key) ? key : JSON.stringify(key);
    const floats = new Map<number, string>();
    const snbt = (value: Compound) => stringifySnbt(value, floats);
    const names = clipFunctionNames(baked.clips.map(clip => clip.name));
    const rank = new Map(baked.parts.map((part, position) => [part, position]));
    // A new entity rides last, so a part that changes type leaves the summon order.
    const swapping = new Set(baked.parts.filter(part => baked.clips.some(clip => clip.frames.some(frame => frame.get(part)?.k))));
    let swaps = false;

    // The commands applying one entry to its passenger, and its merged keys. The type swap comes last: it kills the old entity.
    // durations: the interpolation_duration each part was last sent in this clip. The entity saves it, so it is not sent again.
    const actions = (entry: BakedEntry, index: number, name: string, durations: Map<number, SnbtValue>): { merged: Compound; lines: string[] } => {
        const merged: Compound = { ...entry.m };
        if (merged.interpolation_duration !== undefined && merged.interpolation_duration === durations.get(index)) delete merged.interpolation_duration;
        if (entry.k) durations.delete(index);
        else if (entry.m?.interpolation_duration !== undefined) durations.set(index, entry.m.interpolation_duration);
        // Both commands save and reload the whole entity; merge also copies and compares it. m has no partial compounds, so set equals merge.
        const keys = Object.keys(merged);
        const lines = [...entry.it ? [`item replace entity @s contents with ${entry.it}`] : [],
            ...Object.entries(entry.s ?? {}).map(([key, value]) => `data modify entity @s ${path(key)} set value ${stringifySnbt(value, floats)}`),
            ...Object.keys(entry.d ?? {}).map(key => `data remove entity @s ${path(key)}`),
            ...keys.length === 1 ? [`data modify entity @s ${path(keys[0])} set value ${stringifySnbt(merged[keys[0]], floats)}`]
                : keys.length ? [`data merge entity @s ${snbt(merged)}`] : []];
        if (entry.k) {
            swaps = true;
            // An entity cannot change type: a new one takes over the index and the seat, then the old one is removed.
            // The seat's UUID goes to u.u: the root reads it from its slot; a sub-parent has none, so zz/uuid converts its UUID.
            fn(`${name}_new`, [`data merge entity @s ${snbt(entry.f ?? {})}`, `scoreboard players set @s ${ns}.i ${rank.get(index)}`, `function ${ns}:zz/ride with storage ${rt} u`]);
            lines.push(`execute unless entity @s[type=${entry.k}] on vehicle run function ${ns}:zz/${expandRoot ? 'uuid' : 'self'}`);
            lines.push(`execute unless entity @s[type=${entry.k}] at @s summon ${entry.k} run function ${ns}:${name}_new`, `execute unless entity @s[type=${entry.k}] run kill @s`);
        }
        return { merged, lines };
    };
    const head = `data modify storage ${rt} q set value [`;
    // A line per entry checks every passenger for its rank; a run's storage list checks them once, but each entry it hands out
    // costs about 18 checks more (measured on a 26.3 server: 4 passengers favor lines, 20 the list). Unknown passengers: always a list.
    // shortcut: 18 was measured with the older four-line zz/take, so small models may use lines where a list is now cheaper; measure again to tune.
    const listed = (size: number) => baked.passengers === undefined || (size - 1) * baked.passengers >= 18 * size;
    // An 8-way tree of score ranges, run as the root: the key in `score` runs `leaf(key)`.
    const tree = (name: string, score: string, keys: number[], leaf: (key: number) => string): void => {
        if (keys.length <= 8) return void fn(name, keys.map(key => `execute if score @s ${score} matches ${key} run return run function ${leaf(key)}`));
        const size = Math.ceil(keys.length / 8);
        fn(name, Array.from({ length: Math.ceil(keys.length / size) }, (_, part) => {
            const group = keys.slice(part * size, part * size + size);
            tree(`${name}/${part}`, score, group, leaf);
            return `execute if score @s ${score} matches ${group[0]}..${group[group.length - 1]} run return run function ${ns}:${name}/${part}`;
        }));
    };
    baked.clips.forEach((clip, index) => {
        // The clip ends in the tick of its last frame, or after the loop delay.
        const end = clip.frames.length - 1 + (clip.loopMode === 'loop' ? clip.loopDelay : 0);
        const ticks = Array.from({ length: end + 1 }, (_, tick) => tick).filter(tick => tick === end || !!clip.frames[tick]?.size);
        // Every clip starts at tick 0, so a part's duration is known from its first entry in the clip on.
        let first: string[] = [];
        const durations = new Map<number, SnbtValue>();
        ticks.forEach(tick => {
            // queued: [rank, merged, its line] of entries that only merge on parts in summon order, by rank; single: the other entries' lines.
            const queued: [number, Compound, string][] = [], single: string[] = [];
            for (const [part, entry] of [...clip.frames[tick] ?? []].sort(([a], [b]) => a - b)) {
                const name = `c${index}/e/${tick}_${part}`, { merged, lines } = actions(entry, part, name, durations), at = rank.get(part)!;
                if (!lines.length) continue;
                const line = `execute ${riders} if score @s ${ns}.i matches ${at} run ${lines.length > 1 ? `function ${ns}:${name}` : lines[0]}`;
                if (!swapping.has(part) && !entry.it && !entry.s && !entry.d) {
                    queued.push([at, merged, line]);
                    continue;
                }
                if (lines.length > 1) fn(name, lines);
                single.push(line);
            }
            const show: string[] = [];
            for (let start = 0; start < queued.length;) {
                let stop = start + 1;
                while (stop < queued.length && queued[stop][0] === queued[stop - 1][0] + 1) stop++;
                const run = queued.slice(start, stop);
                start = stop;
                if (!listed(run.length)) {
                    show.push(...run.map(([, , line]) => line));
                    continue;
                }
                // zz/take_t sets lone transformations; set skips merge's copy and compare of the whole entity NBT.
                const lone = run.every(([, merged]) => Object.keys(merged).length === 1 && merged.transformation !== undefined);
                const values = run.map(([, merged]) => snbt(lone ? { t: merged.transformation! } : merged));
                // Each list stays within the line limit and is taken from its end, lowest rank first.
                for (let from = 0; from < values.length;) {
                    let to = from + 1, length = head.length + values[from].length + 1;
                    while (to < values.length && length + values[to].length + 1 <= lineLimit) length += values[to++].length + 1;
                    show.push(head + values.slice(from, to).reverse().join(',') + ']',
                        `execute ${riders} if score @s ${ns}.i matches ${run[from][0]}..${run[to - 1][0]} run function ${ns}:zz/take_${lone ? 't' : 'm'}`);
                    from = to;
                }
            }
            show.push(...single);
            if (!tick) first = show;
            // A loop starts again at clip tick 0 the next tick; once shows tick 0 again before it stops.
            fn(`c${index}/${tick}/b`, [...show, ...tick < end ? [] : clip.loopMode === 'loop' ? [`scoreboard players set @s ${ns}.t -1`]
                : [...clip.loopMode === 'once' ? first : [], `function ${ns}:zz/stop`]]);
        });
        tree(`c${index}/d`, `${ns}.t`, ticks, tick => `${ns}:c${index}/${tick}/b`);
    });
    for (const text of files.values()) if (text.split('\n').some(line => line.length > lineLimit)) throw new Error('한 디스플레이의 프레임 데이터가 mcfunction 한 줄 제한(2,000,000자)을 넘습니다.');
    // Roots numbered by another export of this pack stop (zz/step) and are numbered again when played (zz/p<clip>).
    let stamp = 0;
    for (const text of files.values()) for (let index = 0; index < text.length; index++) stamp = Math.imul(stamp ^ text.charCodeAt(index), 16777619);
    // Slot k is slot k % 8 of page k / 8; pages go to the lanes in turn, so 16 lanes keep 1,024 roots parsed.
    const lanes = 16, slots = 8, empty = '00000000-0000-0000-0000-000000000000';
    const laneIds = Array.from({ length: lanes }, (_, lane) => lane), slotIds = Array.from({ length: slots }, (_, slot) => slot);
    fn('load', [...['t', 'c', 'i', 'v', 'm', 's'].map(id => `scoreboard objectives add ${ns}.${id} dummy`), `scoreboard players set #256 ${ns}.m 256`,
        `scoreboard players set #8 ${ns}.m ${slots}`, `scoreboard players set #lanes ${ns}.m ${lanes}`,
        // #n: slots handed out, #live: roots holding one, #c: the next page to sweep. They describe the pages in storage, so a reload keeps them.
        ...['#n', '#live', '#c'].map(name => `scoreboard players add ${name} ${ns}.m 0`),
        // zz/check frees a slot whose UUID has no entity and no score; the empty UUID's score keeps empty slots out.
        `scoreboard players set ${empty} ${ns}.s 0`,
        `data modify storage ${rt} hex set value [${Array.from({ length: 256 }, (_, value) => `"${value.toString(16).padStart(2, '0')}"`).join(',')}]`,
        // The animated passenger indices, lowest last, for zz/init.
        `data modify storage ${anim} a set value [${[-1, ...[...baked.parts].sort((a, b) => b - a)].join(',')}]`,
        // shortcut: clears only as many frame lists of the oldest storage format as this export has clips, and the playing and waiting lists of older formats; drop once old packs are gone.
        ...baked.clips.map((_, index) => `data remove storage ${anim} c${index}`), ...['run', 'wait', 'f', ...laneIds.map(lane => `p${lane}`)].map(list => `data remove storage ${rt} ${list}`),
        `scoreboard players set #v ${ns}.v ${stamp}`,
        // A disabled pack loses its scheduled sweep.
        `execute if score #live ${ns}.m matches 1.. run schedule function ${ns}:zz/sweep 20t`]);

    // g<lane>: the lane's pages, each {a0..a7: UUID}. They change only when a root takes or frees a slot.
    // An unloaded root keeps its scores (only Scoreboard.entityRemoved drops them), so it keeps its slot and waits where it was.
    fn('tick', laneIds.map(lane => `execute if data storage ${rt} g${lane}[0] run function ${ns}:zz/l${lane}/0`));
    for (const lane of laneIds) {
        fn(`zz/l${lane}/0`, [`data modify storage ${rt} w set from storage ${rt} g${lane}`, `function ${ns}:zz/l${lane}/1`]);
        fn(`zz/l${lane}/1`, [`function ${ns}:zz/s${lane} with storage ${rt} w[-1]`, `data remove storage ${rt} w[-1]`, `execute if data storage ${rt} w[0] run function ${ns}:zz/l${lane}/1`]);
        fn(`zz/s${lane}`, slotIds.map(slot => `$execute as $(a${slot}) run function ${ns}:zz/step`));
    }
    // #k's lane, page and slot, in x for the macros that reach it.
    fn('zz/locate', [`scoreboard players operation #s ${ns}.m = #k ${ns}.m`, `scoreboard players operation #s ${ns}.m %= #8 ${ns}.m`,
        `execute store result storage ${rt} x.s int 1 run scoreboard players get #s ${ns}.m`,
        `scoreboard players operation #g ${ns}.m = #k ${ns}.m`, `scoreboard players operation #g ${ns}.m /= #8 ${ns}.m`,
        `scoreboard players operation #l ${ns}.m = #g ${ns}.m`, `scoreboard players operation #l ${ns}.m %= #lanes ${ns}.m`,
        `execute store result storage ${rt} x.l int 1 run scoreboard players get #l ${ns}.m`,
        `scoreboard players operation #g ${ns}.m /= #lanes ${ns}.m`, `execute store result storage ${rt} x.g int 1 run scoreboard players get #g ${ns}.m`]);
    // A root takes a freed slot (o), or the next one, which may start a page. `return run function` ends the caller only if the function returns.
    fn('zz/claim', [`execute if data storage ${rt} o[0] run return run function ${ns}:zz/reuse`, `function ${ns}:zz/grow`]);
    fn('zz/reuse', [`execute store result score #k ${ns}.m run data get storage ${rt} o[-1]`, `data remove storage ${rt} o[-1]`, `function ${ns}:zz/locate`, 'return 1']);
    fn('zz/grow', [`scoreboard players operation #k ${ns}.m = #n ${ns}.m`, `scoreboard players add #n ${ns}.m 1`, `function ${ns}:zz/locate`,
        `execute if score #s ${ns}.m matches 0 run function ${ns}:zz/page with storage ${rt} x`]);
    fn('zz/page', [`$data modify storage ${rt} g$(l) append value {${slotIds.map(slot => `a${slot}:"${empty}"`).join(',')}}`]);
    fn('zz/put', [`$data modify storage ${rt} g$(l)[$(g)].a$(s) set value "$(u)"`]);
    // Freeing slot #k; with no root left the pages go, so an idle tick only checks the lanes.
    fn('zz/leave', [`scoreboard players operation #k ${ns}.m = @s ${ns}.s`, `scoreboard players reset @s ${ns}.s`, `function ${ns}:zz/release`]);
    fn('zz/release', [`function ${ns}:zz/locate`, `function ${ns}:zz/clear with storage ${rt} x`, `data modify storage ${rt} o append value 0`,
        `execute store result storage ${rt} o[-1] int 1 run scoreboard players get #k ${ns}.m`, `scoreboard players remove #live ${ns}.m 1`,
        `execute if score #live ${ns}.m matches ..0 run function ${ns}:zz/reset`]);
    fn('zz/clear', [`$data modify storage ${rt} g$(l)[$(g)].a$(s) set value "${empty}"`]);
    fn('zz/reset', [...laneIds.map(lane => `data remove storage ${rt} g${lane}`), `data remove storage ${rt} o`, `scoreboard players set #n ${ns}.m 0`, `scoreboard players set #c ${ns}.m 0`]);
    // A killed root cannot free its slot: once a second one page is checked for UUIDs with no entity and no score.
    fn('zz/sweep', [`execute if score #live ${ns}.m matches ..0 run return 0`, `scoreboard players operation #p ${ns}.m = #n ${ns}.m`, `scoreboard players add #p ${ns}.m ${slots - 1}`,
        `scoreboard players operation #p ${ns}.m /= #8 ${ns}.m`, `execute if score #c ${ns}.m >= #p ${ns}.m run scoreboard players set #c ${ns}.m 0`,
        `scoreboard players operation #k ${ns}.m = #c ${ns}.m`, `scoreboard players operation #k ${ns}.m *= #8 ${ns}.m`, `scoreboard players operation #base ${ns}.m = #k ${ns}.m`,
        `scoreboard players add #c ${ns}.m 1`, `function ${ns}:zz/locate`, `function ${ns}:zz/sweep_page with storage ${rt} x`,
        `execute if score #live ${ns}.m matches 1.. run schedule function ${ns}:zz/sweep 20t`]);
    fn('zz/sweep_page', [`$function ${ns}:zz/check with storage ${rt} g$(l)[$(g)]`]);
    fn('zz/check', slotIds.map(slot => `$execute unless entity $(a${slot}) unless score $(a${slot}) ${ns}.s matches 0.. run function ${ns}:zz/drop {i:${slot}}`));
    fn('zz/drop', [`$scoreboard players set #k ${ns}.m $(i)`, `scoreboard players operation #k ${ns}.m += #base ${ns}.m`, `function ${ns}:zz/release`]);
    // One clip tick of a playing root (c: its clip, -1 when stopped).
    const clips = baked.clips.map((_, index) => index);
    if (clips.length > 8) tree('zz/clip', `${ns}.c`, clips, index => `${ns}:c${index}/d`);
    fn('zz/step', [`execute unless score @s ${ns}.v = #v ${ns}.v run function ${ns}:zz/stop`, `scoreboard players add @s ${ns}.t 1`,
        ...clips.length > 8 ? [`function ${ns}:zz/clip`] : clips.map(index => `execute if score @s ${ns}.c matches ${index} run function ${ns}:c${index}/d`),
        `execute unless score @s ${ns}.c matches 0.. run function ${ns}:zz/leave`]);
    // A run's passengers come in rank order, so each takes the next entry.
    // shortcut: a part removed alone during playback shifts the rest of its run, re-summon the model to recover.
    for (const [kind, line] of [['t', `data modify entity @s transformation set from storage ${rt} q[-1].t`], ['m', `data modify entity @s {} merge from storage ${rt} q[-1]`]]) {
        fn(`zz/take_${kind}`, [line, `data remove storage ${rt} q[-1]`]);
    }
    if (swaps) {
        fn('zz/ride', ['$ride @s mount $(u)']);
        fn('zz/self', [`scoreboard players operation #k ${ns}.m = @s ${ns}.s`, `function ${ns}:zz/locate`, `function ${ns}:zz/read with storage ${rt} x`]);
        fn('zz/read', [`$data modify storage ${rt} u.u set from storage ${rt} g$(l)[$(g)].a$(s)`]);
    }

    // The root's UUID as a selector string: each int splits into four bytes, each byte looks up two hex digits.
    const uuid = [`data modify storage ${rt} u.s set from entity @s UUID`];
    for (let word = 0; word < 4; word++) {
        uuid.push(`execute store result score #v ${ns}.m run data get storage ${rt} u.s[${word}]`);
        for (let byte = 3; byte >= 0; byte--) uuid.push(`scoreboard players operation #b ${ns}.m = #v ${ns}.m`,
            `scoreboard players operation #b ${ns}.m %= #256 ${ns}.m`,
            `execute store result storage ${rt} u.b${word * 4 + byte} int 1 run scoreboard players get #b ${ns}.m`,
            // Dividing a multiple of 256 is exact, so a negative word cannot round the next byte (seen in game: 9ae2 became 9be2).
            `scoreboard players operation #v ${ns}.m -= #b ${ns}.m`, `scoreboard players operation #v ${ns}.m /= #256 ${ns}.m`);
    }
    const bytes = Array.from({ length: 16 }, (_, index) => index);
    fn('zz/uuid', [...uuid, `function ${ns}:zz/hex with storage ${rt} u`, `function ${ns}:zz/join with storage ${rt} u`]);
    fn('zz/hex', bytes.map(index => `$data modify storage ${rt} u.h${index} set from storage ${rt} hex[$(b${index})]`));
    fn('zz/join', [`$data modify storage ${rt} u.u set value "${bytes.map(index => `$(h${index})${[3, 5, 7, 9].includes(index) ? '-' : ''}`).join('')}"`]);
    // Parts are found by summon order, so they are numbered before anything is replaced: #p counts the passengers,
    // #h is the next animated passenger's place and #r its rank.
    fn('zz/init', [`execute ${riders} run scoreboard players reset @s ${ns}.i`, `scoreboard players set #p ${ns}.i 0`, `scoreboard players set #r ${ns}.i 0`,
        `data modify storage ${rt} n set from storage ${anim} a`, `execute store result score #h ${ns}.i run data get storage ${rt} n[-1]`,
        `execute ${riders} run function ${ns}:zz/number`, `scoreboard players operation @s ${ns}.v = #v ${ns}.v`]);
    fn('zz/number', [`execute if score #p ${ns}.i = #h ${ns}.i run function ${ns}:zz/own`, `scoreboard players add #p ${ns}.i 1`]);
    fn('zz/own', [`scoreboard players operation @s ${ns}.i = #r ${ns}.i`, `scoreboard players add #r ${ns}.i 1`, `data remove storage ${rt} n[-1]`,
        `execute store result score #h ${ns}.i run data get storage ${rt} n[-1]`]);

    fn('summon', [summon]);
    // Parts stand where the root stands, so `@n[type=...]` often picks a part; ns:part (rides something, carries nothing) sends it to the root.
    const properties = (predicate: object) => ({ type: 'minecraft:entity_properties', entity: 'this', predicate });
    files.set(`data/${ns}/predicate/part.json`, JSON.stringify({ type: 'minecraft:all_of', terms: [properties({ 'minecraft:vehicle': {} }),
        { type: 'minecraft:inverted', term: properties({ 'minecraft:passenger': {} }) }] }));
    // With expansion, ns:root (carries a passenger that carries one) tells the root from a sub-parent; anything else carrying is a sub-parent.
    if (expandRoot) files.set(`data/${ns}/predicate/root.json`, JSON.stringify(properties({ 'minecraft:passenger': { 'minecraft:passenger': {} } })));
    const onRoot = (body: string, condition = '') => expandRoot
        ? [`execute if predicate ${ns}:part on vehicle on vehicle${condition} run function ${ns}:${body}`,
            `execute unless predicate ${ns}:part unless predicate ${ns}:root on vehicle${condition} run function ${ns}:${body}`,
            `execute if predicate ${ns}:root${condition} run function ${ns}:${body}`]
        : [`execute if predicate ${ns}:part on vehicle${condition} run function ${ns}:${body}`,
            `execute unless predicate ${ns}:part${condition} run function ${ns}:${body}`];
    // A root first played, or numbered by another export of this pack, is numbered here. Its first frame is the next tick.
    names.forEach((name, index) => {
        fn(`play/${name}`, onRoot(`zz/p${index}`));
        fn(`zz/p${index}`, [`execute unless score @s ${ns}.v = #v ${ns}.v run function ${ns}:zz/init`, `execute unless score @s ${ns}.s matches 0.. run function ${ns}:zz/add`,
            `scoreboard players set @s ${ns}.c ${index}`, `scoreboard players set @s ${ns}.t -1`, `tag @s add ${ns}.on`]);
    });
    // s: the root's slot until zz/step frees it, so playing again, or right after stop, takes no second one.
    fn('zz/add', [`function ${ns}:zz/uuid`, `function ${ns}:zz/claim`, `data modify storage ${rt} x.u set from storage ${rt} u.u`, `function ${ns}:zz/put with storage ${rt} x`,
        `scoreboard players operation @s ${ns}.s = #k ${ns}.m`, `scoreboard players add #live ${ns}.m 1`,
        `execute if score #live ${ns}.m matches 1 run schedule function ${ns}:zz/sweep 20t`]);
    fn('stop', onRoot('zz/stop', ` if entity @s[tag=${ns}.on]`));
    fn('zz/stop', [`scoreboard players set @s ${ns}.c -1`, `tag @s remove ${ns}.on`]);
    fn('remove', onRoot('zz/remove'));
    fn('zz/remove', [`execute if score @s ${ns}.s matches 0.. run function ${ns}:zz/leave`, ...expandRoot ? [`execute ${riders} run kill @s`] : [], 'execute on passengers run kill @s', 'kill @s']);
    for (const tag of ['load', 'tick']) files.set(`data/minecraft/tags/function/${tag}.json`, JSON.stringify({ values: [`${ns}:${tag}`] }));
    files.set('pack.mcmeta', JSON.stringify({ pack: { description: `${ns} animation (PDE)`, min_format: dataFormat, max_format: dataFormat } }));
    files.set('README.txt', [`function ${ns}:summon — 모델 소환`, '아래 함수는 소환된 부모 엔티티로 실행합니다 (execute as <부모> run function ...).',
        ...names.map((name, index) => `function ${ns}:play/${name} — "${baked.clips[index].name}" 재생 (엔티티마다 실행한 틱부터 따로 재생)`),
        `function ${ns}:stop — 정지`, `function ${ns}:remove — 정지 후 제거 (재생 중인 부모는 kill 대신 이 함수로 지워 주세요)`,
        '파츠가 많은 모델을 여러 개 재생하면 게임 규칙 max_command_sequence_length 를 올려야 할 수 있습니다.',
        '타입이 바뀌는 파츠가 있는 모델은 데이터팩을 다시 내보낸 뒤 다시 소환해 주세요.'].join('\n') + '\n');
    return files;
}

export function zipAnimationDatapack(files: Map<string, string>): Uint8Array {
    return zipSync(Object.fromEntries([...files].map(([name, text]) => [name, strToU8(text)])));
}
