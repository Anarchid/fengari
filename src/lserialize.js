"use strict";

/**
 * lserialize.js - Core serialization infrastructure for Fengari VM state persistence
 *
 * Provides object registry, native function registry, and format constants
 * for serializing and deserializing Lua VM state.
 */

const {
    LUA_VERSION_MAJOR,
    LUA_VERSION_MINOR,
    constant_types: {
        LUA_TNIL,
        LUA_TBOOLEAN,
        LUA_TLIGHTUSERDATA,
        LUA_TNUMBER,
        LUA_TSTRING,
        LUA_TTABLE,
        LUA_TFUNCTION,
        LUA_TUSERDATA,
        LUA_TTHREAD,
        LUA_TNUMFLT,
        LUA_TNUMINT,
        LUA_TSHRSTR,
        LUA_TLNGSTR,
        LUA_TLCL,
        LUA_TLCF,
        LUA_TCCL
    },
    to_luastring
} = require('./defs.js');

/* Format signature: "\x1bFST" (Fengari STate) */
const FENGARI_STATE_SIGNATURE = to_luastring("\x1bFST", true);

/* Format version */
const FORMAT_VERSION_MAJOR = 1;
const FORMAT_VERSION_MINOR = 0;

/* Fengari version for compatibility checks */
const FENGARI_VERSION = "0.1.5";

/* Object type tags for serialization (distinct from Lua type tags) */
const SER_TNIL          = 0;
const SER_TBOOLEAN      = 1;
const SER_TNUMINT       = 2;
const SER_TNUMFLT       = 3;
const SER_TSHRSTR       = 4;
const SER_TLNGSTR       = 5;
const SER_TTABLE        = 6;
const SER_TLCLOSURE     = 7;
const SER_TCCLOSURE     = 8;
const SER_TLCF          = 9;
const SER_TUSERDATA     = 10;
const SER_TTHREAD       = 11;
const SER_TLIGHTUSERDATA = 12;
const SER_TPROTO        = 13;
const SER_TREF          = 14;  /* Reference to already-serialized object */
const SER_TUDATA_NULL   = 15;  /* Placeholder for unserializable userdata */
const SER_TFUNC_NULL    = 16;  /* Placeholder for unserializable function */

/**
 * ObjectRegistry - Tracks objects during serialization/deserialization
 * to handle circular references and object deduplication.
 */
class ObjectRegistry {
    constructor() {
        this.objectToId = new Map();  /* Object -> integer ID */
        this.idToObject = new Map();  /* ID -> Object (for deserialization) */
        this.nextId = 1;              /* ID 0 is reserved for null/nil */
    }

    /**
     * Register an object and return its ID.
     * @param {*} obj - The object to register
     * @returns {{id: number, isNew: boolean}} - The ID and whether this is first registration
     */
    register(obj) {
        if (obj === null || obj === undefined) {
            return { id: 0, isNew: false };
        }

        if (this.objectToId.has(obj)) {
            return { id: this.objectToId.get(obj), isNew: false };
        }

        const id = this.nextId++;
        this.objectToId.set(obj, id);
        return { id, isNew: true };
    }

    /**
     * Get the ID of a previously registered object.
     * @param {*} obj - The object to look up
     * @returns {number|undefined} - The ID or undefined if not registered
     */
    getId(obj) {
        if (obj === null || obj === undefined) {
            return 0;
        }
        return this.objectToId.get(obj);
    }

    /**
     * Get an object by its ID (used during deserialization).
     * @param {number} id - The object ID
     * @returns {*} - The object or undefined
     */
    getObject(id) {
        if (id === 0) {
            return null;
        }
        return this.idToObject.get(id);
    }

    /**
     * Associate an ID with an object (used during deserialization).
     * @param {number} id - The object ID
     * @param {*} obj - The object
     */
    setObject(id, obj) {
        if (id !== 0) {
            this.idToObject.set(id, obj);
        }
    }

    /**
     * Check if an object has been registered.
     * @param {*} obj - The object to check
     * @returns {boolean}
     */
    has(obj) {
        return obj === null || obj === undefined || this.objectToId.has(obj);
    }

    /**
     * Reset the registry.
     */
    clear() {
        this.objectToId.clear();
        this.idToObject.clear();
        this.nextId = 1;
    }
}

/**
 * NativeFunctionRegistry - Maps JavaScript functions to string identifiers
 * for serialization. Native functions must be pre-registered before they
 * can be serialized/deserialized.
 */
class NativeFunctionRegistry {
    constructor() {
        this.funcToName = new Map();  /* Function -> string name */
        this.nameToFunc = new Map();  /* string name -> Function */
    }

    /**
     * Register a native function with a unique name.
     * @param {string} name - Unique identifier for the function
     * @param {Function} func - The JavaScript function
     */
    register(name, func) {
        if (typeof func !== 'function') {
            throw new Error(`NativeFunctionRegistry: expected function, got ${typeof func}`);
        }
        if (this.nameToFunc.has(name)) {
            throw new Error(`NativeFunctionRegistry: '${name}' is already registered`);
        }
        this.funcToName.set(func, name);
        this.nameToFunc.set(name, func);
    }

    /**
     * Get the name of a registered function.
     * @param {Function} func - The function to look up
     * @returns {string|undefined} - The name or undefined if not registered
     */
    getName(func) {
        return this.funcToName.get(func);
    }

    /**
     * Get a function by its registered name.
     * @param {string} name - The function name
     * @returns {Function|undefined} - The function or undefined if not registered
     */
    getFunc(name) {
        return this.nameToFunc.get(name);
    }

    /**
     * Check if a function is registered.
     * @param {Function} func - The function to check
     * @returns {boolean}
     */
    hasFunc(func) {
        return this.funcToName.has(func);
    }

    /**
     * Check if a name is registered.
     * @param {string} name - The name to check
     * @returns {boolean}
     */
    hasName(name) {
        return this.nameToFunc.has(name);
    }

    /**
     * Get the number of registered functions.
     * @returns {number}
     */
    get size() {
        return this.funcToName.size;
    }

    /**
     * Clear all registrations.
     */
    clear() {
        this.funcToName.clear();
        this.nameToFunc.clear();
    }
}

/**
 * SerializationError - Error thrown during serialization/deserialization
 */
class SerializationError extends Error {
    constructor(message, details = null) {
        super(message);
        this.name = 'SerializationError';
        this.details = details;
    }
}

/**
 * Default options for serialization
 */
const DEFAULT_SAVE_OPTIONS = {
    /* How to handle unserializable values: 'error', 'warn', 'placeholder' */
    onUnserializable: 'error',

    /* Callback for warnings (receives message string) */
    onWarning: null,

    /* Strip debug info from function prototypes */
    stripDebug: false,

    /* Pre-registered native functions */
    nativeFuncRegistry: null,

    /* Custom serializers for userdata types */
    userdataSerializers: null,

    /* Custom serializer for lightuserdata */
    lightUserdataSerializer: null
};

/**
 * Default options for deserialization
 */
const DEFAULT_RESTORE_OPTIONS = {
    /* Pre-registered native functions (required to restore native functions) */
    nativeFuncRegistry: null,

    /* Custom deserializers for userdata types */
    userdataDeserializers: null,

    /* Custom deserializer for lightuserdata */
    lightUserdataDeserializer: null,

    /* Whether to validate the snapshot before restoring */
    validate: true
};

/**
 * SaveState - Context object for serialization
 */
class SaveState {
    constructor(L, options = {}) {
        this.L = L;
        this.options = Object.assign({}, DEFAULT_SAVE_OPTIONS, options);
        this.registry = new ObjectRegistry();
        this.nativeFuncs = this.options.nativeFuncRegistry || new NativeFunctionRegistry();
        this.buffer = [];
        this.warnings = [];
        this.unserializable = [];
    }

    warn(message) {
        this.warnings.push(message);
        if (this.options.onWarning) {
            this.options.onWarning(message);
        }
    }

    getResult() {
        return new Uint8Array(this.buffer);
    }
}

/**
 * RestoreState - Context object for deserialization
 */
class RestoreState {
    constructor(L, buffer, options = {}) {
        this.L = L;
        this.options = Object.assign({}, DEFAULT_RESTORE_OPTIONS, options);
        this.registry = new ObjectRegistry();
        this.nativeFuncs = this.options.nativeFuncRegistry || new NativeFunctionRegistry();
        this.buffer = buffer;
        this.offset = 0;
        this.fixups = [];  /* Deferred reference resolutions */
    }

    /**
     * Run all deferred fixups after object pool is loaded.
     */
    runFixups() {
        for (const fixup of this.fixups) {
            fixup();
        }
        this.fixups = [];
    }
}

/**
 * Map Lua type tags to serialization type tags
 */
const luaTypeToSerType = function(ttype) {
    switch (ttype) {
        case LUA_TNIL:      return SER_TNIL;
        case LUA_TBOOLEAN:  return SER_TBOOLEAN;
        case LUA_TNUMINT:   return SER_TNUMINT;
        case LUA_TNUMFLT:   return SER_TNUMFLT;
        case LUA_TSHRSTR:   return SER_TSHRSTR;
        case LUA_TLNGSTR:   return SER_TLNGSTR;
        case LUA_TTABLE:    return SER_TTABLE;
        case LUA_TLCL:      return SER_TLCLOSURE;
        case LUA_TCCL:      return SER_TCCLOSURE;
        case LUA_TLCF:      return SER_TLCF;
        case LUA_TUSERDATA: return SER_TUSERDATA;
        case LUA_TTHREAD:   return SER_TTHREAD;
        case LUA_TLIGHTUSERDATA: return SER_TLIGHTUSERDATA;
        default:
            throw new SerializationError(`Unknown Lua type tag: ${ttype}`);
    }
};

/**
 * Map serialization type tags back to Lua type tags
 */
const serTypeToLuaType = function(stype) {
    switch (stype) {
        case SER_TNIL:       return LUA_TNIL;
        case SER_TBOOLEAN:   return LUA_TBOOLEAN;
        case SER_TNUMINT:    return LUA_TNUMINT;
        case SER_TNUMFLT:    return LUA_TNUMFLT;
        case SER_TSHRSTR:    return LUA_TSHRSTR;
        case SER_TLNGSTR:    return LUA_TLNGSTR;
        case SER_TTABLE:     return LUA_TTABLE;
        case SER_TLCLOSURE:  return LUA_TLCL;
        case SER_TCCLOSURE:  return LUA_TCCL;
        case SER_TLCF:       return LUA_TLCF;
        case SER_TUSERDATA:  return LUA_TUSERDATA;
        case SER_TTHREAD:    return LUA_TTHREAD;
        case SER_TLIGHTUSERDATA: return LUA_TLIGHTUSERDATA;
        default:
            throw new SerializationError(`Unknown serialization type tag: ${stype}`);
    }
};

/* Exports */
module.exports.FENGARI_STATE_SIGNATURE = FENGARI_STATE_SIGNATURE;
module.exports.FORMAT_VERSION_MAJOR = FORMAT_VERSION_MAJOR;
module.exports.FORMAT_VERSION_MINOR = FORMAT_VERSION_MINOR;
module.exports.FENGARI_VERSION = FENGARI_VERSION;

module.exports.SER_TNIL = SER_TNIL;
module.exports.SER_TBOOLEAN = SER_TBOOLEAN;
module.exports.SER_TNUMINT = SER_TNUMINT;
module.exports.SER_TNUMFLT = SER_TNUMFLT;
module.exports.SER_TSHRSTR = SER_TSHRSTR;
module.exports.SER_TLNGSTR = SER_TLNGSTR;
module.exports.SER_TTABLE = SER_TTABLE;
module.exports.SER_TLCLOSURE = SER_TLCLOSURE;
module.exports.SER_TCCLOSURE = SER_TCCLOSURE;
module.exports.SER_TLCF = SER_TLCF;
module.exports.SER_TUSERDATA = SER_TUSERDATA;
module.exports.SER_TTHREAD = SER_TTHREAD;
module.exports.SER_TLIGHTUSERDATA = SER_TLIGHTUSERDATA;
module.exports.SER_TPROTO = SER_TPROTO;
module.exports.SER_TREF = SER_TREF;
module.exports.SER_TUDATA_NULL = SER_TUDATA_NULL;
module.exports.SER_TFUNC_NULL = SER_TFUNC_NULL;

module.exports.ObjectRegistry = ObjectRegistry;
module.exports.NativeFunctionRegistry = NativeFunctionRegistry;
module.exports.SerializationError = SerializationError;
module.exports.SaveState = SaveState;
module.exports.RestoreState = RestoreState;
module.exports.DEFAULT_SAVE_OPTIONS = DEFAULT_SAVE_OPTIONS;
module.exports.DEFAULT_RESTORE_OPTIONS = DEFAULT_RESTORE_OPTIONS;
module.exports.luaTypeToSerType = luaTypeToSerType;
module.exports.serTypeToLuaType = serTypeToLuaType;
