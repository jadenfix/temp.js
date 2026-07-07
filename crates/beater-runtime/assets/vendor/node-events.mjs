// Minimal EventEmitter shim for server-side package compatibility.
// It is deterministic and local to the isolate: no timers, host resources,
// process state, or async iterator queues are created behind the caller's back.

export let defaultMaxListeners = 10;

function assertListener(listener) {
  if (typeof listener !== "function") {
    throw new TypeError("event listener must be a function");
  }
}

function assertMaxListeners(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError("max listeners must be a non-negative integer");
  }
}

function keyFor(eventName) {
  return typeof eventName === "symbol" ? eventName : String(eventName);
}

export class EventEmitter {
  constructor() {
    this._events = new Map();
    this._maxListeners = undefined;
  }

  static get defaultMaxListeners() {
    return defaultMaxListeners;
  }

  static set defaultMaxListeners(value) {
    assertMaxListeners(value);
    defaultMaxListeners = value;
  }

  addListener(eventName, listener) {
    return this._add(eventName, listener, false);
  }

  on(eventName, listener) {
    return this.addListener(eventName, listener);
  }

  prependListener(eventName, listener) {
    return this._add(eventName, listener, true);
  }

  once(eventName, listener) {
    assertListener(listener);
    const wrapped = (...args) => {
      this.removeListener(eventName, wrapped);
      listener.apply(this, args);
    };
    wrapped.listener = listener;
    return this._add(eventName, wrapped, false);
  }

  prependOnceListener(eventName, listener) {
    assertListener(listener);
    const wrapped = (...args) => {
      this.removeListener(eventName, wrapped);
      listener.apply(this, args);
    };
    wrapped.listener = listener;
    return this._add(eventName, wrapped, true);
  }

  emit(eventName, ...args) {
    const key = keyFor(eventName);
    const listeners = this._events.get(key);
    if (!listeners || listeners.length === 0) {
      if (key === "error") {
        const error = args[0];
        if (error instanceof Error) {
          throw error;
        }
        throw new Error(`Unhandled error event: ${String(error)}`);
      }
      return false;
    }
    for (const listener of [...listeners]) {
      listener.apply(this, args);
    }
    return true;
  }

  eventNames() {
    return [...this._events.keys()];
  }

  getMaxListeners() {
    return this._maxListeners ?? defaultMaxListeners;
  }

  setMaxListeners(value) {
    assertMaxListeners(value);
    this._maxListeners = value;
    return this;
  }

  listenerCount(eventName) {
    const listeners = this._events.get(keyFor(eventName));
    return listeners ? listeners.length : 0;
  }

  listeners(eventName) {
    return (this._events.get(keyFor(eventName)) ?? []).map(
      (listener) => listener.listener ?? listener
    );
  }

  rawListeners(eventName) {
    return [...(this._events.get(keyFor(eventName)) ?? [])];
  }

  off(eventName, listener) {
    return this.removeListener(eventName, listener);
  }

  removeListener(eventName, listener) {
    assertListener(listener);
    const key = keyFor(eventName);
    const listeners = this._events.get(key);
    if (!listeners) {
      return this;
    }
    let index = -1;
    for (let candidateIndex = listeners.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
      const candidate = listeners[candidateIndex];
      if (candidate === listener || candidate.listener === listener) {
        index = candidateIndex;
        break;
      }
    }
    if (index !== -1) {
      listeners.splice(index, 1);
    }
    if (listeners.length === 0) {
      this._events.delete(key);
    }
    return this;
  }

  removeAllListeners(eventName = undefined) {
    if (eventName === undefined) {
      this._events.clear();
    } else {
      this._events.delete(keyFor(eventName));
    }
    return this;
  }

  _add(eventName, listener, prepend) {
    assertListener(listener);
    const key = keyFor(eventName);
    const listeners = this._events.get(key) ?? [];
    if (prepend) {
      listeners.unshift(listener);
    } else {
      listeners.push(listener);
    }
    this._events.set(key, listeners);
    return this;
  }
}

export function addAbortListener() {
  throw new Error("events.addAbortListener is not supported by beater.js");
}

export function getEventListeners(emitter, eventName) {
  return emitter.listeners(eventName);
}

export function getMaxListeners(emitter) {
  return emitter.getMaxListeners();
}

export function listenerCount(emitter, eventName) {
  return emitter.listenerCount(eventName);
}

export function on() {
  throw new Error("events.on async iterator is not supported by beater.js");
}

export function once(emitter, eventName) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      emitter.removeListener(eventName, handleEvent);
      if (eventName !== "error") {
        emitter.removeListener("error", handleError);
      }
    };
    const handleEvent = (...args) => {
      cleanup();
      resolve(args);
    };
    const handleError = (error) => {
      cleanup();
      reject(error);
    };
    emitter.once(eventName, handleEvent);
    if (eventName !== "error") {
      emitter.once("error", handleError);
    }
  });
}

export function setMaxListeners(value, ...emitters) {
  assertMaxListeners(value);
  if (emitters.length === 0) {
    defaultMaxListeners = value;
    return;
  }
  for (const emitter of emitters) {
    emitter.setMaxListeners(value);
  }
}

Object.defineProperties(EventEmitter, {
  EventEmitter: { value: EventEmitter },
  addAbortListener: { value: addAbortListener },
  getEventListeners: { value: getEventListeners },
  getMaxListeners: { value: getMaxListeners },
  listenerCount: { value: listenerCount },
  on: { value: on },
  once: { value: once },
  setMaxListeners: { value: setMaxListeners },
});

export default EventEmitter;
