// The simulator flushes promise chains with setImmediate (Node only). A MessageChannel
// post is the browser's closest macrotask: every pending microtask runs before it fires.
if (typeof globalThis.setImmediate === 'undefined') {
  const queue: (() => void)[] = [];
  const channel = new MessageChannel();
  channel.port1.onmessage = () => queue.shift()?.();
  (globalThis as any).setImmediate = (fn: () => void) => {
    queue.push(fn);
    channel.port2.postMessage(0);
  };
}
