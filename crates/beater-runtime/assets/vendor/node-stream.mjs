// Minimal in-memory stream shim for server-side package compatibility.
// It is local to the isolate: no host file descriptors, sockets, process
// state, or unbounded background producers are created.

import EventEmitter from "node:events";
import { Buffer } from "node:buffer";

const DEFAULT_HIGH_WATER_MARK = 16;
const DEFAULT_HIGH_WATER_BYTES = 1024 * 1024;
const DEFAULT_MAX_PENDING_OPS = 64;

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback;
}

function normalizeCallback(callback) {
  return typeof callback === "function" ? callback : () => {};
}

function normalizeEncoding(encoding, callback) {
  return typeof encoding === "function" ? undefined : encoding;
}

function normalizeChunk(chunk, encoding) {
  if (chunk == null) return chunk;
  if (typeof chunk === "string") return chunk;
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof ArrayBuffer || ArrayBuffer.isView(chunk)) return Buffer.from(chunk);
  return chunk;
}

function chunkSize(chunk) {
  if (chunk == null) return 0;
  if (typeof chunk === "string") return Buffer.byteLength(chunk, "utf8");
  if (typeof chunk === "number" || typeof chunk === "boolean" || typeof chunk === "bigint") {
    return Buffer.byteLength(String(chunk), "utf8");
  }
  if (chunk instanceof ArrayBuffer || ArrayBuffer.isView(chunk)) return chunk.byteLength;
  try {
    return Buffer.byteLength(JSON.stringify(chunk) ?? String(chunk), "utf8");
  } catch {
    return Buffer.byteLength(String(chunk), "utf8");
  }
}

function nextMicrotask(callback) {
  Promise.resolve().then(callback);
}

function streamLimitError() {
  return new Error("stream buffer limit exceeded");
}

function pendingLimitError() {
  return new Error("stream pending operation limit exceeded");
}

function pendingUnderPressure(stream) {
  return stream._pendingOps >= stream._maxPendingOps || stream._pendingBytes >= stream._maxPendingBytes;
}

export class Stream extends EventEmitter {
  pipe(destination, options = undefined) {
    if (!destination || typeof destination.write !== "function") {
      throw new TypeError("stream.pipe destination must be writable");
    }
    const resumeSource = () => this.resume?.();
    this.on("data", (chunk) => {
      const ok = destination.write(chunk);
      if (ok === false && typeof this.pause === "function") {
        this.pause();
        destination.once?.("drain", resumeSource);
      }
    });
    this.once("end", () => {
      if (options?.end !== false && typeof destination.end === "function") destination.end();
    });
    this.once("error", (error) => destination.emit?.("error", error));
    this.resume?.();
    return destination;
  }
}

export class Readable extends Stream {
  constructor(options = undefined) {
    super();
    this.readable = true;
    this.destroyed = false;
    this._queue = [];
    this._waiters = [];
    this._bufferedBytes = 0;
    this._readEnded = false;
    this._endEmitted = false;
    this._flowing = false;
    this._error = null;
    this._highWaterMark = positiveInteger(options?.highWaterMark, DEFAULT_HIGH_WATER_MARK);
    this._highWaterBytes = positiveInteger(options?.highWaterBytes, DEFAULT_HIGH_WATER_BYTES);
    this._readImpl = typeof options?.read === "function" ? options.read : undefined;
    this._onReturn = undefined;
  }

  static from(iterable, options = undefined) {
    if (!iterable || (typeof iterable[Symbol.iterator] !== "function" && typeof iterable[Symbol.asyncIterator] !== "function")) {
      throw new TypeError("Readable.from requires an iterable");
    }
    const iterator =
      typeof iterable[Symbol.asyncIterator] === "function"
        ? iterable[Symbol.asyncIterator]()
        : iterable[Symbol.iterator]();
    let pulling = false;
    const readable = new Readable({
      ...options,
      read() {
        if (pulling || readable.destroyed || readable._readEnded) return;
        pulling = true;
        Promise.resolve(iterator.next())
          .then((entry) => {
            if (entry.done) readable.push(null);
            else readable.push(entry.value);
          })
          .catch((error) => readable.destroy(error))
          .finally(() => {
            pulling = false;
            if (!readable.destroyed && !readable._readEnded && (readable._flowing || readable._waiters.length > 0)) {
              readable._pull();
            }
          });
      },
    });
    readable._onReturn = () => iterator.return?.();
    return readable;
  }

  on(eventName, listener) {
    super.addListener(eventName, listener);
    if (eventName === "data") this.resume();
    return this;
  }

  addListener(eventName, listener) {
    return this.on(eventName, listener);
  }

  push(chunk, encoding = undefined) {
    if (this.destroyed || this._readEnded) return false;
    if (chunk === null) {
      this._readEnded = true;
      for (const waiter of this._waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
      this._maybeEmitEnd();
      return false;
    }
    const value = normalizeChunk(chunk, encoding);
    const size = chunkSize(value);
    if (size > this._highWaterBytes || this._bufferedBytes + size > this._highWaterBytes) {
      this.destroy(streamLimitError());
      return false;
    }
    const waiter = this._waiters.shift();
    if (waiter) {
      waiter.resolve({ value, done: false });
      return !this._underPressure();
    }
    if (this._flowing) {
      this.emit("data", value);
      return !this._underPressure();
    }
    if (this._queue.length >= this._highWaterMark) {
      this.destroy(streamLimitError());
      return false;
    }
    this._queue.push({ value, size });
    this._bufferedBytes += size;
    this.emit("readable");
    return !this._underPressure();
  }

  read() {
    if (this._error) throw this._error;
    if (this._queue.length > 0) {
      const value = this._shiftQueue();
      this._pull();
      return value;
    }
    this._pull();
    if (this._readEnded) this._maybeEmitEnd();
    return null;
  }

  pause() {
    this._flowing = false;
    return this;
  }

  resume() {
    if (this.destroyed) return this;
    this._flowing = true;
    while (this._flowing && this._queue.length > 0) this.emit("data", this._shiftQueue());
    this._pull();
    this._maybeEmitEnd();
    return this;
  }

  destroy(error = undefined) {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.readable = false;
    this._error = error ?? this._error;
    this._queue.length = 0;
    this._bufferedBytes = 0;
    const waiters = this._waiters.splice(0);
    if (this._error) {
      for (const waiter of waiters) waiter.reject(this._error);
      this.emit("error", this._error);
    } else {
      for (const waiter of waiters) waiter.resolve({ value: undefined, done: true });
    }
    const onReturn = this._onReturn;
    this._onReturn = undefined;
    try {
      const cleanup = onReturn?.();
      if (cleanup && typeof cleanup.then === "function") {
        cleanup.catch((returnError) => {
          if (!this._error && this.listenerCount("error") > 0) this.emit("error", returnError);
        });
      }
    } catch (returnError) {
      if (!this._error && this.listenerCount("error") > 0) this.emit("error", returnError);
    }
    this.emit("close");
    return this;
  }

  _shiftQueue() {
    const entry = this._queue.shift();
    this._bufferedBytes -= entry.size;
    if (!this._underPressure()) this.emit("drain");
    this._maybeEmitEnd();
    return entry.value;
  }

  _underPressure() {
    return this._queue.length >= this._highWaterMark || this._bufferedBytes >= this._highWaterBytes;
  }

  _pull() {
    if (!this._readImpl || this.destroyed || this._readEnded) return;
    try {
      this._readImpl.call(this, this._highWaterMark);
    } catch (error) {
      this.destroy(error);
    }
  }

  _maybeEmitEnd() {
    if (!this._endEmitted && this._readEnded && this._queue.length === 0) {
      this._endEmitted = true;
      nextMicrotask(() => this.emit("end"));
    }
  }

  [Symbol.asyncIterator]() {
    const stream = this;
    return {
      async next() {
        if (stream._error) return Promise.reject(stream._error);
        if (stream._queue.length > 0) {
          const value = stream._shiftQueue();
          stream._pull();
          return { value, done: false };
        }
        if (stream._readEnded || stream.destroyed) return { value: undefined, done: true };
        stream._pull();
        return await new Promise((resolve, reject) => stream._waiters.push({ resolve, reject }));
      },
      async return() {
        const onReturn = stream._onReturn;
        stream._onReturn = undefined;
        stream.destroy();
        if (onReturn) await onReturn();
        return { value: undefined, done: true };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }
}

export class Writable extends Stream {
  constructor(options = undefined) {
    super();
    this.writable = true;
    this.destroyed = false;
    this.writableEnded = false;
    this._ending = false;
    this._finishEmitted = false;
    this._pendingOps = 0;
    this._pendingBytes = 0;
    this._maxPendingOps = positiveInteger(options?.maxPendingOps, DEFAULT_MAX_PENDING_OPS);
    this._maxPendingBytes = positiveInteger(options?.maxPendingBytes, DEFAULT_HIGH_WATER_BYTES);
    this._writeImpl = typeof options?.write === "function" ? options.write : undefined;
  }

  write(chunk, encoding = undefined, callback = undefined) {
    const cb = normalizeCallback(typeof encoding === "function" ? encoding : callback);
    const enc = normalizeEncoding(encoding, callback);
    if (this.destroyed || this.writableEnded) {
      const error = new Error("write after end");
      cb(error);
      this.destroy(error);
      return false;
    }
    const value = normalizeChunk(chunk, enc);
    const size = chunkSize(value);
    if (!this._beginPending(size, cb)) return false;
    const done = this._pendingDone(size, cb);
    try {
      if (this._writeImpl) this._writeImpl.call(this, value, enc ?? "buffer", done);
      else done();
      return !pendingUnderPressure(this);
    } catch (error) {
      done(error);
      return false;
    }
  }

  end(chunk = undefined, encoding = undefined, callback = undefined) {
    const cb = normalizeCallback(
      typeof chunk === "function" ? chunk : typeof encoding === "function" ? encoding : callback
    );
    if (chunk !== undefined && typeof chunk !== "function") this.write(chunk, typeof encoding === "function" ? undefined : encoding);
    this._ending = true;
    this.writableEnded = true;
    this.writable = false;
    this.once("finish", cb);
    this._maybeFinish();
    return this;
  }

  destroy(error = undefined) {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.writable = false;
    if (error) this.emit("error", error);
    this.emit("close");
    return this;
  }

  _beginPending(size, cb) {
    if (this._pendingOps >= this._maxPendingOps) {
      const error = pendingLimitError();
      cb(error);
      this.destroy(error);
      return false;
    }
    if (size > this._maxPendingBytes || this._pendingBytes + size > this._maxPendingBytes) {
      const error = streamLimitError();
      cb(error);
      this.destroy(error);
      return false;
    }
    this._pendingOps += 1;
    this._pendingBytes += size;
    return true;
  }

  _pendingDone(size, cb) {
    let called = false;
    return (error = undefined) => {
      if (called) return;
      called = true;
      this._pendingOps = Math.max(0, this._pendingOps - 1);
      this._pendingBytes = Math.max(0, this._pendingBytes - size);
      if (error) {
        cb(error);
        this.destroy(error);
      } else {
        cb();
        if (!pendingUnderPressure(this)) this.emit("drain");
        this._maybeFinish();
      }
    };
  }

  _maybeFinish() {
    if (!this._finishEmitted && this._ending && this._pendingOps === 0 && !this.destroyed) {
      this._finishEmitted = true;
      nextMicrotask(() => this.emit("finish"));
    }
  }
}

export class Duplex extends Readable {
  constructor(options = undefined) {
    super(options);
    this.writable = true;
    this.writableEnded = false;
    this._ending = false;
    this._finishEmitted = false;
    this._pendingOps = 0;
    this._pendingBytes = 0;
    this._maxPendingOps = positiveInteger(options?.maxPendingOps, DEFAULT_MAX_PENDING_OPS);
    this._maxPendingBytes = positiveInteger(options?.maxPendingBytes, DEFAULT_HIGH_WATER_BYTES);
    this._writeImpl = typeof options?.write === "function" ? options.write : undefined;
  }

  write(chunk, encoding = undefined, callback = undefined) {
    const cb = normalizeCallback(typeof encoding === "function" ? encoding : callback);
    const enc = normalizeEncoding(encoding, callback);
    if (this.destroyed || this.writableEnded) {
      const error = new Error("write after end");
      cb(error);
      this.destroy(error);
      return false;
    }
    const value = normalizeChunk(chunk, enc);
    const size = chunkSize(value);
    if (!this._beginPending(size, cb)) return false;
    const done = this._pendingDone(size, cb);
    try {
      if (this._writeImpl) this._writeImpl.call(this, value, enc ?? "buffer", done);
      else {
        const ok = this.push(value, enc);
        done();
        return ok;
      }
      return !pendingUnderPressure(this);
    } catch (error) {
      done(error);
      return false;
    }
  }

  end(chunk = undefined, encoding = undefined, callback = undefined) {
    const cb = normalizeCallback(
      typeof chunk === "function" ? chunk : typeof encoding === "function" ? encoding : callback
    );
    if (chunk !== undefined && typeof chunk !== "function") this.write(chunk, typeof encoding === "function" ? undefined : encoding);
    this._ending = true;
    this.writableEnded = true;
    this.writable = false;
    this.once("finish", cb);
    this._maybeFinish();
    return this;
  }

  _beginPending(size, cb) {
    if (this._pendingOps >= this._maxPendingOps) {
      const error = pendingLimitError();
      cb(error);
      this.destroy(error);
      return false;
    }
    if (size > this._maxPendingBytes || this._pendingBytes + size > this._maxPendingBytes) {
      const error = streamLimitError();
      cb(error);
      this.destroy(error);
      return false;
    }
    this._pendingOps += 1;
    this._pendingBytes += size;
    return true;
  }

  _pendingDone(size, cb) {
    let called = false;
    return (error = undefined) => {
      if (called) return;
      called = true;
      this._pendingOps = Math.max(0, this._pendingOps - 1);
      this._pendingBytes = Math.max(0, this._pendingBytes - size);
      if (error) {
        cb(error);
        this.destroy(error);
      } else {
        cb();
        if (!pendingUnderPressure(this)) this.emit("drain");
        this._maybeFinish();
      }
    };
  }

  _maybeFinish() {
    if (!this._finishEmitted && this._ending && this._pendingOps === 0 && !this.destroyed) {
      this._finishEmitted = true;
      this.push(null);
      nextMicrotask(() => this.emit("finish"));
    }
  }
}

export class Transform extends Duplex {
  constructor(options = undefined) {
    super(options);
    this._transformImpl = typeof options?.transform === "function" ? options.transform : undefined;
  }

  write(chunk, encoding = undefined, callback = undefined) {
    const cb = normalizeCallback(typeof encoding === "function" ? encoding : callback);
    const enc = normalizeEncoding(encoding, callback);
    if (this.destroyed || this.writableEnded) {
      const error = new Error("write after end");
      cb(error);
      this.destroy(error);
      return false;
    }
    const value = normalizeChunk(chunk, enc);
    const size = chunkSize(value);
    if (!this._beginPending(size, cb)) return false;
    const done = this._pendingDone(size, cb);
    try {
      if (!this._transformImpl) {
        const ok = this.push(value, enc);
        done();
        return ok;
      }
      this._transformImpl.call(this, value, enc ?? "buffer", (error, data) => {
        if (error) {
          done(error);
          return;
        }
        if (data !== undefined && data !== null) this.push(data);
        done();
      });
      return !pendingUnderPressure(this);
    } catch (error) {
      done(error);
      return false;
    }
  }
}

export class PassThrough extends Transform {}

function streamComplete(stream) {
  const readableDone = typeof stream.read !== "function" || stream._endEmitted === true;
  const writableDone = typeof stream.write !== "function" || stream._finishEmitted === true;
  return readableDone && writableDone;
}

export function pipeline(...args) {
  const callback = typeof args[args.length - 1] === "function" ? args.pop() : () => {};
  if (args.length < 2) throw new TypeError("stream.pipeline requires at least two streams");
  let settled = false;
  const cleanup = () => {
    for (const stream of args) stream.removeListener?.("error", onError);
  };
  const done = (error = undefined) => {
    if (settled) return;
    settled = true;
    if (error) {
      for (const stream of args) {
        if (!stream.destroyed) stream.destroy?.();
      }
      cleanup();
      callback(error);
    } else {
      cleanup();
      callback();
    }
  };
  const onError = (error) => done(error);
  for (const stream of args) stream.once?.("error", onError);
  for (let index = 0; index < args.length - 1; index += 1) args[index].pipe(args[index + 1]);
  finished(args[args.length - 1], done);
  return args[args.length - 1];
}

export function finished(stream, options = undefined, callback = undefined) {
  const cb = normalizeCallback(typeof options === "function" ? options : callback);
  let called = false;
  const cleanup = () => {
    stream.removeListener?.("error", onError);
    stream.removeListener?.("end", onTerminal);
    stream.removeListener?.("finish", onTerminal);
    stream.removeListener?.("close", onClose);
  };
  const done = (error = undefined) => {
    if (called) return;
    called = true;
    cleanup();
    cb(error);
  };
  const onError = (error) => done(error);
  const onTerminal = () => {
    if (streamComplete(stream)) done();
  };
  const onClose = () => {
    if (streamComplete(stream)) done();
    else done(new Error("stream closed before finishing"));
  };
  stream.once?.("error", onError);
  stream.once?.("end", onTerminal);
  stream.once?.("finish", onTerminal);
  stream.once?.("close", onClose);
  if (stream.destroyed && !streamComplete(stream)) nextMicrotask(onClose);
  else if (streamComplete(stream)) nextMicrotask(onTerminal);
  return cleanup;
}

export function isReadable(stream) {
  return !!stream && stream.readable !== false && typeof stream.read === "function";
}

export function isWritable(stream) {
  return !!stream && stream.writable !== false && typeof stream.write === "function";
}

export function isErrored(stream) {
  return !!stream?.destroyed;
}

const stream = {
  Duplex,
  PassThrough,
  Readable,
  Stream,
  Transform,
  Writable,
  finished,
  isErrored,
  isReadable,
  isWritable,
  pipeline,
};

export default stream;
