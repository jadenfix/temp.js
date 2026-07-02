// Phase C streaming-protocol fixture: route responses may provide ordered
// body_chunks, which the Rust server forwards as a streaming response body.

export function GET() {
  return {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
    body_chunks: ["alpha\n", "beta\n", "gamma\n"],
  };
}
