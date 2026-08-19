const dashboardOrigins = new Set(["https://better-auth.com", "https://dash.better-auth.com"]);
const allowedMethods = "GET, POST, PATCH, DELETE, OPTIONS";
const allowedHeaders = [
  "Content-Type",
  "Authorization",
  "X-Visitor-Id",
  "X-PoW-Solution",
  "X-Request-Id",
  "User-Agent",
].join(", ");
const exposedHeaders = "X-PoW-Challenge, X-PoW-Reason";

/** Apply credentialed CORS only to the typed product API. */
export const productApiLayer = (trustedOrigins: ReadonlyArray<string>) =>
  HttpRouter.cors({
    allowedHeaders: ["Content-Type"],
    allowedMethods: ["GET", "POST", "PUT", "OPTIONS"],
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
  if (allowedOrigin === undefined) return response;

  const headers = new Headers(response.headers);
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
import { HttpRouter } from "effect/unstable/http";
