// A WebSocket that records where it was opened and goes nowhere, for pages that mount a trace.
export class RecordingSocket {
  static opened: string[] = [];
  constructor(readonly url: string) {
    RecordingSocket.opened.push(url);
  }
  addEventListener() {}
  removeEventListener() {}
  send() {}
  close() {}
}
