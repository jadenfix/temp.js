// Promise helpers for the minimal in-memory node:stream shim.

import { finished as callbackFinished, pipeline as callbackPipeline } from "node:stream";

export function finished(stream, options = undefined) {
  return new Promise((resolve, reject) => {
    callbackFinished(stream, options, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

export function pipeline(...streams) {
  return new Promise((resolve, reject) => {
    callbackPipeline(...streams, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

export default {
  finished,
  pipeline,
};
