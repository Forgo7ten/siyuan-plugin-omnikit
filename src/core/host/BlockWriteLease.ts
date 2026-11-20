const blockTails = new Map<string, Promise<void>>();

function createAbortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function waitForTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }
  if (!signal) {
    return previous.catch(() => undefined);
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(createAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    previous.catch(() => undefined).then(() => {
      signal.removeEventListener("abort", onAbort);
      if (settled) return;
      settled = true;
      if (signal.aborted) {
        reject(createAbortError());
      } else {
        resolve();
      }
    });
  });
}

/**
 * Serializes block writes per `${notebook}/${blockID}` within this plugin process.
 * Supports abort while queued and at critical-section entry; callers must still
 * verify live block state via kernel read APIs because updateBlock has no CAS.
 */
export async function withBlockWriteLease<T>(
  notebook: string,
  blockID: string,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (signal?.aborted) {
    throw createAbortError();
  }
  const key = `${notebook}/${blockID}`;
  const previous = blockTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const hold = new Promise<void>(resolve => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => hold);
  blockTails.set(key, tail);
  void tail.finally(() => {
    if (blockTails.get(key) === tail) {
      blockTails.delete(key);
    }
  });

  try {
    await waitForTurn(previous, signal);
    if (signal?.aborted) {
      throw createAbortError();
    }
    return await operation();
  } finally {
    release();
  }
}
