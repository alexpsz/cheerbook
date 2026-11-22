export class SubmissionError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function reject(status, message) { throw new SubmissionError(status, message); }

// Apply the cap even if Content-Length is absent or inaccurate.
export async function boundedText(message, limit) {
  const length = message.headers.get('content-length');
  if (length && Number(length) > limit) reject(413, '内容太大，无法读取。');
  if (!message.body) reject(400, '缺少内容。');
  const reader = message.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let text = '', bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        reject(413, '内容太大，无法读取。');
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
