"use strict";

/**
 * lrestore.js - State deserialization for Fengari VM
 *
 * Restores Lua VM state from a binary format created by lsave.js.
 */

const {
    constant_types: {
        LUA_TNIL,
        LUA_TBOOLEAN,
        LUA_TLIGHTUSERDATA,
        LUA_TNUMFLT,
        LUA_TNUMINT,
        LUA_TSHRSTR,
        LUA_TLNGSTR,
        LUA_TTABLE,
        LUA_TLCL,
        LUA_TLCF,
        LUA_TCCL,
        LUA_TUSERDATA,
        LUA_TTHREAD,
        LUA_NUMTAGS
    },
    to_jsstring,
    to_luastring,
    luastring_eq
} = require('./defs.js');

const {
    FENGARI_STATE_SIGNATURE,
    FORMAT_VERSION_MAJOR,
    FORMAT_VERSION_MINOR,
    SER_TNIL,
    SER_TBOOLEAN,
    SER_TNUMINT,
    SER_TNUMFLT,
    SER_TSHRSTR,
    SER_TLNGSTR,
    SER_TTABLE,
    SER_TLCLOSURE,
    SER_TCCLOSURE,
    SER_TLCF,
    SER_TUSERDATA,
    SER_TTHREAD,
    SER_TLIGHTUSERDATA,
    SER_TPROTO,
    SER_TREF,
    SER_TUDATA_NULL,
    SER_TFUNC_NULL,
    RestoreState,
    SerializationError
} = require('./lserialize.js');

const { luaU_undump } = require('./lundump.js');
const { ZIO } = require('./lzio.js');
const lobject = require('./lobject.js');
const ltable = require('./ltable.js');
const lstring = require('./lstring.js');
const lfunc = require('./lfunc.js');
const lstate = require('./lstate.js');

/* ============================================================
 * Binary Reading Utilities
 * ============================================================ */

const ReadBlock = function(R, size) {
    if (R.offset + size > R.buffer.length) {
        throw new SerializationError('Unexpected end of data');
    }
    const result = R.buffer.subarray(R.offset, R.offset + size);
    R.offset += size;
    return result;
};

const ReadByte = function(R) {
    if (R.offset >= R.buffer.length) {
        throw new SerializationError('Unexpected end of data');
    }
    return R.buffer[R.offset++];
};

const ReadUInt16 = function(R) {
    const bytes = ReadBlock(R, 2);
    return bytes[0] | (bytes[1] << 8);
};

const ReadInt32 = function(R) {
    const bytes = ReadBlock(R, 4);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, 4);
    return dv.getInt32(0, true);
};

const ReadUInt32 = function(R) {
    const bytes = ReadBlock(R, 4);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, 4);
    return dv.getUint32(0, true);
};

const ReadFloat64 = function(R) {
    const bytes = ReadBlock(R, 8);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, 8);
    return dv.getFloat64(0, true);
};

/**
 * Read a variable-length string (length-prefixed)
 */
const ReadString = function(R) {
    const len = ReadUInt32(R);
    if (len === 0) {
        return null;
    }
    return ReadBlock(R, len);
};

/**
 * Read a reference ID (4 bytes)
 */
const ReadRef = function(R) {
    return ReadUInt32(R);
};

/* ============================================================
 * Header Validation
 * ============================================================ */

const ReadHeader = function(R) {
    /* Check magic signature */
    const sig = ReadBlock(R, FENGARI_STATE_SIGNATURE.length);
    if (!luastring_eq(sig, FENGARI_STATE_SIGNATURE)) {
        throw new SerializationError('Invalid state signature');
    }

    /* Check format version */
    const versionMajor = ReadByte(R);
    const versionMinor = ReadByte(R);

    if (versionMajor !== FORMAT_VERSION_MAJOR) {
        throw new SerializationError(
            `Incompatible format version: ${versionMajor}.${versionMinor}, expected ${FORMAT_VERSION_MAJOR}.x`
        );
    }

    /* Read flags */
    const flags = ReadUInt16(R);
    R.stripDebug = (flags & 0x01) !== 0;

    /* Read Fengari version string */
    const fengariVersion = ReadString(R);
    R.fengariVersion = fengariVersion ? to_jsstring(fengariVersion) : null;

    /* Read size information */
    const intSize = ReadByte(R);
    const numberSize = ReadByte(R);

    if (intSize !== 4 || numberSize !== 8) {
        throw new SerializationError('Size mismatch in state data');
    }

    /* Read checksum (placeholder for now) */
    const checksum = ReadUInt32(R);

    return { versionMajor, versionMinor, flags };
};

/* ============================================================
 * TValue Restoration
 * ============================================================ */

/**
 * Restore a TValue
 */
const RestoreTValue = function(R) {
    const stype = ReadByte(R);

    switch (stype) {
        case SER_TNIL:
            return new lobject.TValue(LUA_TNIL, null);

        case SER_TBOOLEAN:
            return new lobject.TValue(LUA_TBOOLEAN, ReadByte(R) !== 0);

        case SER_TNUMINT:
            return new lobject.TValue(LUA_TNUMINT, ReadInt32(R));

        case SER_TNUMFLT:
            return new lobject.TValue(LUA_TNUMFLT, ReadFloat64(R));

        case SER_TSHRSTR:
        case SER_TLNGSTR:
            return RestoreTString(R, stype);

        case SER_TTABLE:
            return RestoreTableRef(R);

        case SER_TLCLOSURE:
            return RestoreLClosureRef(R);

        case SER_TCCLOSURE:
            return RestoreCClosureRef(R);

        case SER_TLCF:
            return RestoreLightCFunction(R);

        case SER_TUSERDATA:
            return RestoreUserdataRef(R);

        case SER_TTHREAD:
            return RestoreThreadRef(R);

        case SER_TLIGHTUSERDATA:
            return RestoreLightUserdata(R);

        case SER_TREF:
            return RestoreReference(R);

        case SER_TUDATA_NULL:
            /* Placeholder for unserializable userdata */
            return new lobject.TValue(LUA_TNIL, null);

        case SER_TFUNC_NULL:
            /* Placeholder for unserializable function */
            return new lobject.TValue(LUA_TNIL, null);

        case SER_TPROTO:
            /* Proto shouldn't appear as a TValue directly */
            throw new SerializationError('Unexpected Proto in TValue context');

        default:
            throw new SerializationError(`Unknown serialization type: ${stype}`);
    }
};

/**
 * Restore a reference to an already-loaded object
 */
const RestoreReference = function(R) {
    const id = ReadRef(R);
    const obj = R.registry.getObject(id);

    if (obj === undefined) {
        /* Forward reference - create a placeholder and add fixup */
        const placeholder = new lobject.TValue(LUA_TNIL, null);
        /* Mark as placeholder so table restoration can detect it */
        placeholder._isPlaceholder = true;
        R.fixups.push(() => {
            const resolved = R.registry.getObject(id);
            if (resolved === undefined) {
                /*
                 * Reference couldn't be resolved - this can happen when
                 * referencing unregistered native functions or other
                 * unserializable objects. Leave the placeholder as nil.
                 */
                placeholder._isPlaceholder = false;
                return;
            }
            /* Clear placeholder marker */
            placeholder._isPlaceholder = false;
            /* Determine the type from the resolved object */
            if (resolved instanceof ltable.Table) {
                placeholder.sethvalue(resolved);
            } else if (resolved instanceof lobject.LClosure) {
                placeholder.setclLvalue(resolved);
            } else if (resolved instanceof lobject.CClosure) {
                placeholder.setclCvalue(resolved);
            } else if (resolved instanceof lstring.TString) {
                placeholder.setsvalue(resolved);
            } else if (resolved instanceof lobject.Udata) {
                placeholder.setuvalue(resolved);
            } else if (resolved instanceof lstate.lua_State) {
                placeholder.setthvalue(resolved);
            } else if (typeof resolved === 'function') {
                placeholder.setfvalue(resolved);
            }
        });
        return placeholder;
    }

    /* Create TValue from resolved object */
    if (obj instanceof ltable.Table) {
        return new lobject.TValue(LUA_TTABLE, obj);
    } else if (obj instanceof lobject.LClosure) {
        return new lobject.TValue(LUA_TLCL, obj);
    } else if (obj instanceof lobject.CClosure) {
        return new lobject.TValue(LUA_TCCL, obj);
    } else if (obj instanceof lstring.TString) {
        return new lobject.TValue(LUA_TLNGSTR, obj);
    } else if (obj instanceof lobject.Udata) {
        return new lobject.TValue(LUA_TUSERDATA, obj);
    } else if (obj instanceof lstate.lua_State) {
        return new lobject.TValue(LUA_TTHREAD, obj);
    } else if (typeof obj === 'function') {
        return new lobject.TValue(LUA_TLCF, obj);
    }

    throw new SerializationError(`Unknown object type in reference: ${typeof obj}`);
};

/* ============================================================
 * TString Restoration
 * ============================================================ */

const RestoreTString = function(R, stype) {
    const id = ReadRef(R);
    const strBytes = ReadString(R);

    /* Handle null/empty strings */
    let ts;
    if (strBytes === null) {
        ts = lstring.luaS_bless(R.L, new Uint8Array(0));
    } else {
        ts = lstring.luaS_bless(R.L, strBytes);
    }
    R.registry.setObject(id, ts);

    const luaType = (stype === SER_TSHRSTR) ? LUA_TSHRSTR : LUA_TLNGSTR;
    return new lobject.TValue(luaType, ts);
};

/* ============================================================
 * Table Restoration
 * ============================================================ */

const RestoreTableRef = function(R) {
    const id = ReadRef(R);

    /* Create table immediately to handle cycles */
    const t = ltable.luaH_new(R.L);
    R.registry.setObject(id, t);

    RestoreTable(R, t);

    return new lobject.TValue(LUA_TTABLE, t);
};

const RestoreTable = function(R, t) {
    const count = ReadUInt32(R);

    /* Read metatable reference */
    const hasMetatable = ReadByte(R);
    if (hasMetatable) {
        const mtId = ReadRef(R);
        R.fixups.push(() => {
            const mt = R.registry.getObject(mtId);
            if (mt instanceof ltable.Table) {
                t.metatable = mt;
            }
        });
    }

    /* Read entries */
    for (let i = 0; i < count; i++) {
        const key = RestoreTValue(R);
        const value = RestoreTValue(R);

        /*
         * If key is nil (forward reference placeholder), defer setting this entry.
         * This can happen when a table key is a function that hasn't been loaded yet.
         * We'll capture the key and value TValues and set them in a fixup after
         * all objects are loaded and references are resolved.
         */
        if (key.ttisnil() && key._isPlaceholder) {
            /* Defer to fixup when key will be resolved */
            R.fixups.push(() => {
                if (!key.ttisnil()) {
                    ltable.luaH_setfrom(R.L, t, key, value);
                }
            });
        } else if (key.ttisnil()) {
            /* Actual nil key - skip (can't use nil as table key) */
            continue;
        } else {
            ltable.luaH_setfrom(R.L, t, key, value);
        }
    }
};

/* ============================================================
 * Proto Restoration (leverages lundump.js)
 * ============================================================ */

const RestoreProtoRef = function(R) {
    const stype = ReadByte(R);

    if (stype === SER_TREF) {
        const id = ReadRef(R);
        return R.registry.getObject(id);
    }

    if (stype !== SER_TPROTO) {
        throw new SerializationError(`Expected Proto, got type ${stype}`);
    }

    const id = ReadRef(R);
    return RestoreProto(R, id);
};

const RestoreProto = function(R, id) {
    const size = ReadUInt32(R);
    const bytecode = ReadBlock(R, size);

    /* Create a reader for the bytecode */
    let offset = 0;
    const reader = function(L, ud) {
        if (offset >= bytecode.length) {
            return null;
        }
        const remaining = bytecode.subarray(offset);
        offset = bytecode.length;
        return remaining;
    };

    /* Use lundump to restore the Proto */
    const z = new ZIO(R.L, reader, null);

    /*
     * luaU_undump expects the first byte of the signature to already be consumed.
     * This is because the Lua loader checks the first byte to determine if it's
     * binary or text. So we consume it here.
     */
    const firstByte = z.zgetc();
    if (firstByte !== 0x1b) {  /* LUA_SIGNATURE[0] */
        throw new SerializationError('Invalid bytecode signature');
    }

    const cl = luaU_undump(R.L, z, to_luastring("=snapshot"));
    const p = cl.p;

    /* Pop the closure from stack (we only need the Proto) */
    R.L.top--;

    R.registry.setObject(id, p);
    return p;
};

/* ============================================================
 * Closure Restoration
 * ============================================================ */

const RestoreLClosureRef = function(R) {
    const id = ReadRef(R);

    /* Read Proto */
    const p = RestoreProtoRef(R);

    /* Read upvalues count */
    const nupvalues = ReadUInt32(R);

    /* Create closure */
    const cl = new lobject.LClosure(R.L, nupvalues);
    cl.p = p;
    R.registry.setObject(id, cl);

    /* Read upvalues */
    for (let i = 0; i < nupvalues; i++) {
        cl.upvals[i] = RestoreTValue(R);
    }

    return new lobject.TValue(LUA_TLCL, cl);
};

const RestoreCClosureRef = function(R) {
    const id = ReadRef(R);

    const isSerializable = ReadByte(R);

    if (!isSerializable) {
        /* Create placeholder closure that throws on call */
        const nupvalues = ReadUInt32(R);
        const placeholderFunc = function() {
            throw new Error('Attempted to call unrestored native function');
        };
        const cl = new lobject.CClosure(R.L, placeholderFunc, nupvalues);
        R.registry.setObject(id, cl);

        /* Read upvalues */
        for (let i = 0; i < nupvalues; i++) {
            cl.upvalue[i] = RestoreTValue(R);
        }

        return new lobject.TValue(LUA_TCCL, cl);
    }

    /* Read function name and look up */
    const nameBytes = ReadString(R);
    const funcName = to_jsstring(nameBytes);
    const func = R.nativeFuncs.getFunc(funcName);

    if (func === undefined) {
        throw new SerializationError(`Unknown native function: ${funcName}`);
    }

    /* Read upvalues count */
    const nupvalues = ReadUInt32(R);

    /* Create closure */
    const cl = new lobject.CClosure(R.L, func, nupvalues);
    R.registry.setObject(id, cl);

    /* Read upvalues */
    for (let i = 0; i < nupvalues; i++) {
        cl.upvalue[i] = RestoreTValue(R);
    }

    return new lobject.TValue(LUA_TCCL, cl);
};

/* ============================================================
 * Light C Function Restoration
 * ============================================================ */

const RestoreLightCFunction = function(R) {
    const nameBytes = ReadString(R);
    const funcName = to_jsstring(nameBytes);
    const func = R.nativeFuncs.getFunc(funcName);

    if (func === undefined) {
        throw new SerializationError(`Unknown light C function: ${funcName}`);
    }

    return new lobject.TValue(LUA_TLCF, func);
};

/* ============================================================
 * Userdata Restoration
 * ============================================================ */

const RestoreUserdataRef = function(R) {
    const id = ReadRef(R);

    /* Check for custom data */
    const hasCustomData = ReadByte(R);
    let customData = null;
    let customType = null;

    if (hasCustomData) {
        const typeBytes = ReadString(R);
        customType = to_jsstring(typeBytes);
        const jsonBytes = ReadString(R);
        customData = JSON.parse(to_jsstring(jsonBytes));
    }

    /* Read metatable reference */
    const hasMetatable = ReadByte(R);
    let metatableId = null;
    if (hasMetatable) {
        metatableId = ReadRef(R);
    }

    /* Read uservalue */
    const uservalue = RestoreTValue(R);

    /* Read length */
    const len = ReadUInt32(R);

    /* Create userdata */
    const ud = new lobject.Udata(R.L, len);
    ud.uservalue = uservalue;
    R.registry.setObject(id, ud);

    /* Set metatable via fixup */
    if (metatableId !== null) {
        R.fixups.push(() => {
            const mt = R.registry.getObject(metatableId);
            if (mt instanceof ltable.Table) {
                ud.metatable = mt;
            }
        });
    }

    /* Apply custom deserializer */
    if (customData !== null && customType !== null) {
        const deserializers = R.options.userdataDeserializers;
        if (deserializers && deserializers[customType]) {
            deserializers[customType].restore(ud, customData);
        }
    }

    return new lobject.TValue(LUA_TUSERDATA, ud);
};

/* ============================================================
 * Light Userdata Restoration
 * ============================================================ */

const RestoreLightUserdata = function(R) {
    const subtype = ReadByte(R);

    switch (subtype) {
        case 1: {
            /* Custom serialized */
            const jsonBytes = ReadString(R);
            const data = JSON.parse(to_jsstring(jsonBytes));

            const deserializer = R.options.lightUserdataDeserializer;
            if (deserializer && deserializer.restore) {
                const value = deserializer.restore(data);
                return new lobject.TValue(LUA_TLIGHTUSERDATA, value);
            }
            /* Fall back to returning the data as-is */
            return new lobject.TValue(LUA_TLIGHTUSERDATA, data);
        }

        case 2:
            /* null */
            return new lobject.TValue(LUA_TLIGHTUSERDATA, null);

        case 3: {
            /* JS string */
            const strBytes = ReadString(R);
            return new lobject.TValue(LUA_TLIGHTUSERDATA, to_jsstring(strBytes));
        }

        case 4: {
            /* JS number */
            const num = ReadFloat64(R);
            return new lobject.TValue(LUA_TLIGHTUSERDATA, num);
        }

        case 5: {
            /* JS boolean */
            const bool = ReadByte(R) !== 0;
            return new lobject.TValue(LUA_TLIGHTUSERDATA, bool);
        }

        default:
            throw new SerializationError(`Unknown lightuserdata subtype: ${subtype}`);
    }
};

/* ============================================================
 * Thread (lua_State) Restoration
 * ============================================================ */

const RestoreThreadRef = function(R) {
    const id = ReadRef(R);

    /* Create or reuse thread */
    let L;
    if (R.isMainThread) {
        L = R.L;
        R.isMainThread = false;
    } else {
        L = new lstate.lua_State(R.L.l_G);
    }
    R.registry.setObject(id, L);

    RestoreThread(R, L);

    return new lobject.TValue(LUA_TTHREAD, L);
};

const RestoreThread = function(R, L) {
    /* Basic state */
    L.status = ReadInt32(R);
    L.nCcalls = ReadInt32(R);
    L.nny = ReadInt32(R);
    L.allowhook = ReadByte(R);
    L.basehookcount = ReadInt32(R);
    L.hookcount = ReadInt32(R);
    L.hookmask = ReadInt32(R);
    L.errfunc = ReadInt32(R);
    L.oldpc = ReadInt32(R);

    /* Stack */
    const stackLen = ReadUInt32(R);
    const top = ReadUInt32(R);
    const stack_last = ReadUInt32(R);

    L.stack = new Array(stackLen);
    L.top = top;
    L.stack_last = stack_last;

    /* Initialize stack with nil values */
    for (let i = 0; i < stackLen; i++) {
        L.stack[i] = new lobject.TValue(LUA_TNIL, null);
    }

    /* Read stack values */
    for (let i = 0; i < top; i++) {
        L.stack[i] = RestoreTValue(R);
    }

    /* CallInfo chain */
    const ciCount = ReadUInt32(R);
    let prevCi = null;

    for (let i = 0; i < ciCount; i++) {
        const ci = (i === 0) ? L.base_ci : new lstate.CallInfo();

        RestoreCallInfo(R, ci, L);

        if (i === 0) {
            ci.previous = null;
            ci.next = null;
        } else {
            prevCi.next = ci;
            ci.previous = prevCi;
            ci.next = null;
        }

        prevCi = ci;
    }

    L.ci = prevCi;
};

const RestoreCallInfo = function(R, ci, L) {
    ci.funcOff = ReadInt32(R);
    ci.top = ReadInt32(R);
    ci.nresults = ReadInt32(R);
    ci.callstatus = ReadInt32(R);

    ci.l_base = ReadInt32(R);
    ci.l_savedpc = ReadInt32(R);

    /* Continuation function */
    const hasContinuation = ReadByte(R);
    if (hasContinuation) {
        const nameBytes = ReadString(R);
        const funcName = to_jsstring(nameBytes);
        ci.c_k = R.nativeFuncs.getFunc(funcName) || null;
    } else {
        ci.c_k = null;
    }

    /* Context */
    ci.c_ctx = ReadInt32(R);
    ci.c_old_errfunc = ReadInt32(R);

    /* Set up func reference and l_code via fixup */
    R.fixups.push(() => {
        ci.func = L.stack[ci.funcOff];
        if (ci.callstatus & lstate.CIST_LUA) {
            if (ci.func && ci.func.value && ci.func.value.p) {
                ci.l_code = ci.func.value.p.code;
            }
        }
    });
};

/* ============================================================
 * Global State Restoration
 * ============================================================ */

const RestoreGlobalState = function(R, g) {
    /* id_counter */
    g.id_counter = ReadUInt32(R);

    /* Registry */
    const registryTv = RestoreTValue(R);
    g.l_registry.setfrom(registryTv);

    /* Type metatables */
    for (let i = 0; i < LUA_NUMTAGS; i++) {
        const hasMt = ReadByte(R);
        if (hasMt) {
            const mtTv = RestoreTValue(R);
            g.mt[i] = mtTv.value;
        } else {
            g.mt[i] = null;
        }
    }
};

/* ============================================================
 * Full VM Restoration
 * ============================================================ */

/**
 * Restore an entire VM state from serialized data
 * @param {Uint8Array} buffer - The serialized state data
 * @param {Object} options - Restoration options
 * @returns {lua_State} - The restored Lua state
 */
const restoreVM = function(buffer, options = {}) {
    /* Create a fresh Lua state */
    const L = lstate.lua_newstate();
    if (L === null) {
        throw new SerializationError('Failed to create Lua state');
    }

    const R = new RestoreState(L, buffer, options);
    R.isMainThread = true;

    /* Read and validate header */
    ReadHeader(R);

    /* Restore global state */
    RestoreGlobalState(R, L.l_G);

    /* Read thread count */
    const threadCount = ReadUInt32(R);

    /* Restore threads */
    for (let i = 0; i < threadCount; i++) {
        const tv = RestoreTValue(R);
        /* First thread should be main thread */
        if (i === 0 && tv.value !== L) {
            /* Replace main thread in registry if needed */
        }
    }

    /* Read end marker */
    const endMarker = ReadUInt32(R);
    if (endMarker !== 0xDEADBEEF) {
        throw new SerializationError('Invalid end marker');
    }

    /* Run fixups */
    R.runFixups();

    return L;
};

/**
 * Restore a single value from serialized data
 * @param {lua_State} L - The target Lua state
 * @param {Uint8Array} buffer - The serialized value data
 * @param {Object} options - Restoration options
 * @returns {TValue} - The restored value
 */
const restoreValue = function(L, buffer, options = {}) {
    const R = new RestoreState(L, buffer, options);

    /* Read mini header */
    const sig = ReadBlock(R, FENGARI_STATE_SIGNATURE.length);
    if (!luastring_eq(sig, FENGARI_STATE_SIGNATURE)) {
        throw new SerializationError('Invalid value signature');
    }

    const versionMajor = ReadByte(R);
    const versionMinor = ReadByte(R);
    const flags = ReadByte(R);
    const marker = ReadByte(R);

    if (marker !== 1) {
        throw new SerializationError('Not a single-value snapshot');
    }

    /* Read the value */
    const value = RestoreTValue(R);

    /* Read end marker */
    const endMarker = ReadUInt32(R);
    if (endMarker !== 0xDEADBEEF) {
        throw new SerializationError('Invalid end marker');
    }

    /* Run fixups */
    R.runFixups();

    return value;
};

/* Exports */
module.exports.restoreVM = restoreVM;
module.exports.restoreValue = restoreValue;
module.exports.RestoreState = RestoreState;

/* Export individual restore functions for testing */
module.exports.RestoreTValue = RestoreTValue;
module.exports.RestoreTString = RestoreTString;
module.exports.RestoreTable = RestoreTable;
module.exports.RestoreTableRef = RestoreTableRef;
module.exports.RestoreProto = RestoreProto;
module.exports.RestoreProtoRef = RestoreProtoRef;
module.exports.RestoreLClosureRef = RestoreLClosureRef;
module.exports.RestoreCClosureRef = RestoreCClosureRef;
module.exports.RestoreThread = RestoreThread;
module.exports.RestoreThreadRef = RestoreThreadRef;
module.exports.RestoreCallInfo = RestoreCallInfo;
module.exports.RestoreGlobalState = RestoreGlobalState;

/* Export reading utilities for testing */
module.exports.ReadByte = ReadByte;
module.exports.ReadInt32 = ReadInt32;
module.exports.ReadUInt32 = ReadUInt32;
module.exports.ReadFloat64 = ReadFloat64;
module.exports.ReadString = ReadString;
module.exports.ReadRef = ReadRef;
