function failure(code) {
  return Object.assign(new Error(code), { code });
}

export class CdpConnection {
  constructor(socket) {
    this.socket = socket;
    this.pending = new Map();
    this.nextId = 0;
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(event.data); }
      catch { this.close(); return; }
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(failure('BROWSER_COMMAND_FAILED'));
      else request.resolve(message.result);
    });
    socket.addEventListener('close', () => this.failPending());
    socket.addEventListener('error', () => this.failPending());
  }

  static async connect(url, { timeoutMs = 10000, signal } = {}) {
    const endpoint = new URL(url);
    if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password) {
      throw failure('INVALID_DEBUG_ENDPOINT');
    }
    signal?.throwIfAborted();
    const socket = new WebSocket(url);
    const connection = new CdpConnection(socket);
    try {
      await new Promise((resolve, reject) => {
        const finish = error => {
          clearTimeout(timer);
          socket.removeEventListener('open', opened);
          socket.removeEventListener('error', failed);
          socket.removeEventListener('close', failed);
          signal?.removeEventListener('abort', aborted);
          if (error) reject(error); else resolve();
        };
        const opened = () => finish();
        const failed = () => finish(failure('BROWSER_CONNECTION_FAILED'));
        const aborted = () => finish(signal.reason);
        const timer = setTimeout(() => finish(failure('BROWSER_CONNECTION_TIMEOUT')), timeoutMs);
        socket.addEventListener('open', opened, { once: true });
        socket.addEventListener('error', failed, { once: true });
        socket.addEventListener('close', failed, { once: true });
        signal?.addEventListener('abort', aborted, { once: true });
      });
      return connection;
    } catch (error) { connection.close(); throw error; }
  }

  send(method, params = {}, { timeoutMs = 10000 } = {}) {
    if (this.socket.readyState !== 1) return Promise.reject(failure('BROWSER_CLOSED'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(failure('BROWSER_COMMAND_TIMEOUT'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(failure('BROWSER_CLOSED'));
      }
    });
  }

  failPending() {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(failure('BROWSER_CLOSED'));
    }
    this.pending.clear();
  }

  close() {
    this.failPending();
    this.socket.close();
  }
}
