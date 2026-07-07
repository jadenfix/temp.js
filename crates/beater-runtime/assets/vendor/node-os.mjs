// Minimal sanitized OS shim for server-side package compatibility.
// It returns deterministic Beater-local values and never reads the host
// username, hostname, home directory, network interfaces, CPU topology,
// memory size, load average, uptime, or environment.

export const EOL = "\n";
export const devNull = "/dev/null";
export const constants = Object.freeze({});

export function arch() {
  return "wasm32";
}

export function availableParallelism() {
  return 1;
}

export function cpus() {
  return [];
}

export function endianness() {
  return "LE";
}

export function freemem() {
  return 0;
}

export function getPriority() {
  return 0;
}

export function homedir() {
  return "/";
}

export function hostname() {
  return "localhost";
}

export function loadavg() {
  return [0, 0, 0];
}

export function machine() {
  return "wasm32";
}

export function networkInterfaces() {
  return {};
}

export function platform() {
  return "beater";
}

export function release() {
  return "0.0.0";
}

export function setPriority() {
  throw new Error("os.setPriority is not supported by beater.js");
}

export function tmpdir() {
  return "/tmp";
}

export function totalmem() {
  return 0;
}

export function type() {
  return "Beater";
}

export function uptime() {
  return 0;
}

export function userInfo() {
  return {
    uid: -1,
    gid: -1,
    username: "beater",
    homedir: "/",
    shell: null,
  };
}

export function version() {
  return "0.0.0";
}

const os = {
  EOL,
  constants,
  devNull,
  arch,
  availableParallelism,
  cpus,
  endianness,
  freemem,
  getPriority,
  homedir,
  hostname,
  loadavg,
  machine,
  networkInterfaces,
  platform,
  release,
  setPriority,
  tmpdir,
  totalmem,
  type,
  uptime,
  userInfo,
  version,
};

export default os;
