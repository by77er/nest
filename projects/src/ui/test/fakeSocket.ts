// A stand-in for the browser's WebSocket in component tests: each one the page opens is recorded, and a
// test plays nest's side through it (open, messages, a drop).

type Listener = (e: { data?: unknown; code?: number }) => void;

export class FakeSocket {
  static readonly opened: FakeSocket[] = [];
  static reset(): void {
    FakeSocket.opened.length = 0;
  }
  /** The newest socket opened to a URL containing `part`. */
  static latest(part = ""): FakeSocket | undefined {
    return [...FakeSocket.opened].reverse().find((s) => s.url.includes(part));
  }

  readonly sent: string[] = [];
  readyState = 0;
  closedByPage: { code?: number } | null = null;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {
    FakeSocket.opened.push(this);
  }

  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.closedByPage = { code };
    this.readyState = 3;
  }

  private emit(type: string, e: { data?: unknown; code?: number } = {}): void {
    for (const f of this.listeners.get(type) ?? []) f(e);
  }
  /** nest accepted the upgrade. */
  open(): void {
    this.readyState = 1;
    this.emit("open");
  }
  /** One message from nest, as JSON (or a raw string). */
  message(m: unknown): void {
    this.emit("message", { data: typeof m === "string" ? m : JSON.stringify(m) });
  }
  /** The connection went away (nest closed it, or the network). */
  drop(code = 1006): void {
    this.readyState = 3;
    this.emit("close", { code });
  }
}
