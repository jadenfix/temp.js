import { defineAction } from "beater:agent";

export const agent = {
  actions: [
    defineAction({
      name: "hello.contact",
      description: "Send a contact request to the hello support agent.",
      method: "POST",
      sideEffect: "write",
      confirm: true,
      dryRun: false,
      idempotencyRequired: true,
      auth: { type: "public" },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          email: { type: "string" },
          message: { type: "string" },
          confirm: { type: "boolean" },
        },
        required: ["email", "message", "confirm"],
      },
    }),
  ],
};

export function POST(request) {
  const input = parseInput(request);
  if (input.confirm !== true && input.confirm !== "true") {
    return json(400, { ok: false, error: "confirm is required" });
  }
  return json(200, {
    ok: true,
    action: "hello.contact",
    email: String(input.email ?? ""),
    message: String(input.message ?? ""),
    idempotency_key: request.headers["idempotency-key"] ?? input.idempotency_key ?? null,
  });
}

function parseInput(request) {
  const body = typeof request.body === "string" ? request.body : "";
  const contentType = request.headers["content-type"] ?? "";
  if (contentType.includes("application/json")) {
    return body ? JSON.parse(body) : {};
  }
  return Object.fromEntries(
    body
      .split("&")
      .filter(Boolean)
      .map((part) => {
        const [rawKey, rawValue = ""] = part.split("=");
        return [decodeForm(rawKey), decodeForm(rawValue)];
      }),
  );
}

function decodeForm(value) {
  return decodeURIComponent(String(value).replace(/\+/g, " "));
}

function json(status, body) {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
