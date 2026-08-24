import { HttpRouter } from "effect/unstable/http";

const dashboardOrigins = new Set(["https://better-auth.com", "https://dash.better-auth.com"]);
const allowedMethods = "GET, POST, PATCH, DELETE, OPTIONS";
const allowedHeaders = [
  "Content-Type",
  "Authorization",
  "B3",
  "Traceparent",
  "X-Visitor-Id",
  "X-PoW-Solution",
  "X-Request-Id",
  "User-Agent",
].join(", ");
const exposedHeaders = "X-PoW-Challenge, X-PoW-Reason";
const corsHeaderNames = [
  "access-control-allow-credentials",
  "access-control-allow-headers",
  "access-control-allow-methods",
  "access-control-allow-origin",
  "access-control-expose-headers",
  "access-control-max-age",
];

/** Apply credentialed CORS only to the typed product API. */
export const productApiLayer = (trustedOrigins: ReadonlyArray<string>) =>
  HttpRouter.cors({
    allowedHeaders: ["Content-Type", "B3", "Traceparent"],
    allowedMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedOrigins: [...trustedOrigins],
    credentials: true,
    maxAge: 600,
  });

/** Apply Better Auth CORS policy to one authentication request. */
export const handleAuthRequest = (
  request: Request,
  handler: (request: Request) => Promise<Response>,
  trustedOrigins: ReadonlyArray<string>,
): Promise<Response> => {
  const origin = request.headers.get("origin");
  const allowedOrigin =
    origin !== null && (trustedOrigins.includes(origin) || dashboardOrigins.has(origin))
      ? origin
      : undefined;

  if (request.method === "OPTIONS") {
    return Promise.resolve(withCorsHeaders(new Response(null, { status: 204 }), allowedOrigin));
  }

  return handler(request).then((response) => withCorsHeaders(response, allowedOrigin));
};

const withCorsHeaders = (response: Response, allowedOrigin: string | undefined): Response => {
  const headers = new Headers(response.headers);
  for (const header of corsHeaderNames) {
    headers.delete(header);
  }

  if (allowedOrigin === undefined) {
    return new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  }

  headers.set("access-control-allow-credentials", "true");
  headers.set("access-control-allow-headers", allowedHeaders);
  headers.set("access-control-allow-methods", allowedMethods);
  headers.set("access-control-allow-origin", allowedOrigin);
  headers.set("access-control-expose-headers", exposedHeaders);
  headers.append("vary", "Origin");

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
};
