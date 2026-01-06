"use strict";

const lua = require('../src/lua.js');
const lauxlib = require('../src/lauxlib.js');
const lualib = require('../src/lualib.js');
const { to_luastring } = require('../src/fengaricore.js');

const lserialize = require('../src/lserialize.js');
const lsave = require('../src/lsave.js');
const lrestore = require('../src/lrestore.js');

/* ============================================================
 * ObjectRegistry Tests
 * ============================================================ */

describe('ObjectRegistry', () => {
    test('assigns unique IDs', () => {
        const registry = new lserialize.ObjectRegistry();
        const obj1 = {};
        const obj2 = {};

        const result1 = registry.register(obj1);
        const result2 = registry.register(obj2);

        expect(result1.id).toBe(1);
        expect(result1.isNew).toBe(true);
        expect(result2.id).toBe(2);
        expect(result2.isNew).toBe(true);
    });

    test('returns same ID for same object', () => {
        const registry = new lserialize.ObjectRegistry();
        const obj = {};

        const result1 = registry.register(obj);
        const result2 = registry.register(obj);

        expect(result1.id).toBe(result2.id);
        expect(result1.isNew).toBe(true);
        expect(result2.isNew).toBe(false);
    });

    test('handles null/undefined as ID 0', () => {
        const registry = new lserialize.ObjectRegistry();

        expect(registry.register(null).id).toBe(0);
        expect(registry.register(undefined).id).toBe(0);
        expect(registry.getId(null)).toBe(0);
        expect(registry.getId(undefined)).toBe(0);
    });

    test('setObject and getObject work correctly', () => {
        const registry = new lserialize.ObjectRegistry();
        const obj = { name: 'test' };

        registry.setObject(5, obj);
        expect(registry.getObject(5)).toBe(obj);
        expect(registry.getObject(0)).toBe(null);
    });
});

/* ============================================================
 * NativeFunctionRegistry Tests
 * ============================================================ */

describe('NativeFunctionRegistry', () => {
    test('registers and retrieves functions', () => {
        const registry = new lserialize.NativeFunctionRegistry();
        const testFunc = function() { return 42; };

        registry.register('myFunc', testFunc);

        expect(registry.getName(testFunc)).toBe('myFunc');
        expect(registry.getFunc('myFunc')).toBe(testFunc);
    });

    test('throws on duplicate registration', () => {
        const registry = new lserialize.NativeFunctionRegistry();
        const func1 = function() {};
        const func2 = function() {};

        registry.register('myFunc', func1);
        expect(() => registry.register('myFunc', func2)).toThrow();
    });

    test('hasFunc and hasName work correctly', () => {
        const registry = new lserialize.NativeFunctionRegistry();
        const testFunc = function() {};

        registry.register('test', testFunc);

        expect(registry.hasFunc(testFunc)).toBe(true);
        expect(registry.hasName('test')).toBe(true);
        expect(registry.hasFunc(function() {})).toBe(false);
        expect(registry.hasName('unknown')).toBe(false);
    });
});

/* ============================================================
 * Basic Type Round-Trip Tests
 * ============================================================ */

describe('Basic Types Round-Trip', () => {
    let L;

    beforeEach(() => {
        L = lauxlib.luaL_newstate();
        lualib.luaL_openlibs(L);
    });

    test('round-trip nil', () => {
        lua.lua_pushnil(L);
        const tv = L.stack[L.top - 1];

        const saved = lsave.saveValue(L, tv);
        const restored = lrestore.restoreValue(L, saved);

        expect(restored.ttisnil()).toBe(true);
    });

    test('round-trip boolean true', () => {
        lua.lua_pushboolean(L, true);
        const tv = L.stack[L.top - 1];

        const saved = lsave.saveValue(L, tv);
        const restored = lrestore.restoreValue(L, saved);

        expect(restored.ttisboolean()).toBe(true);
        expect(restored.value).toBe(true);
    });

    test('round-trip boolean false', () => {
        lua.lua_pushboolean(L, false);
        const tv = L.stack[L.top - 1];

        const saved = lsave.saveValue(L, tv);
        const restored = lrestore.restoreValue(L, saved);

        expect(restored.ttisboolean()).toBe(true);
        expect(restored.value).toBe(false);
    });

    test('round-trip integer', () => {
        lua.lua_pushinteger(L, 12345);
        const tv = L.stack[L.top - 1];

        const saved = lsave.saveValue(L, tv);
        const restored = lrestore.restoreValue(L, saved);

        expect(restored.ttisinteger()).toBe(true);
        expect(restored.value).toBe(12345);
    });

    test('round-trip negative integer', () => {
        lua.lua_pushinteger(L, -9999);
        const tv = L.stack[L.top - 1];

        const saved = lsave.saveValue(L, tv);
        const restored = lrestore.restoreValue(L, saved);

        expect(restored.ttisinteger()).toBe(true);
        expect(restored.value).toBe(-9999);
    });

    test('round-trip float', () => {
        lua.lua_pushnumber(L, 3.14159);
        const tv = L.stack[L.top - 1];

        const saved = lsave.saveValue(L, tv);
        const restored = lrestore.restoreValue(L, saved);

        expect(restored.ttisfloat()).toBe(true);
        expect(restored.value).toBeCloseTo(3.14159);
    });

    test('round-trip string', () => {
        lua.lua_pushliteral(L, "Hello, World!");
        const tv = L.stack[L.top - 1];

        const saved = lsave.saveValue(L, tv);
        const restored = lrestore.restoreValue(L, saved);

        expect(restored.ttisstring()).toBe(true);
        expect(restored.jsstring()).toBe("Hello, World!");
    });

    test('round-trip empty string', () => {
        lua.lua_pushliteral(L, "");
        const tv = L.stack[L.top - 1];

        const saved = lsave.saveValue(L, tv);
        const restored = lrestore.restoreValue(L, saved);

        expect(restored.ttisstring()).toBe(true);
        expect(restored.jsstring()).toBe("");
    });
});

/* ============================================================
 * Table Round-Trip Tests
 * ============================================================ */

describe('Table Round-Trip', () => {
    let L;

    beforeEach(() => {
        L = lauxlib.luaL_newstate();
        lualib.luaL_openlibs(L);
    });

    test('round-trip empty table', () => {
        lua.lua_newtable(L);
        const tv = L.stack[L.top - 1];

        const saved = lsave.saveValue(L, tv);
        const restored = lrestore.restoreValue(L, saved);

        expect(restored.ttistable()).toBe(true);
    });

    test('round-trip table with integer keys', () => {
        lauxlib.luaL_dostring(L, to_luastring("return {10, 20, 30}"));
        const tv = L.stack[L.top - 1];

        const saved = lsave.saveValue(L, tv);
        const restored = lrestore.restoreValue(L, saved);

        expect(restored.ttistable()).toBe(true);

        /* Push restored table and verify contents */
        L.stack[L.top++] = restored;
        lua.lua_rawgeti(L, -1, 1);
        expect(lua.lua_tointeger(L, -1)).toBe(10);
        lua.lua_pop(L, 1);

        lua.lua_rawgeti(L, -1, 2);
        expect(lua.lua_tointeger(L, -1)).toBe(20);
        lua.lua_pop(L, 1);

        lua.lua_rawgeti(L, -1, 3);
        expect(lua.lua_tointeger(L, -1)).toBe(30);
    });

    test('round-trip table with string keys', () => {
        lauxlib.luaL_dostring(L, to_luastring("return {name = 'test', value = 42}"));
        const tv = L.stack[L.top - 1];

        const saved = lsave.saveValue(L, tv);
        const restored = lrestore.restoreValue(L, saved);

        expect(restored.ttistable()).toBe(true);

        L.stack[L.top++] = restored;
        lua.lua_getfield(L, -1, to_luastring("name"));
        expect(lua.lua_tojsstring(L, -1)).toBe("test");
        lua.lua_pop(L, 1);

        lua.lua_getfield(L, -1, to_luastring("value"));
        expect(lua.lua_tointeger(L, -1)).toBe(42);
    });

    test('round-trip nested tables', () => {
        lauxlib.luaL_dostring(L, to_luastring("return {inner = {x = 1, y = 2}}"));
        const tv = L.stack[L.top - 1];

        const saved = lsave.saveValue(L, tv);
        const restored = lrestore.restoreValue(L, saved);

        expect(restored.ttistable()).toBe(true);

        L.stack[L.top++] = restored;
        lua.lua_getfield(L, -1, to_luastring("inner"));
        expect(lua.lua_istable(L, -1)).toBe(true);

        lua.lua_getfield(L, -1, to_luastring("x"));
        expect(lua.lua_tointeger(L, -1)).toBe(1);
    });
});

/* ============================================================
 * Circular Reference Tests
 * ============================================================ */

describe('Circular References', () => {
    let L;

    beforeEach(() => {
        L = lauxlib.luaL_newstate();
        lualib.luaL_openlibs(L);
    });

    test('round-trip self-referencing table', () => {
        lauxlib.luaL_dostring(L, to_luastring(`
            local t = {}
            t.self = t
            return t
        `));
        const tv = L.stack[L.top - 1];

        const saved = lsave.saveValue(L, tv);
        const restored = lrestore.restoreValue(L, saved);

        expect(restored.ttistable()).toBe(true);

        /* Verify self-reference is preserved */
        L.stack[L.top++] = restored;
        lua.lua_getfield(L, -1, to_luastring("self"));
        expect(lua.lua_istable(L, -1)).toBe(true);

        /* The self reference should point to the same table */
        expect(lua.lua_rawequal(L, -1, -2)).toBeTruthy();
    });
});

/* ============================================================
 * Function Round-Trip Tests
 * ============================================================ */

describe('Function Round-Trip', () => {
    let L;

    beforeEach(() => {
        L = lauxlib.luaL_newstate();
        lualib.luaL_openlibs(L);
    });

    test('round-trip simple Lua function', () => {
        lauxlib.luaL_dostring(L, to_luastring("return function(x) return x + 1 end"));
        const tv = L.stack[L.top - 1];

        const saved = lsave.saveValue(L, tv);
        const restored = lrestore.restoreValue(L, saved);

        expect(restored.ttisLclosure()).toBe(true);

        /* Test the restored function works */
        L.stack[L.top++] = restored;
        lua.lua_pushinteger(L, 5);
        lua.lua_call(L, 1, 1);
        expect(lua.lua_tointeger(L, -1)).toBe(6);
    });

    test('round-trip closure with upvalue', () => {
        lauxlib.luaL_dostring(L, to_luastring(`
            local counter = 10
            return function()
                counter = counter + 1
                return counter
            end
        `));
        const tv = L.stack[L.top - 1];

        const saved = lsave.saveValue(L, tv);
        const restored = lrestore.restoreValue(L, saved);

        expect(restored.ttisLclosure()).toBe(true);

        /* Test the restored closure preserves upvalue state */
        L.stack[L.top++] = restored;
        lua.lua_call(L, 0, 1);
        expect(lua.lua_tointeger(L, -1)).toBe(11);
    });
});

/* ============================================================
 * Full VM Round-Trip Tests
 * ============================================================ */

describe('Full VM Round-Trip', () => {
    test('round-trip empty VM', () => {
        const L1 = lauxlib.luaL_newstate();

        const snapshot = lsave.saveVM(L1, { onUnserializable: 'warn' });
        expect(snapshot).toBeInstanceOf(Uint8Array);
        expect(snapshot.length).toBeGreaterThan(0);

        const L2 = lrestore.restoreVM(snapshot);
        expect(L2).not.toBeNull();
    });

    test('round-trip VM with globals', () => {
        const L1 = lauxlib.luaL_newstate();
        lualib.luaL_openlibs(L1);

        lauxlib.luaL_dostring(L1, to_luastring(`
            myGlobal = 42
            myString = "hello"
            myTable = {a = 1, b = 2}
        `));

        const snapshot = lsave.saveVM(L1, { onUnserializable: 'warn' });
        const L2 = lrestore.restoreVM(snapshot);

        /* Verify globals are restored */
        lua.lua_getglobal(L2, to_luastring("myGlobal"));
        expect(lua.lua_tointeger(L2, -1)).toBe(42);
        lua.lua_pop(L2, 1);

        lua.lua_getglobal(L2, to_luastring("myString"));
        expect(lua.lua_tojsstring(L2, -1)).toBe("hello");
        lua.lua_pop(L2, 1);

        lua.lua_getglobal(L2, to_luastring("myTable"));
        expect(lua.lua_istable(L2, -1)).toBe(true);
        lua.lua_getfield(L2, -1, to_luastring("a"));
        expect(lua.lua_tointeger(L2, -1)).toBe(1);
    });

    test('round-trip preserves function with captured state', () => {
        const L1 = lauxlib.luaL_newstate();
        lualib.luaL_openlibs(L1);

        lauxlib.luaL_dostring(L1, to_luastring(`
            local count = 0
            function increment()
                count = count + 1
                return count
            end
            increment()
            increment()
        `));

        const snapshot = lsave.saveVM(L1, { onUnserializable: 'warn' });
        const L2 = lrestore.restoreVM(snapshot);

        /* The counter should be at 2, next call should return 3 */
        lauxlib.luaL_dostring(L2, to_luastring("return increment()"));
        expect(lua.lua_tointeger(L2, -1)).toBe(3);
    });
});

/* ============================================================
 * Native Function Registry Tests
 * ============================================================ */

describe('Native Function Serialization', () => {
    test('CClosure with registered function round-trips', () => {
        const registry = new lserialize.NativeFunctionRegistry();

        /* Register a native function */
        const myNativeFunc = function(L) {
            lua.lua_pushinteger(L, 999);
            return 1;
        };
        registry.register('myNativeFunc', myNativeFunc);

        const L1 = lauxlib.luaL_newstate();
        lua.lua_pushcfunction(L1, myNativeFunc);
        lua.lua_setglobal(L1, to_luastring("native"));

        const snapshot = lsave.saveVM(L1, {
            nativeFuncRegistry: registry,
            onUnserializable: 'warn'
        });

        const L2 = lrestore.restoreVM(snapshot, {
            nativeFuncRegistry: registry
        });

        /* Call the native function */
        lua.lua_getglobal(L2, to_luastring("native"));
        lua.lua_call(L2, 0, 1);
        expect(lua.lua_tointeger(L2, -1)).toBe(999);
    });
});
