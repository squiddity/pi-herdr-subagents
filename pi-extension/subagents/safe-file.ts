import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type Stats,
} from "node:fs";

export class UnsafeFileError extends Error {
  readonly code: "missing" | "symlink" | "not-regular" | "oversized" | "io";

  constructor(
    message: string,
    code: "missing" | "symlink" | "not-regular" | "oversized" | "io",
  ) {
    super(message);
    this.name = "UnsafeFileError";
    this.code = code;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function inspectPath(path: string, label: string): Stats {
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) throw new UnsafeFileError(`${label} must not be a symbolic link`, "symlink");
    if (!stats.isFile()) throw new UnsafeFileError(`${label} must be a regular file`, "not-regular");
    return stats;
  } catch (error) {
    if (error instanceof UnsafeFileError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new UnsafeFileError(`${label} does not exist`, "missing");
    }
    throw new UnsafeFileError(`cannot inspect ${label}: ${describeError(error)}`, "io");
  }
}

function openRegularFile(path: string, label: string): number {
  inspectPath(path, label);
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | noFollow);
    const stats = fstatSync(fd);
    if (!stats.isFile()) {
      throw new UnsafeFileError(`${label} must be a regular file`, "not-regular");
    }
    return fd;
  } catch (error) {
    if (fd != null) closeSync(fd);
    if (error instanceof UnsafeFileError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new UnsafeFileError(`${label} does not exist`, "missing");
    if (code === "ELOOP") throw new UnsafeFileError(`${label} must not be a symbolic link`, "symlink");
    throw new UnsafeFileError(`cannot open ${label}: ${describeError(error)}`, "io");
  }
}

/** Verify that a path currently resolves to a non-symlink regular file. */
export function assertRegularFile(path: string, label = "file"): void {
  const fd = openRegularFile(path, label);
  closeSync(fd);
}

/**
 * Read a non-symlink regular file without ever reading more than maxBytes + 1.
 * The fstat size check rejects known-large files before allocating or reading,
 * while the bounded loop also handles a concurrent grow after that check.
 */
export function readBoundedRegularFile(path: string, maxBytes: number, label = "file"): string {
  const fd = openRegularFile(path, label);
  try {
    const size = fstatSync(fd).size;
    if (size > maxBytes) {
      throw new UnsafeFileError(`${label} exceeds the ${maxBytes}-byte limit`, "oversized");
    }

    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const remaining = maxBytes + 1 - total;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      chunks.push(chunk.subarray(0, count));
      total += count;
    }
    if (total > maxBytes) {
      throw new UnsafeFileError(`${label} exceeds the ${maxBytes}-byte limit`, "oversized");
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Read at most maxBytes from the start of a safe regular file. */
export function readRegularFilePrefix(path: string, maxBytes: number, label = "file"): string {
  const fd = openRegularFile(path, label);
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    let total = 0;
    while (total < maxBytes) {
      const count = readSync(fd, buffer, total, maxBytes - total, null);
      if (count === 0) break;
      total += count;
    }
    return buffer.subarray(0, total).toString("utf8");
  } finally {
    closeSync(fd);
  }
}
