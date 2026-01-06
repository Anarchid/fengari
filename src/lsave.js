"use strict";

/**
 * lsave.js - State serialization for Fengari VM
 *
 * Serializes Lua VM state (tables, closures, threads, etc.) to a binary format.
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
        LUA_TTHREAD
    },
    to_luastring,
    luastring_of
} = require('./defs.js');

const {
    FENGARI_STATE_SIGNATURE,
    FORMAT_VERSION_MAJOR,
    FORMAT_VERSION_MINOR,
    FENGARI_VERSION,
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
    SaveState,
    SerializationError,
    luaTypeToSerType
} = require('./lserialize.js');

const { luaU_dump } = require('./ldump.js');
const { CIST_LUA } = require('./lstate.js');

/* ============================================================
 * Binary Writing Utilities
 * ============================================================ */

const WriteBlock = function(S, data) {
    for (let i = 0; i < data.length; i++) {
        S.buffer.push(data[i]);
    }
};

const WriteByte = function(S, b) {
    S.buffer.push(b & 0xFF);
};

const WriteUInt16 = function(S, n) {
    S.buffer.push(n & 0xFF);
    S.buffer.push((n >> 8) & 0xFF);
};

const WriteInt32 = function(S, n) {
    const ab = new ArrayBuffer(4);
    const dv = new DataView(ab);
    dv.setInt32(0, n, true);  /* little-endian */
    WriteBlock(S, new Uint8Array(ab));
};

const WriteUInt32 = function(S, n) {
    const ab = new ArrayBuffer(4);
    const dv = new DataView(ab);
    dv.setUint32(0, n >>> 0, true);  /* little-endian, unsigned */
    WriteBlock(S, new Uint8Array(ab));
};

const WriteFloat64 = function(S, n) {
    const ab = new ArrayBuffer(8);
    const dv = new DataView(ab);
    dv.setFloat64(0, n, true);  /* little-endian */
    WriteBlock(S, new Uint8Array(ab));
};

/**
 * Write a variable-length string (length-prefixed)
 */
const WriteString = function(S, str) {
    if (str === null || str === undefined) {
        WriteUInt32(S, 0);
    } else {
        WriteUInt32(S, str.length);
        WriteBlock(S, str);
    }
};

/**
 * Write a reference ID (4 bytes)
 */
const WriteRef = function(S, id) {
    WriteUInt32(S, id);
};

/* ============================================================
 * Header Serialization
 * ============================================================ */

const WriteHeader = function(S) {
    /* Magic signature */
    WriteBlock(S, FENGARI_STATE_SIGNATURE);

    /* Format version */
    WriteByte(S, FORMAT_VERSION_MAJOR);
    WriteByte(S, FORMAT_VERSION_MINOR);

    /* Flags */
    let flags = 0;
    if (S.options.stripDebug) flags |= 0x01;
    WriteUInt16(S, flags);

    /* Fengari version string (length-prefixed) */
    const versionStr = to_luastring(FENGARI_VERSION);
    WriteString(S, versionStr);

    /* Size information for validation */
    WriteByte(S, 4);  /* int size */
    WriteByte(S, 8);  /* number size */

    /* Checksum placeholder (will be filled at end) */
    WriteUInt32(S, 0);
};

/* ============================================================
 * TValue Serialization
 * ============================================================ */

/**
 * Serialize a TValue
 */
const SaveTValue = function(S, tv) {
    if (tv === null || tv === undefined || tv.ttisnil()) {
        WriteByte(S, SER_TNIL);
        return;
    }

    const ttype = tv.ttype();

    switch (ttype) {
        case LUA_TNIL:
            WriteByte(S, SER_TNIL);
            break;

        case LUA_TBOOLEAN:
            WriteByte(S, SER_TBOOLEAN);
            WriteByte(S, tv.value ? 1 : 0);
            break;

        case LUA_TNUMINT:
            WriteByte(S, SER_TNUMINT);
            WriteInt32(S, tv.value);
            break;

        case LUA_TNUMFLT:
            WriteByte(S, SER_TNUMFLT);
            WriteFloat64(S, tv.value);
            break;

        case LUA_TSHRSTR:
        case LUA_TLNGSTR:
            SaveTString(S, tv.value);
            break;

        case LUA_TTABLE:
            SaveTableRef(S, tv.value);
            break;

        case LUA_TLCL:
            SaveLClosureRef(S, tv.value);
            break;

        case LUA_TCCL:
            SaveCClosureRef(S, tv.value);
            break;

        case LUA_TLCF:
            SaveLightCFunction(S, tv.value);
            break;

        case LUA_TUSERDATA:
            SaveUserdataRef(S, tv.value);
            break;

        case LUA_TTHREAD:
            SaveThreadRef(S, tv.value);
            break;

        case LUA_TLIGHTUSERDATA:
            SaveLightUserdata(S, tv.value);
            break;

        default:
            throw new SerializationError(`Unknown TValue type: ${ttype}`);
    }
};

/* ============================================================
 * TString Serialization
 * ============================================================ */

const SaveTString = function(S, ts) {
    if (ts === null) {
        WriteByte(S, SER_TNIL);
        return;
    }

    const { id, isNew } = S.registry.register(ts);

    if (!isNew) {
        /* Already serialized - write reference */
        WriteByte(S, SER_TREF);
        WriteRef(S, id);
        return;
    }

    /* Determine short vs long string */
    const str = ts.getstr();
    const isShort = str.length < 40;  /* arbitrary threshold like Lua */

    WriteByte(S, isShort ? SER_TSHRSTR : SER_TLNGSTR);
    WriteRef(S, id);
    WriteString(S, str);
};

/* ============================================================
 * Table Serialization
 * ============================================================ */

const SaveTableRef = function(S, t) {
    const { id, isNew } = S.registry.register(t);

    if (!isNew) {
        /* Already serialized - write reference */
        WriteByte(S, SER_TREF);
        WriteRef(S, id);
        return;
    }

    WriteByte(S, SER_TTABLE);
    WriteRef(S, id);
    SaveTable(S, t);
};

const SaveTable = function(S, t) {
    /* Count live entries */
    let count = 0;
    for (let e = t.f; e; e = e.n) {
        if (!e.key.ttisdeadkey()) count++;
    }

    /* Write entry count */
    WriteUInt32(S, count);

    /* Write metatable reference */
    if (t.metatable) {
        const { id } = S.registry.register(t.metatable);
        WriteByte(S, 1);
        WriteRef(S, id);
        /* Queue metatable for serialization if not yet done */
        if (S.registry.getId(t.metatable) === id) {
            S.pendingTables = S.pendingTables || [];
            S.pendingTables.push(t.metatable);
        }
    } else {
        WriteByte(S, 0);
    }

    /* Write entries */
    for (let e = t.f; e; e = e.n) {
        if (!e.key.ttisdeadkey()) {
            SaveTValue(S, e.key);
            SaveTValue(S, e.value);
        }
    }
};

/* ============================================================
 * Proto Serialization (leverages ldump.js)
 * ============================================================ */

const SaveProtoRef = function(S, p) {
    const { id, isNew } = S.registry.register(p);

    if (!isNew) {
        WriteByte(S, SER_TREF);
        WriteRef(S, id);
        return;
    }

    WriteByte(S, SER_TPROTO);
    WriteRef(S, id);
    SaveProto(S, p);
};

const SaveProto = function(S, p) {
    /* Use existing ldump mechanism for Proto serialization */
    const chunks = [];
    const writer = function(L, data, size, ud) {
        chunks.push(data.slice(0, size));
        return 0;
    };

    luaU_dump(S.L, p, writer, null, S.options.stripDebug ? 1 : 0);

    /* Calculate total size */
    let totalSize = 0;
    for (const chunk of chunks) {
        totalSize += chunk.length;
    }

    /* Write bytecode */
    WriteUInt32(S, totalSize);
    for (const chunk of chunks) {
        WriteBlock(S, chunk);
    }
};

/* ============================================================
 * Closure Serialization
 * ============================================================ */

const SaveLClosureRef = function(S, cl) {
    const { id, isNew } = S.registry.register(cl);

    if (!isNew) {
        WriteByte(S, SER_TREF);
        WriteRef(S, id);
        return;
    }

    WriteByte(S, SER_TLCLOSURE);
    WriteRef(S, id);
    SaveLClosure(S, cl);
};

const SaveLClosure = function(S, cl) {
    /* Save Proto reference */
    SaveProtoRef(S, cl.p);

    /* Save upvalues count */
    WriteUInt32(S, cl.nupvalues);

    /* Save each upvalue */
    for (let i = 0; i < cl.nupvalues; i++) {
        const upval = cl.upvals[i];
        if (upval) {
            SaveTValue(S, upval);
        } else {
            WriteByte(S, SER_TNIL);
        }
    }
};

const SaveCClosureRef = function(S, cl) {
    const { id, isNew } = S.registry.register(cl);

    if (!isNew) {
        WriteByte(S, SER_TREF);
        WriteRef(S, id);
        return;
    }

    WriteByte(S, SER_TCCLOSURE);
    WriteRef(S, id);
    SaveCClosure(S, cl);
};

const SaveCClosure = function(S, cl) {
    /* Look up native function name */
    const funcName = S.nativeFuncs.getName(cl.f);

    if (funcName === undefined) {
        /* Unregistered native function */
        if (S.options.onUnserializable === 'error') {
            throw new SerializationError(
                'Unregistered native function in CClosure',
                { func: cl.f }
            );
        }

        S.warn('Unregistered native function in CClosure - will not be callable after restore');
        S.unserializable.push({ type: 'cclosure', func: cl.f });

        /* Write as null placeholder */
        WriteByte(S, 0);  /* not serializable */
        WriteUInt32(S, cl.nupvalues);

        /* Still save upvalues */
        for (let i = 0; i < cl.nupvalues; i++) {
            SaveTValue(S, cl.upvalue[i]);
        }
        return;
    }

    WriteByte(S, 1);  /* serializable */
    const nameBytes = to_luastring(funcName);
    WriteString(S, nameBytes);

    /* Save upvalues count */
    WriteUInt32(S, cl.nupvalues);

    /* Save each upvalue */
    for (let i = 0; i < cl.nupvalues; i++) {
        SaveTValue(S, cl.upvalue[i]);
    }
};

/* ============================================================
 * Light C Function Serialization
 * ============================================================ */

const SaveLightCFunction = function(S, func) {
    const funcName = S.nativeFuncs.getName(func);

    if (funcName === undefined) {
        if (S.options.onUnserializable === 'error') {
            throw new SerializationError(
                'Unregistered light C function',
                { func }
            );
        }

        S.warn('Unregistered light C function - will not be callable after restore');
        S.unserializable.push({ type: 'lcf', func });

        WriteByte(S, SER_TFUNC_NULL);
        return;
    }

    WriteByte(S, SER_TLCF);
    const nameBytes = to_luastring(funcName);
    WriteString(S, nameBytes);
};

/* ============================================================
 * Userdata Serialization
 * ============================================================ */

const SaveUserdataRef = function(S, ud) {
    const { id, isNew } = S.registry.register(ud);

    if (!isNew) {
        WriteByte(S, SER_TREF);
        WriteRef(S, id);
        return;
    }

    WriteByte(S, SER_TUSERDATA);
    WriteRef(S, id);
    SaveUserdata(S, ud);
};

const SaveUserdata = function(S, ud) {
    /* Check for custom serializer */
    const customSerializers = S.options.userdataSerializers;
    let serialized = false;
    let customData = null;
    let customType = null;

    if (customSerializers) {
        for (const [typeName, serializer] of Object.entries(customSerializers)) {
            if (serializer.canSerialize && serializer.canSerialize(ud)) {
                customData = serializer.save(ud);
                customType = typeName;
                serialized = true;
                break;
            }
        }
    }

    if (serialized) {
        WriteByte(S, 1);  /* has custom data */
        WriteString(S, to_luastring(customType));
        /* Write custom data as JSON */
        const jsonData = to_luastring(JSON.stringify(customData));
        WriteString(S, jsonData);
    } else {
        WriteByte(S, 0);  /* no custom data */
    }

    /* Save metatable reference */
    if (ud.metatable) {
        const { id } = S.registry.register(ud.metatable);
        WriteByte(S, 1);
        WriteRef(S, id);
    } else {
        WriteByte(S, 0);
    }

    /* Save uservalue */
    SaveTValue(S, ud.uservalue);

    /* Save length */
    WriteUInt32(S, ud.len);
};

/* ============================================================
 * Light Userdata Serialization
 * ============================================================ */

const SaveLightUserdata = function(S, value) {
    const customSerializer = S.options.lightUserdataSerializer;

    if (customSerializer && customSerializer.canSerialize && customSerializer.canSerialize(value)) {
        WriteByte(S, SER_TLIGHTUSERDATA);
        WriteByte(S, 1);  /* serializable */
        const data = customSerializer.save(value);
        const jsonData = to_luastring(JSON.stringify(data));
        WriteString(S, jsonData);
        return;
    }

    /* Handle primitive types that can be serialized */
    if (value === null) {
        WriteByte(S, SER_TLIGHTUSERDATA);
        WriteByte(S, 2);  /* null */
        return;
    }

    switch (typeof value) {
        case 'string':
            WriteByte(S, SER_TLIGHTUSERDATA);
            WriteByte(S, 3);  /* JS string */
            WriteString(S, to_luastring(value));
            return;

        case 'number':
            WriteByte(S, SER_TLIGHTUSERDATA);
            WriteByte(S, 4);  /* JS number */
            WriteFloat64(S, value);
            return;

        case 'boolean':
            WriteByte(S, SER_TLIGHTUSERDATA);
            WriteByte(S, 5);  /* JS boolean */
            WriteByte(S, value ? 1 : 0);
            return;

        default:
            /* Not serializable */
            if (S.options.onUnserializable === 'error') {
                throw new SerializationError(
                    'Unserializable lightuserdata',
                    { value, type: typeof value }
                );
            }

            S.warn(`Unserializable lightuserdata of type ${typeof value}`);
            S.unserializable.push({ type: 'lightuserdata', value });

            WriteByte(S, SER_TUDATA_NULL);
            return;
    }
};

/* ============================================================
 * Thread (lua_State) Serialization
 * ============================================================ */

const SaveThreadRef = function(S, L) {
    const { id, isNew } = S.registry.register(L);

    if (!isNew) {
        WriteByte(S, SER_TREF);
        WriteRef(S, id);
        return;
    }

    WriteByte(S, SER_TTHREAD);
    WriteRef(S, id);
    SaveThread(S, L);
};

const SaveThread = function(S, L) {
    /* Basic state */
    WriteInt32(S, L.status);
    WriteInt32(S, L.nCcalls);
    WriteInt32(S, L.nny);
    WriteByte(S, L.allowhook);
    WriteInt32(S, L.basehookcount);
    WriteInt32(S, L.hookcount);
    WriteInt32(S, L.hookmask);
    WriteInt32(S, L.errfunc);
    WriteInt32(S, L.oldpc);

    /* Hook function - cannot be serialized */
    if (L.hook !== null) {
        S.warn('Thread hook function cannot be serialized');
        S.unserializable.push({ type: 'hook', thread: L });
    }

    /* Stack */
    WriteUInt32(S, L.stack ? L.stack.length : 0);
    WriteUInt32(S, L.top);
    WriteUInt32(S, L.stack_last);

    for (let i = 0; i < L.top; i++) {
        SaveTValue(S, L.stack[i]);
    }

    /* CallInfo chain */
    let ciCount = 0;
    for (let ci = L.base_ci; ci !== null; ci = ci.next) {
        ciCount++;
    }
    WriteUInt32(S, ciCount);

    for (let ci = L.base_ci; ci !== null; ci = ci.next) {
        SaveCallInfo(S, ci);
    }
};

const SaveCallInfo = function(S, ci) {
    WriteInt32(S, ci.funcOff);
    WriteInt32(S, ci.top);
    WriteInt32(S, ci.nresults);
    WriteInt32(S, ci.callstatus);

    /* Lua function specific */
    if (ci.callstatus & CIST_LUA) {
        WriteInt32(S, ci.l_base);
        WriteInt32(S, ci.l_savedpc);
    } else {
        WriteInt32(S, 0);
        WriteInt32(S, 0);
    }

    /* Continuation function */
    if (ci.c_k !== null) {
        const kName = S.nativeFuncs.getName(ci.c_k);
        if (kName === undefined) {
            S.warn('Continuation function not registered');
            WriteByte(S, 0);
        } else {
            WriteByte(S, 1);
            WriteString(S, to_luastring(kName));
        }
    } else {
        WriteByte(S, 0);
    }

    /* Context */
    WriteInt32(S, ci.c_ctx || 0);
    WriteInt32(S, ci.c_old_errfunc || 0);
};

/* ============================================================
 * Global State Serialization
 * ============================================================ */

const SaveGlobalState = function(S, g) {
    /* id_counter */
    WriteUInt32(S, g.id_counter);

    /* Registry */
    SaveTableRef(S, g.l_registry.value);

    /* Type metatables */
    const LUA_NUMTAGS = 9;
    for (let i = 0; i < LUA_NUMTAGS; i++) {
        if (g.mt[i]) {
            WriteByte(S, 1);
            SaveTableRef(S, g.mt[i]);
        } else {
            WriteByte(S, 0);
        }
    }

    /* Panic and atnativeerror - cannot be serialized */
    if (g.panic !== null) {
        S.warn('Global panic handler cannot be serialized');
        S.unserializable.push({ type: 'panic' });
    }
    if (g.atnativeerror !== null) {
        S.warn('Global native error handler cannot be serialized');
        S.unserializable.push({ type: 'atnativeerror' });
    }
};

/* ============================================================
 * Full VM Serialization
 * ============================================================ */

/**
 * Collect all threads reachable from the main thread
 */
const collectThreads = function(S, mainL) {
    const threads = [];
    const visited = new Set();
    const queue = [mainL];

    while (queue.length > 0) {
        const L = queue.shift();
        if (visited.has(L)) continue;
        visited.add(L);
        threads.push(L);

        /* Find threads on stack */
        if (L.stack) {
            for (let i = 0; i < L.top; i++) {
                const tv = L.stack[i];
                if (tv && tv.ttisthread && tv.ttisthread()) {
                    queue.push(tv.value);
                }
            }
        }
    }

    return threads;
};

/**
 * Serialize the entire VM state
 * @param {lua_State} L - The main Lua state
 * @param {Object} options - Serialization options
 * @returns {Uint8Array} - The serialized state
 */
const saveVM = function(L, options = {}) {
    const S = new SaveState(L, options);

    /* Write header */
    WriteHeader(S);

    /* Collect all threads */
    const threads = collectThreads(S, L.l_G.mainthread);

    /* Write global state */
    SaveGlobalState(S, L.l_G);

    /* Write thread count */
    WriteUInt32(S, threads.length);

    /* Write each thread (main thread first) */
    for (const thread of threads) {
        SaveThreadRef(S, thread);
    }

    /* Write any pending metatables */
    while (S.pendingTables && S.pendingTables.length > 0) {
        const pending = S.pendingTables;
        S.pendingTables = [];
        for (const t of pending) {
            if (S.registry.getId(t) !== undefined) {
                /* Already written */
                continue;
            }
            SaveTableRef(S, t);
        }
    }

    /* Write end marker */
    WriteUInt32(S, 0xDEADBEEF);

    return S.getResult();
};

/**
 * Serialize a single value (for partial serialization)
 * @param {lua_State} L - The Lua state
 * @param {TValue} value - The value to serialize
 * @param {Object} options - Serialization options
 * @returns {Uint8Array} - The serialized value
 */
const saveValue = function(L, value, options = {}) {
    const S = new SaveState(L, options);

    /* Write mini header */
    WriteBlock(S, FENGARI_STATE_SIGNATURE);
    WriteByte(S, FORMAT_VERSION_MAJOR);
    WriteByte(S, FORMAT_VERSION_MINOR);
    WriteByte(S, 0);  /* flags: value-only mode */
    WriteByte(S, 1);  /* marker: single value */

    /* Write the value */
    SaveTValue(S, value);

    /* Write end marker */
    WriteUInt32(S, 0xDEADBEEF);

    return S.getResult();
};

/* Exports */
module.exports.saveVM = saveVM;
module.exports.saveValue = saveValue;
module.exports.SaveState = SaveState;

/* Export individual save functions for testing */
module.exports.SaveTValue = SaveTValue;
module.exports.SaveTString = SaveTString;
module.exports.SaveTable = SaveTable;
module.exports.SaveTableRef = SaveTableRef;
module.exports.SaveProto = SaveProto;
module.exports.SaveProtoRef = SaveProtoRef;
module.exports.SaveLClosure = SaveLClosure;
module.exports.SaveLClosureRef = SaveLClosureRef;
module.exports.SaveCClosure = SaveCClosure;
module.exports.SaveCClosureRef = SaveCClosureRef;
module.exports.SaveThread = SaveThread;
module.exports.SaveThreadRef = SaveThreadRef;
module.exports.SaveCallInfo = SaveCallInfo;
module.exports.SaveGlobalState = SaveGlobalState;

/* Export writing utilities for testing */
module.exports.WriteByte = WriteByte;
module.exports.WriteInt32 = WriteInt32;
module.exports.WriteUInt32 = WriteUInt32;
module.exports.WriteFloat64 = WriteFloat64;
module.exports.WriteString = WriteString;
module.exports.WriteRef = WriteRef;
