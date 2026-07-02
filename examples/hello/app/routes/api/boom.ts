// Deliberately broken route: proves dev errors show a readable,
// source-mapped stack pointing at this file.

// opt out of the crawl layer — agents shouldn't be sent here
export const agent = { crawl: false };

interface Payload {
  message: string;
}

function detonate(payload: Payload): never {
  throw new Error(`boom: ${payload.message}`);
}

export function GET() {
  return detonate({ message: "the stack should point at boom.ts" });
}
