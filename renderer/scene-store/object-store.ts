type SlotRef = { mesh: object; instanceId: number };

// Packed slot = batch index * idSpan + instance id; both stay within safe integers.
const idSpan = 2 ** 24;
const meshSpan = 2 ** 29;

/**
 * The project's object table (root.userData.objectUuidToInstance): uuid → slot { mesh, instanceId }, and the
 * reverse slot → uuid. A Map by uuid, so the forward side reads like one.
 * - Slots are packed into one number (mesh index * 2^24 + instance id); get() returns a new object on every
 *   call, so writers replace values rather than mutate them. Values with other properties or ids past 24 bits
 *   keep the plain Map storage.
 * - The reverse side follows every write. A write clears a slot only while it still names that uuid, so two
 *   objects can trade slots in either order.
 * Iterates packed entries first, then the others.
 */
export class ObjectStore<R extends SlotRef = SlotRef> extends Map<string, R> {
    private packed = new Map<string, number>();
    private meshes: (object | undefined)[] = [];
    private meshSlots = new Map<object, number>();
    private meshUses: number[] = [];
    private freeSlots: number[] = [];
    /** Slot → uuid, one array per mesh. */
    private owners = new Map<object, (string | undefined)[]>();

    constructor(entries?: Iterable<readonly [string, R]> | null) {
        // Map's constructor would call set() before the fields exist.
        super();
        if (entries) for (const [key, value] of entries) this.set(key, value);
    }

    /** The uuid of the object in a slot. */
    uuidAt(mesh: object, instanceId: number): string | undefined {
        return this.owners.get(mesh)?.[instanceId];
    }

    /** Records that the object in slot `from` moved to slot `to` of the same mesh, as a swap-remove does. */
    moveSlot(mesh: object, from: number, to: number): void {
        const uuid = this.uuidAt(mesh, from);
        if (uuid) this.set(uuid, { mesh, instanceId: to } as R);
    }

    private setOwner(ref: SlotRef, uuid: string): void {
        let owners = this.owners.get(ref.mesh);
        if (!owners) this.owners.set(ref.mesh, owners = []);
        owners[ref.instanceId] = uuid;
    }

    private clearOwner(ref: SlotRef | undefined, uuid: string): void {
        const owners = ref && this.owners.get(ref.mesh);
        if (!owners || owners[ref.instanceId] !== uuid) return;
        owners[ref.instanceId] = undefined;
        while (owners.length && owners[owners.length - 1] === undefined) owners.pop();
        if (!owners.length) this.owners.delete(ref.mesh);
    }

    private release(value: number): void {
        const slot = Math.floor(value / idSpan);
        if (--this.meshUses[slot]) return;
        this.meshSlots.delete(this.meshes[slot]!);
        this.meshes[slot] = undefined;
        this.freeSlots.push(slot);
    }

    private pack(ref: R): number | undefined {
        if (!ref || typeof ref.mesh !== 'object' || ref.mesh === null || !Number.isInteger(ref.instanceId)
            || ref.instanceId < 0 || ref.instanceId >= idSpan) return undefined;
        let keys = 0;
        for (const key in ref) if (++keys > 2 || (key !== 'mesh' && key !== 'instanceId')) return undefined;
        let slot = this.meshSlots.get(ref.mesh);
        if (slot === undefined) {
            slot = this.freeSlots.pop() ?? this.meshes.length;
            if (slot >= meshSpan) return undefined;
            this.meshes[slot] = ref.mesh;
            this.meshSlots.set(ref.mesh, slot);
            this.meshUses[slot] = 0;
        }
        this.meshUses[slot]++;
        return slot * idSpan + ref.instanceId;
    }

    private unpack(value: number): R {
        return { mesh: this.meshes[Math.floor(value / idSpan)], instanceId: value % idSpan } as R;
    }

    get(key: string): R | undefined {
        const value = this.packed.get(key);
        return value === undefined ? super.get(key) : this.unpack(value);
    }

    has(key: string): boolean {
        return this.packed.has(key) || super.has(key);
    }

    set(key: string, ref: R): this {
        this.clearOwner(this.get(key), key);
        const value = this.pack(ref);
        const previous = this.packed.get(key);
        if (previous !== undefined) this.release(previous);
        if (value === undefined) {
            this.packed.delete(key);
            super.set(key, ref);
        } else {
            super.delete(key);
            this.packed.set(key, value);
        }
        if (ref && typeof ref.mesh === 'object' && ref.mesh !== null && Number.isInteger(ref.instanceId) && ref.instanceId >= 0) this.setOwner(ref, key);
        return this;
    }

    delete(key: string): boolean {
        this.clearOwner(this.get(key), key);
        const value = this.packed.get(key);
        if (value === undefined) return super.delete(key);
        this.release(value);
        return this.packed.delete(key);
    }

    clear(): void {
        this.packed.clear();
        this.meshes = [];
        this.meshSlots.clear();
        this.meshUses = [];
        this.freeSlots = [];
        this.owners.clear();
        super.clear();
    }

    private *pairs(): Generator<[string, R]> {
        for (const [key, value] of this.packed) yield [key, this.unpack(value)];
        yield* super.entries();
    }

    entries() { return this.pairs() as never; }
    keys() { return (function* (pairs) { for (const [key] of pairs) yield key; })(this.pairs()) as never; }
    values() { return (function* (pairs) { for (const [, value] of pairs) yield value; })(this.pairs()) as never; }
    [Symbol.iterator]() { return this.pairs() as never; }

    forEach(callback: (value: R, key: string, map: Map<string, R>) => void, thisArg?: unknown): void {
        for (const [key, value] of this.pairs()) callback.call(thisArg, value, key, this);
    }

    get refSize(): number { return this.packed.size + super.size; }
}

// `size` is an accessor on Map.prototype; TypeScript types it as a property, so it is overridden here.
Object.defineProperty(ObjectStore.prototype, 'size', { get(this: ObjectStore) { return this.refSize; } });
